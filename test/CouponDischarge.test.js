const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { createOracleKeyPair, createKeyDocument, DecryptionOracle } = require("../scripts/lib/erc7573");

// Payment versus discharge: the coupon claim on the bond is discharged only when
// the bond accepts the success preimage released after the cash moved.
const eur = (amount) => BigInt(Math.round(amount * 100));
const FACE_VALUE = eur(1_000); // EUR 1,000 per bond unit, in cash-token cents

describe("CouponDischarge (payment versus discharge)", function () {
  this.timeout(20_000);
  const oracleKeys = createOracleKeyPair();

  async function deploy() {
    const [issuer, alice, bob, oracleSigner, bank, outsider] = await ethers.getSigners();
    const now = (await ethers.provider.getBlock("latest")).timestamp;

    // Asset chain: bond and its coupon servicing contract
    const bond = await (await ethers.getContractFactory("TokenizedBond")).deploy(
      "Demo Digital Bond", "DDB", ethers.parseEther("1"), 500, 90 * 86400, now + 400 * 86400
    );
    await bond.setWhitelisted(alice.address, true);
    await bond.setWhitelisted(bob.address, true);
    await bond.issue(alice.address, 6);
    await bond.issue(bob.address, 4);
    const coupon = await (await ethers.getContractFactory("CouponDischarge")).deploy(
      await bond.getAddress(), FACE_VALUE, oracleSigner.address
    );

    // Payment chain: cash and the ERC-7573-style payment contract (reused from module 3)
    const cash = await (await ethers.getContractFactory("TokenisedEuro")).connect(bank).deploy();
    const payment = await (await ethers.getContractFactory("PaymentDecryptionContract")).deploy(
      await cash.getAddress(), oracleSigner.address
    );
    await cash.connect(bank).mint(issuer.address, eur(10_000));

    const oracle = new DecryptionOracle({
      privateKey: oracleKeys.privateKey,
      publicKey: oracleKeys.publicKey,
      contracts: [await coupon.getAddress()],
    });
    return { bond, coupon, cash, payment, oracle, issuer, alice, bob, oracleSigner, outsider };
  }

  async function recordFirstCoupon(ctx) {
    await time.increaseTo(await ctx.coupon.couponDate(1));
    await ctx.coupon.recordCoupon(1);
  }

  // Bond side: open an attempt; the oracle generates and commits both keys.
  async function openAttempt(ctx, holder) {
    await ctx.coupon.connect(ctx.issuer).openAttempt(1, holder.address);
    const id = await ctx.coupon.attemptCount();
    const keys = ctx.oracle.generateOutcomeKeys({ contract: await ctx.coupon.getAddress(), id });
    await ctx.coupon.connect(ctx.oracleSigner).commitOutcomeKeys(id, keys.success.hash, keys.success.encrypted, keys.failure.hash, keys.failure.encrypted);
    return { id, keys, amount: (await ctx.coupon.attempts(id)).amount };
  }

  // Payment side: the issuer pays the holder; the holder's connector confirms
  // that the encrypted keys are exactly the ones committed on the bond.
  async function payOnPaymentChain(ctx, holder, { id, keys, amount }, { fund = true } = {}) {
    await ctx.payment.connect(ctx.issuer).inceptTransfer(id, amount, holder.address, keys.success.encrypted, keys.failure.encrypted);
    await ctx.payment.connect(holder).confirmTransfer(id, amount, ctx.issuer.address, keys.success.encrypted, keys.failure.encrypted);
    if (fund) await ctx.cash.connect(ctx.issuer).approve(await ctx.payment.getAddress(), amount);
    const receipt = await (await ctx.payment.connect(ctx.issuer).transferAndDecrypt(id)).wait();
    const [released] = await ctx.oracle.handleReceipt(ctx.payment.connect(ctx.oracleSigner), receipt);
    return released;
  }

  it("fixes each holder's claim at the record date", async function () {
    const ctx = await deploy();
    await expect(ctx.coupon.recordCoupon(1)).to.be.revertedWithCustomError(ctx.coupon, "CouponNotDue");
    await recordFirstCoupon(ctx);

    const perUnit = await ctx.coupon.couponPerUnit(); // EUR 1,000 x 5% x 90/365 = EUR 12.32
    expect(perUnit).to.equal(eur(12.32));
    expect(await ctx.coupon.entitlement(1, ctx.alice.address)).to.equal(perUnit * 6n);
    expect(await ctx.coupon.entitlement(1, ctx.bob.address)).to.equal(perUnit * 4n);

    // A transfer after the record date does not change who is owed this coupon.
    await ctx.bond.connect(ctx.alice).transfer(ctx.bob.address, 6);
    expect(await ctx.coupon.entitlement(1, ctx.alice.address)).to.equal(perUnit * 6n);
  });

  it("a successful payment alone does not discharge the claim; the accepted preimage does", async function () {
    const ctx = await deploy();
    await recordFirstCoupon(ctx);
    const attempt = await openAttempt(ctx, ctx.alice);
    const released = await payOnPaymentChain(ctx, ctx.alice, attempt);

    expect(released.success).to.equal(true);
    expect(await ctx.cash.balanceOf(ctx.alice.address)).to.equal(attempt.amount);
    expect(await ctx.coupon.isOutstanding(1, ctx.alice.address)).to.equal(true); // cash moved, claim still open

    await expect(ctx.coupon.connect(ctx.alice).submitOutcome(attempt.id, released.key))
      .to.emit(ctx.coupon, "CouponDischarged").withArgs(attempt.id, 1, ctx.alice.address, attempt.amount);
    expect(await ctx.coupon.isOutstanding(1, ctx.alice.address)).to.equal(false);
  });

  it("forwarding the same key again is a harmless no-op, so connectors can retry", async function () {
    const ctx = await deploy();
    await recordFirstCoupon(ctx);
    const attempt = await openAttempt(ctx, ctx.alice);
    const released = await payOnPaymentChain(ctx, ctx.alice, attempt);
    await ctx.coupon.submitOutcome(attempt.id, released.key);

    await expect(ctx.coupon.connect(ctx.outsider).submitOutcome(attempt.id, released.key))
      .not.to.emit(ctx.coupon, "CouponDischarged");
  });

  it("a failed payment closes the attempt but keeps the claim; a new attempt can then succeed", async function () {
    const ctx = await deploy();
    await recordFirstCoupon(ctx);

    const first = await openAttempt(ctx, ctx.alice);
    const failed = await payOnPaymentChain(ctx, ctx.alice, first, { fund: false }); // issuer did not authorise cash
    expect(failed.success).to.equal(false);
    await expect(ctx.coupon.submitOutcome(first.id, failed.key))
      .to.emit(ctx.coupon, "SettlementAttemptFailed").withArgs(first.id, 1, ctx.alice.address);
    expect(await ctx.coupon.isOutstanding(1, ctx.alice.address)).to.equal(true);

    const second = await openAttempt(ctx, ctx.alice);
    expect(second.id).to.equal(first.id + 1n);
    const paid = await payOnPaymentChain(ctx, ctx.alice, second);
    await ctx.coupon.submitOutcome(second.id, paid.key);
    expect(await ctx.coupon.isOutstanding(1, ctx.alice.address)).to.equal(false);
  });

  it("only one attempt per claim can be in progress, and none after discharge", async function () {
    const ctx = await deploy();
    await recordFirstCoupon(ctx);
    const attempt = await openAttempt(ctx, ctx.alice);
    await expect(ctx.coupon.openAttempt(1, ctx.alice.address))
      .to.be.revertedWithCustomError(ctx.coupon, "AttemptInProgress");

    const released = await payOnPaymentChain(ctx, ctx.alice, attempt);
    await ctx.coupon.submitOutcome(attempt.id, released.key);
    await expect(ctx.coupon.openAttempt(1, ctx.alice.address))
      .to.be.revertedWithCustomError(ctx.coupon, "AlreadyDischarged");
  });

  describe("why the issuer cannot fake a payment", function () {
    it("a guessed preimage is rejected; nobody knows the real one before the oracle releases it", async function () {
      const ctx = await deploy();
      await recordFirstCoupon(ctx);
      const attempt = await openAttempt(ctx, ctx.alice);
      const guess = createKeyDocument({ contract: await ctx.coupon.getAddress(), id: attempt.id, outcome: "success" });
      await expect(ctx.coupon.connect(ctx.issuer).submitOutcome(attempt.id, guess))
        .to.be.revertedWithCustomError(ctx.coupon, "InvalidPreimage");
    });

    it("only the oracle can commit the outcome keys", async function () {
      const ctx = await deploy();
      await recordFirstCoupon(ctx);
      await ctx.coupon.openAttempt(1, ctx.alice.address);
      await expect(ctx.coupon.connect(ctx.issuer).commitOutcomeKeys(1, ethers.ZeroHash, "0x01", ethers.ZeroHash, "0x01"))
        .to.be.revertedWithCustomError(ctx.coupon, "OnlyOracle");
    });

    it("the holder refuses a payment whose keys differ from the bond's commitment", async function () {
      const ctx = await deploy();
      await recordFirstCoupon(ctx);
      const attempt = await openAttempt(ctx, ctx.alice);
      const other = ctx.oracle.generateOutcomeKeys({ contract: await ctx.coupon.getAddress(), id: attempt.id });
      await ctx.payment.connect(ctx.issuer).inceptTransfer(attempt.id, attempt.amount, ctx.alice.address, other.success.encrypted, attempt.keys.failure.encrypted);
      await expect(ctx.payment.connect(ctx.alice).confirmTransfer(attempt.id, attempt.amount, ctx.issuer.address, attempt.keys.success.encrypted, attempt.keys.failure.encrypted))
        .to.be.revertedWithCustomError(ctx.payment, "TermsMismatch");
    });
  });
});
