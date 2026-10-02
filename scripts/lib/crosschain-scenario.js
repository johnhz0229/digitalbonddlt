// Two separate in-memory ledgers (asset chain and payment chain) and the
// step-by-step ERC-7573-style protocol between them. Used by the terminal demo
// and by the dashboard server.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { createOracleKeyPair, prepareKey, DecryptionOracle } = require("./erc7573");

const artifact = (name) => require(path.join(__dirname, "..", "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`));
const DAY = 24 * 60 * 60;
const BUYER_CASH_EUR = 5_000;
const DEMO_MNEMONIC = "test test test test test test test test test test test junk";
const SELLER_BONDS = 20;

// Stays the same for the whole process: the oracle's long-lived key pair.
let oracleKeyPair = null;
function oracleKeys() {
  if (!oracleKeyPair) oracleKeyPair = createOracleKeyPair();
  return oracleKeyPair;
}

const toCents = (eur) => BigInt(Math.round(Number(eur) * 100));
const short = (hex, size = 10) => (hex.length > size * 2 ? `${hex.slice(0, size + 2)}…${hex.slice(-size)}` : hex);

async function startLedger(chainId, accounts) {
  const raw = ganache.provider({
    logging: { quiet: true },
    // Same mnemonic on both ledgers: one private key, the same address on each chain.
    wallet: { totalAccounts: accounts, defaultBalance: 10_000, mnemonic: DEMO_MNEMONIC },
    chain: { chainId, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000 },
  });
  // cacheTimeout -1: never reuse a cached (e.g. failed) gas estimate after state changes.
  const provider = new ethers.BrowserProvider(raw, undefined, { cacheTimeout: -1 });
  const signers = await Promise.all([...Array(accounts).keys()].map((i) => provider.getSigner(i)));
  return { raw, provider, signers };
}

async function deploy(name, signer, ...args) {
  const { abi, bytecode } = artifact(name);
  const contract = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

const STEPS = [
  { id: "keys", chain: "off-chain", title: "Both parties generate the counterparty's key" },
  { id: "incept", chain: "asset", title: "Alice (seller) incepts the transfer on the asset chain" },
  { id: "lock", chain: "asset", title: "Bob (buyer) confirms; Alice's bonds are locked" },
  { id: "inceptPayment", chain: "payment", title: "Bob (buyer) incepts the payment on the payment chain" },
  { id: "confirmPayment", chain: "payment", title: "Alice (seller) confirms both encrypted keys" },
  { id: "execute", chain: "payment", title: "Payment is executed, or the trade is cancelled" },
  { id: "oracle", chain: "off-chain", title: "Decryption oracle releases exactly one key" },
  { id: "settle", chain: "asset", title: "The released key moves the bonds on the asset chain" },
];

class CrossChainScenario {
  static async create() {
    const scenario = new CrossChainScenario();
    await scenario.reset();
    return scenario;
  }

  async reset({ units = 10, priceEur = 1_000 } = {}) {
    const unitsInt = Number(units);
    const price = Number(priceEur);
    if (!Number.isInteger(unitsInt) || unitsInt < 1 || unitsInt > SELLER_BONDS) throw new Error(`Units must be between 1 and ${SELLER_BONDS}.`);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw new Error("Price must be between EUR 0.01 and EUR 1,000,000.");
    await this.close();

    this.terms = { id: 1, units: unitsInt, priceEur: price, amount: toCents(price) };
    this.log = [];
    this.step = 0;
    this.outcome = null;
    this.released = null;
    this.keys = null;

    // Asset chain: issuer, Alice, Bob. Payment chain: cash bank, Alice, Bob, oracle.
    this.asset = await startLedger(7001, 3);
    this.payment = await startLedger(7002, 4);
    const [issuer, aliceA, bobA] = this.asset.signers;
    const [bank, aliceP, bobP, oracleSigner] = this.payment.signers;
    this.alice = { asset: aliceA, payment: aliceP, address: await aliceA.getAddress() };
    this.bob = { asset: bobA, payment: bobP, address: await bobA.getAddress() };

    const now = (await this.asset.provider.getBlock("latest")).timestamp;
    this.bond = await deploy("TokenizedBond", issuer, "Demo Digital Bond 2027", "DDB27", ethers.parseEther("1"), 500, 90 * DAY, now + 366 * DAY);
    this.locking = await deploy("AssetLockingContract", issuer, await this.bond.getAddress());
    for (const address of [this.alice.address, this.bob.address, await this.locking.getAddress()]) {
      await (await this.bond.setWhitelisted(address, true)).wait();
    }
    await (await this.bond.issue(this.alice.address, SELLER_BONDS)).wait();

    this.cash = await deploy("TokenisedEuro", bank);
    this.paymentContract = await deploy("PaymentDecryptionContract", bank, await this.cash.getAddress(), await oracleSigner.getAddress());
    await (await this.cash.mint(await bobP.getAddress(), toCents(BUYER_CASH_EUR))).wait();

    this.oracleSigner = oracleSigner;
    this.oracle = new DecryptionOracle({ privateKey: oracleKeys().privateKey, lockingContract: await this.locking.getAddress() });
    this.note("system", `Two separate ledgers started: asset chain (id 7001) holds the bond, payment chain (id 7002) holds tokenised euro. Alice owns ${SELLER_BONDS} bonds; Bob owns EUR ${BUYER_CASH_EUR.toLocaleString("en-GB")}.`);
    this.note("system", `Trade: Alice sells ${unitsInt} bonds to Bob for EUR ${price.toLocaleString("en-GB")}.`);
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

  get nextStep() {
    return STEPS[this.step] || null;
  }

  async run(stepId, option) {
    const expected = this.nextStep;
    if (!expected) throw new Error("The protocol is complete. Reset to run it again.");
    if (stepId !== expected.id) throw new Error(`Next step is: ${expected.title}.`);
    await this[`step_${stepId}`](option);
    this.step += 1;
  }

  async step_keys() {
    const params = { oraclePublicKey: oracleKeys().publicKey, lockingContract: await this.locking.getAddress(), id: this.terms.id };
    // Alice generates the key that will let BOB claim; Bob generates the key that lets ALICE reclaim.
    const buyerKey = prepareKey({ ...params, releaseTo: "buyer" });
    const sellerKey = prepareKey({ ...params, releaseTo: "seller" });
    this.keys = { buyerKey, sellerKey };
    this.note("keys", `Alice generated Bob's claim key and shares only its hash ${short(buyerKey.hash)} and its encryption for the oracle.`);
    this.note("keys", `Bob generated Alice's reclaim key and shares only its hash ${short(sellerKey.hash)} and its encryption for the oracle.`);
  }

  async step_incept() {
    const { sellerKey } = this.keys;
    const tx = await this.locking.connect(this.alice.asset).inceptTransfer(this.terms.id, this.terms.units, this.bob.address, sellerKey.hash, sellerKey.encrypted);
    await tx.wait();
    this.note("asset", `inceptTransfer: Alice offers ${this.terms.units} bonds to Bob and registers the hash of her reclaim key.`, "asset", tx.hash);
  }

  async step_lock() {
    const { buyerKey } = this.keys;
    await (await this.bond.connect(this.alice.asset).approve(await this.locking.getAddress(), this.terms.units)).wait();
    const tx = await this.locking.connect(this.bob.asset).confirmTransfer(this.terms.id, this.terms.units, this.alice.address, buyerKey.hash, buyerKey.encrypted);
    await tx.wait();
    this.note("asset", `confirmTransfer: Bob confirms the same terms and registers the hash of his claim key. ${this.terms.units} bonds are now locked in the contract.`, "asset", tx.hash);
  }

  async step_inceptPayment() {
    const { buyerKey, sellerKey } = this.keys;
    const tx = await this.paymentContract.connect(this.bob.payment).inceptTransfer(this.terms.id, this.terms.amount, this.alice.address, buyerKey.encrypted, sellerKey.encrypted);
    await tx.wait();
    this.note("payment", `inceptTransfer: Bob registers EUR ${this.terms.priceEur.toLocaleString("en-GB")} to Alice with two encrypted keys: success = Bob's claim key, failure = Alice's reclaim key.`, "payment", tx.hash);
  }

  async step_confirmPayment() {
    const { buyerKey, sellerKey } = this.keys;
    const tx = await this.paymentContract.connect(this.alice.payment).confirmTransfer(this.terms.id, this.terms.amount, this.bob.address, buyerKey.encrypted, sellerKey.encrypted);
    await tx.wait();
    this.note("payment", "confirmTransfer: Alice checks that the failure key is exactly her reclaim key, so a failed payment will return her bonds.", "payment", tx.hash);
  }

  async step_execute(option = "pay") {
    let tx;
    if (option === "cancel") {
      tx = await this.paymentContract.connect(this.alice.payment).cancelAndDecrypt(this.terms.id);
      this.note("payment", "cancelAndDecrypt: Alice cancels the unpaid trade. The failure key is requested. No time-lock was needed.", "payment", tx.hash);
    } else {
      await (await this.cash.connect(this.bob.payment).approve(await this.paymentContract.getAddress(), this.terms.amount)).wait();
      tx = await this.paymentContract.connect(this.bob.payment).transferAndDecrypt(this.terms.id);
    }
    this.pendingReceipt = await tx.wait();
    const payment = await this.paymentContract.payments(this.terms.id);
    this.outcome = Number(payment.status) === 3 ? "paid" : option === "cancel" ? "cancelled" : "failed";
    if (this.outcome === "paid") {
      this.note("payment", `transferAndDecrypt: EUR ${this.terms.priceEur.toLocaleString("en-GB")} moved from Bob to Alice. The success key is requested.`, "payment", tx.hash);
    } else if (this.outcome === "failed") {
      this.note("failure", "transferAndDecrypt: Bob does not have enough cash. The payment failure is recorded and the failure key is requested.", "payment", tx.hash);
    }
  }

  async step_oracle() {
    const [released] = await this.oracle.handleReceipt(this.paymentContract.connect(this.oracleSigner), this.pendingReceipt);
    this.released = released;
    const document = JSON.parse(Buffer.from(ethers.getBytes(released.key)).toString("utf8"));
    this.note("oracle", `Oracle decrypted the ${released.success ? "success" : "failure"} key (releases to ${document.releaseTo}) and published it with releaseKey. It stored nothing about the trade.`, "payment", released.txHash);
  }

  async step_settle() {
    const relayer = this.released.success ? this.bob.asset : this.alice.asset;
    const tx = await this.locking.connect(relayer).transferWithKey(this.terms.id, this.released.key);
    await tx.wait();
    if (this.released.success) {
      this.note("settlement", `transferWithKey: Bob submits the released key on the asset chain and receives ${this.terms.units} bonds. DvP complete across two ledgers.`, "asset", tx.hash);
    } else {
      this.note("settlement", `transferWithKey: Alice submits the released key and gets her ${this.terms.units} bonds back. Nobody lost anything.`, "asset", tx.hash);
    }
  }

  async state() {
    const bondsOf = async (address) => Number(await this.bond.balanceOf(address));
    const eurOf = async (address) => ethers.formatUnits(await this.cash.balanceOf(address), 2);
    const lockingAddress = await this.locking.getAddress();
    const keyView = (key, generatedBy) => key && ({
      generatedBy,
      hash: key.hash,
      encrypted: ethers.hexlify(key.encrypted),
      plaintext: key.plaintext.toString("utf8"),
    });
    return {
      terms: { id: this.terms.id, units: this.terms.units, priceEur: this.terms.priceEur },
      steps: STEPS.map((step, index) => ({ ...step, done: index < this.step, next: index === this.step })),
      outcome: this.outcome,
      complete: this.step >= STEPS.length,
      asset: {
        chainId: 7001,
        lockingContract: lockingAddress,
        bonds: { alice: await bondsOf(this.alice.address), bob: await bondsOf(this.bob.address), locked: await bondsOf(lockingAddress) },
      },
      payment: {
        chainId: 7002,
        contract: await this.paymentContract.getAddress(),
        eur: { alice: await eurOf(this.alice.address), bob: await eurOf(this.bob.address) },
      },
      keys: this.keys && {
        buyer: keyView(this.keys.buyerKey, "Alice"),
        seller: keyView(this.keys.sellerKey, "Bob"),
      },
      released: this.released && { success: this.released.success, key: Buffer.from(ethers.getBytes(this.released.key)).toString("utf8") },
      log: [...this.log].reverse(),
    };
  }
}

module.exports = { CrossChainScenario, STEPS };
