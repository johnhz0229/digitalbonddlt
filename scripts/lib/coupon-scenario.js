// Coupon servicing as "payment versus discharge" across two ledgers:
// the bond (asset chain) holds the claim; the cash moves on the payment chain;
// the claim is discharged only when the bond accepts the success preimage.
const { ethers } = require("ethers");
const { DecryptionOracle } = require("./erc7573");
const { oracleKeys, startLedger, deploy, toCents } = require("./crosschain-scenario");

const DAY = 24 * 60 * 60;
const FACE_VALUE_EUR = 1_000;
const ISSUER_CASH_EUR = 10_000;

const STEPS = [
  { id: "record", chain: "asset", title: "Record date: the bond fixes each holder's coupon claim" },
  { id: "open", chain: "asset", title: "Issuer's connector opens a settlement attempt for Alice" },
  { id: "commit", chain: "asset", title: "Oracle generates both keys; the bond freezes their hashes" },
  { id: "inceptPayment", chain: "payment", title: "Issuer registers the coupon payment with both encrypted keys" },
  { id: "confirmPayment", chain: "payment", title: "Alice's connector checks the keys match the bond's commitment" },
  { id: "execute", chain: "payment", title: "Payment is executed (or fails)" },
  { id: "oracle", chain: "off-chain", title: "Oracle releases exactly one key" },
  { id: "forward", chain: "asset", title: "Alice's connector forwards the key to the bond" },
];

const ATTEMPT_STATUS = ["NONE", "AWAITING KEYS", "COMMITTED", "SUCCEEDED", "FAILED"];
const PAYMENT_STATUS = ["NONE", "INCEPTED", "CONFIRMED", "PAID", "FAILED", "CANCELLED"];
const eurText = (cents) => Number(ethers.formatUnits(cents, 2)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class CouponScenario {
  static async create() {
    const scenario = new CouponScenario();
    await scenario.reset();
    return scenario;
  }

  async reset() {
    await this.close();
    this.log = [];
    this.step = 0;
    this.attemptId = null;
    this.keys = null;
    this.released = null;
    this.forwardCount = 0;
    this.history = [];

    // Asset chain: issuer, Alice, Bob, oracle. Payment chain: cash bank, Alice, Bob, oracle, issuer.
    this.asset = await startLedger(7001, 4);
    this.payment = await startLedger(7002, 5);
    const [issuerA, aliceA, bobA, oracleA] = this.asset.signers;
    const [bank, aliceP, , oracleP, issuerP] = this.payment.signers;
    this.issuer = { asset: issuerA, payment: issuerP };
    this.alice = { asset: aliceA, payment: aliceP, address: await aliceA.getAddress() };
    this.bobAddress = await bobA.getAddress();
    this.oracleSigner = { asset: oracleA, payment: oracleP };
    const oracleAddress = await oracleA.getAddress();
    if (oracleAddress !== await oracleP.getAddress()) throw new Error("Oracle must have the same address on both ledgers.");

    const now = (await this.asset.provider.getBlock("latest")).timestamp;
    this.bond = await deploy("TokenizedBond", issuerA, "Demo Digital Bond 2027", "DDB27", ethers.parseEther("1"), 500, 90 * DAY, now + 366 * DAY);
    for (const address of [this.alice.address, this.bobAddress]) await (await this.bond.setWhitelisted(address, true)).wait();
    await (await this.bond.issue(this.alice.address, 6)).wait();
    await (await this.bond.issue(this.bobAddress, 4)).wait();
    this.coupon = await deploy("CouponDischarge", issuerA, await this.bond.getAddress(), toCents(FACE_VALUE_EUR), oracleAddress);

    this.cash = await deploy("TokenisedEuro", bank);
    this.paymentContract = await deploy("PaymentDecryptionContract", bank, await this.cash.getAddress(), oracleAddress);
    await (await this.cash.mint(await issuerP.getAddress(), toCents(ISSUER_CASH_EUR))).wait();

    this.oracle = new DecryptionOracle({ privateKey: oracleKeys().privateKey, publicKey: oracleKeys().publicKey, contracts: [await this.coupon.getAddress()] });
    this.note("system", `Bond: EUR ${FACE_VALUE_EUR.toLocaleString("en-GB")} face value per unit, 5% p.a., quarterly. Alice holds 6 units, Bob 4. The issuer holds EUR ${ISSUER_CASH_EUR.toLocaleString("en-GB")} on the payment chain.`);
  }

  async close() {
    for (const ledger of [this.asset, this.payment]) {
      if (ledger && ledger.raw) await ledger.raw.disconnect();
    }
    this.asset = null;
    this.payment = null;
  }

  note(kind, message, chain = null, txHash = null) {
    this.log.push({ kind, chain, message, txHash, at: new Date().toISOString() });
  }

  async run(stepId, option) {
    if (stepId === "retry") return this.retry();
    if (stepId === "reforward") return this.reforward();
    const expected = STEPS[this.step];
    if (!expected) throw new Error("This attempt is complete. Retry or reset.");
    if (stepId !== expected.id) throw new Error(`Next step is: ${expected.title}.`);
    await this[`step_${stepId}`](option);
    this.step += 1;
  }

  async step_record() {
    const date = Number(await this.coupon.couponDate(1));
    const latest = (await this.asset.provider.getBlock("latest")).timestamp;
    if (latest < date) {
      await this.asset.provider.send("evm_increaseTime", [date - latest]);
      await this.asset.provider.send("evm_mine", []);
    }
    const tx = await this.coupon.recordCoupon(1);
    await tx.wait();
    const amount = await this.coupon.entitlement(1, this.alice.address);
    this.note("asset", `recordCoupon(1): coupon date reached. Alice is owed EUR ${eurText(amount)} (6 × EUR ${eurText(await this.coupon.couponPerUnit())}); Bob's claim is fixed the same way.`, "asset", tx.hash);
  }

  async step_open() {
    const tx = await this.coupon.connect(this.issuer.asset).openAttempt(1, this.alice.address);
    await tx.wait();
    this.attemptId = Number(await this.coupon.attemptCount());
    this.amount = (await this.coupon.attempts(this.attemptId)).amount;
    this.note("asset", `openAttempt: settlement attempt #${this.attemptId} for Alice's claim of EUR ${eurText(this.amount)}.`, "asset", tx.hash);
  }

  async step_commit() {
    this.keys = this.oracle.generateOutcomeKeys({ contract: await this.coupon.getAddress(), id: this.attemptId });
    const { success, failure } = this.keys;
    const tx = await this.coupon.connect(this.oracleSigner.asset).commitOutcomeKeys(this.attemptId, success.hash, success.encrypted, failure.hash, failure.encrypted);
    await tx.wait();
    this.note("oracle", "commitOutcomeKeys: the oracle generated a success and a failure key, published their hashes and encryptions, and discarded the plaintexts. Nobody can discharge the claim yet.", "asset", tx.hash);
  }

  async step_inceptPayment() {
    const { success, failure } = this.keys;
    const tx = await this.paymentContract.connect(this.issuer.payment).inceptTransfer(this.attemptId, this.amount, this.alice.address, success.encrypted, failure.encrypted);
    await tx.wait();
    this.note("payment", `inceptTransfer: the issuer registers EUR ${eurText(this.amount)} to Alice, carrying both encrypted keys from the bond.`, "payment", tx.hash);
  }

  async step_confirmPayment() {
    const { success, failure } = this.keys;
    const tx = await this.paymentContract.connect(this.alice.payment).confirmTransfer(this.attemptId, this.amount, await this.issuer.payment.getAddress(), success.encrypted, failure.encrypted);
    await tx.wait();
    this.note("payment", "confirmTransfer: Alice's own connector compared the encrypted keys with the bond's commitment and confirmed.", "payment", tx.hash);
  }

  async step_execute(option = "pay") {
    if (option !== "fail") {
      await (await this.cash.connect(this.issuer.payment).approve(await this.paymentContract.getAddress(), this.amount)).wait();
    }
    const tx = await this.paymentContract.connect(this.issuer.payment).transferAndDecrypt(this.attemptId);
    this.pendingReceipt = await tx.wait();
    const status = Number((await this.paymentContract.payments(this.attemptId)).status);
    if (status === 3) {
      this.note("payment", `transferAndDecrypt: EUR ${eurText(this.amount)} moved to Alice. On the bond, her claim is STILL OUTSTANDING: a payment status is not a discharge.`, "payment", tx.hash);
    } else {
      this.note("failure", "transferAndDecrypt: the issuer had not authorised the cash, so the payment failed. The failure key is requested.", "payment", tx.hash);
    }
  }

  async step_oracle() {
    const [released] = await this.oracle.handleReceipt(this.paymentContract.connect(this.oracleSigner.payment), this.pendingReceipt);
    this.released = released;
    this.note("oracle", `releaseKey: the oracle decrypted the ${released.success ? "success" : "failure"} key and published it on the payment chain.`, "payment", released.txHash);
  }

  async step_forward() {
    const tx = await this.coupon.connect(this.alice.asset).submitOutcome(this.attemptId, this.released.key);
    await tx.wait();
    this.forwardCount = 1;
    this.history.push({ attemptId: this.attemptId, outcome: this.released.success ? "SUCCEEDED" : "FAILED" });
    if (this.released.success) {
      this.note("settlement", `submitOutcome: the bond accepted the success preimage. Alice's coupon for period 1 is DISCHARGED.`, "asset", tx.hash);
    } else {
      this.note("failure", `submitOutcome: the bond accepted the failure preimage. Attempt #${this.attemptId} is closed, but Alice's claim REMAINS OUTSTANDING. A new attempt is needed.`, "asset", tx.hash);
    }
  }

  async reforward() {
    if (!this.released || this.step < STEPS.length) throw new Error("There is no forwarded key to send again yet.");
    const tx = await this.coupon.connect(this.alice.asset).submitOutcome(this.attemptId, this.released.key);
    await tx.wait();
    this.forwardCount += 1;
    this.note("asset", "submitOutcome (again): the connector re-sent the same key, e.g. after a timeout. Nothing changed: forwarding is safe to repeat.", "asset", tx.hash);
  }

  async retry() {
    if (this.step < STEPS.length || this.released.success) throw new Error("A retry is only possible after a failed attempt.");
    this.step = 1; // the record date stays; open a fresh attempt with fresh keys
    this.keys = null;
    this.released = null;
    this.forwardCount = 0;
    this.note("system", "Retry: a new settlement attempt will be opened for the same, still outstanding claim.");
  }

  async state() {
    const attempt = this.attemptId ? await this.coupon.attempts(this.attemptId) : null;
    const paymentRecord = this.attemptId ? await this.paymentContract.payments(this.attemptId) : null;
    const recorded = await this.coupon.recorded(1);
    const claim = recorded ? await this.coupon.entitlement(1, this.alice.address) : 0n;
    const outstanding = recorded ? await this.coupon.isOutstanding(1, this.alice.address) : null;
    const complete = this.step >= STEPS.length;
    return {
      steps: STEPS.map((step, index) => ({ ...step, done: index < this.step, next: index === this.step })),
      complete,
      canRetry: complete && this.released && !this.released.success,
      canReforward: complete && Boolean(this.released),
      bond: {
        recorded,
        claimEur: eurText(claim),
        claimStatus: !recorded ? "NOT YET RECORDED" : outstanding ? "OUTSTANDING" : "DISCHARGED",
        attemptId: this.attemptId,
        attemptStatus: attempt ? ATTEMPT_STATUS[Number(attempt.status)] : "—",
        hashSuccess: attempt && attempt.hashSuccess !== ethers.ZeroHash ? attempt.hashSuccess : null,
        hashFailure: attempt && attempt.hashFailure !== ethers.ZeroHash ? attempt.hashFailure : null,
        history: this.history,
      },
      payment: {
        status: paymentRecord ? PAYMENT_STATUS[Number(paymentRecord.status)] : "—",
        aliceEur: eurText(await this.cash.balanceOf(this.alice.address)),
        issuerEur: eurText(await this.cash.balanceOf(await this.issuer.payment.getAddress())),
      },
      released: this.released && {
        success: this.released.success,
        key: Buffer.from(ethers.getBytes(this.released.key)).toString("utf8"),
        forwardCount: this.forwardCount,
      },
      log: [...this.log].reverse(),
    };
  }
}

module.exports = { CouponScenario, STEPS };
