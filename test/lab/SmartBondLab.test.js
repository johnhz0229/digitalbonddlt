const { expect } = require("chai");
const { ethers } = require("hardhat");
const { SmartBondLab, buildTerms } = require("../../scripts/lab/lab");
const { isinCheckDigit, lockIdFor } = require("../../scripts/lab/participants");

// In tests both "ledgers" are the Hardhat network; the contracts on the two sides
// never call each other, so the only links are events, keys and the connectors.
describe("Smart Bond Lab", function () {
  this.timeout(60_000);

  async function newLab() {
    const signers = await ethers.getSigners();
    const chain = { provider: ethers.provider, signers: signers.slice(0, 6) };
    return SmartBondLab.create({ asset: chain, payment: chain });
  }

  async function toMinted(lab, { tenor = 2, units = 100, rate = 3.1 } = {}) {
    await lab.publishFundingLevel(tenor, rate, 500);
    await lab.approveInvestor();
    await lab.requestTrade(tenor, units);
    await lab.inceptTrade();
    await lab.confirmTrade();
    return lab.bond(await lab.latestInstance(), lab.parties.issuer);
  }

  const monitorText = (lab) => lab.net.monitor.map((m) => m.message || "").join("\n");

  it("runs the full life cycle: issuance DvP, two coupons, redemption with burn", async function () {
    const lab = await newLab();
    const bond = await toMinted(lab);

    // Participants reacted on their own: ISIN, token, issuer authorisation, keys.
    expect(await bond.state()).to.equal(4n); // Minted
    expect(await bond.isin()).to.match(/^DE000LAB\d{3}\d$/);
    const token = await ethers.getContractAt("BondToken", await bond.token());
    expect(await token.balanceOf(lab.parties.issuer.address)).to.equal(100n);

    await lab.lockIssuanceCash();
    expect(await bond.state()).to.equal(5n); // Issued
    expect(await token.balanceOf(lab.parties.investor.address)).to.equal(100n);
    expect(await lab.cash.balanceOf(lab.parties.issuer.address)).to.equal(25_000_000n + 10_000_000n); // + EUR 100,000

    for (const period of [1, 2]) {
      await lab.advanceToNextCoupon();
      await lab.payCoupon();
      expect(await bond.discharged(period)).to.equal(true);
    }
    expect(await lab.cash.balanceOf(lab.parties.investor.address)).to.equal(100_000_000n - 10_000_000n + 2n * 310_000n);

    await lab.requestRedemption();
    expect(await bond.state()).to.equal(6n); // Redeemed
    expect(await token.totalSupply()).to.equal(0n);
    expect(await lab.cash.balanceOf(lab.parties.investor.address)).to.equal(100_000_000n + 2n * 310_000n);
    expect(await lab.cash.balanceOf(await lab.cashLock.getAddress())).to.equal(0n);
  });

  it("the issuer's connector refuses a wrong cash lock; the investor aborts, recovers the cash and retries", async function () {
    const lab = await newLab();
    const bond = await toMinted(lab);

    await lab.lockIssuanceCash(90_000); // EUR 10,000 short
    expect(monitorText(lab)).to.include("Refused to attest");
    expect(await bond.state()).to.equal(4n); // nothing delivered
    expect(await lab.cash.balanceOf(await lab.cashLock.getAddress())).to.equal(9_000_000n);

    await lab.abortIssuance();
    expect(await lab.cash.balanceOf(await lab.cashLock.getAddress())).to.equal(0n);
    expect(await lab.cash.balanceOf(lab.parties.investor.address)).to.equal(100_000_000n);

    await lab.retryIssuance();
    await lab.lockIssuanceCash();
    expect(await bond.state()).to.equal(5n);
  });

  it("a coupon is only discharged when the bond accepts the success key", async function () {
    const lab = await newLab();
    const bond = await toMinted(lab, { tenor: 1 });
    await lab.lockIssuanceCash();
    await lab.advanceToNextCoupon();

    // Switch off the issuer's automatic cash lock: the settlement waits, the claim stays open.
    lab.issuerConnector.autoLockCash = false;
    await lab.payCoupon();
    expect(await bond.discharged(1)).to.equal(false);
    const id = await bond.openSettlement(1);
    expect((await bond.settlements(id)).status).to.equal(2n); // KeysCommitted, waiting for cash
    await expect(bond.connect(lab.parties.investor).settle(id)).to.be.revertedWithCustomError(bond, "WrongSettlementStatus");
  });

  describe("state and role controls", function () {
    it("each step needs the right role", async function () {
      const lab = await newLab();
      await lab.publishFundingLevel(2, 3.1, 500);
      await lab.approveInvestor();
      await lab.requestTrade(2, 100);
      const asInvestor = lab.bond(await lab.latestInstance(), lab.parties.investor);
      await expect(asInvestor.inceptTrade("{}", 310, (await ethers.provider.getBlock("latest")).timestamp))
        .to.be.revertedWithCustomError(asInvestor, "WrongRole");
      await lab.inceptTrade();
      const asIssuer = lab.bond(await lab.latestInstance(), lab.parties.issuer);
      await expect(asIssuer.confirmTrade(await asIssuer.termsHash())).to.be.revertedWithCustomError(asIssuer, "WrongRole");
      await expect(asIssuer.commitKeys(1, ethers.ZeroHash, "0x01", ethers.ZeroHash, "0x01")).to.be.revertedWithCustomError(asIssuer, "WrongRole");
    });

    it("each step needs the right state", async function () {
      const lab = await newLab();
      await lab.publishFundingLevel(2, 3.1, 500);
      await lab.approveInvestor();
      await lab.requestTrade(2, 100);
      const asIsinAgent = lab.bond(await lab.latestInstance(), lab.parties.isinAgent);
      await expect(asIsinAgent.assignIsin("DE000LAB0000")).to.be.revertedWithCustomError(asIsinAgent, "WrongState");

      const bond = await (async () => { await lab.inceptTrade(); await lab.confirmTrade(); return lab.bond(await lab.latestInstance(), lab.parties.issuer); })();
      await expect(bond.cancel()).to.be.revertedWithCustomError(bond, "WrongState"); // terms already confirmed
      await expect(bond.openCouponSettlement(1)).to.be.revertedWithCustomError(bond, "WrongState"); // not issued yet
    });

    it("the investor confirms only the exact terms; a mismatching record is caught before confirming", async function () {
      const lab = await newLab();
      await lab.publishFundingLevel(2, 3.1, 500);
      await lab.approveInvestor();
      await lab.requestTrade(2, 100);
      const address = await lab.latestInstance();
      const bond = lab.bond(address, lab.parties.issuer);
      const issueDate = (await ethers.provider.getBlock("latest")).timestamp;
      // The record says 3.10%, but the contract would enforce 2.50%.
      const terms = buildTerms({ programme: "x", bondAddress: address, issuer: lab.parties.issuer.address, investor: lab.parties.investor.address, units: 100, tenorYears: 2, couponBps: 310, issueDate });
      await (await bond.inceptTrade(terms, 250, issueDate)).wait();
      await expect(lab.confirmTrade()).to.be.rejectedWith("Terms record and contract differ: coupon");
      await expect(bond.connect(lab.parties.investor).confirmTrade(ethers.ZeroHash)).to.be.revertedWithCustomError(bond, "TermsMismatch");
    });

    it("coupons and redemption are not due early", async function () {
      const lab = await newLab();
      const bond = await toMinted(lab);
      await lab.lockIssuanceCash();
      await expect(bond.openCouponSettlement(1)).to.be.revertedWithCustomError(bond, "NotDue");
      await expect(bond.connect(lab.parties.investor).requestRedemption()).to.be.revertedWithCustomError(bond, "NotDue");
    });
  });

  describe("protections", function () {
    it("only the payee can attest a cash lock", async function () {
      const lab = await newLab();
      const bond = await toMinted(lab);
      const id = await bond.openSettlement(0);
      await expect(bond.connect(lab.parties.investor).attestCashLock(id, lockIdFor(await bond.getAddress(), id)))
        .to.be.revertedWithCustomError(bond, "WrongRole");
    });

    it("the oracle refuses a request whose terms differ from the key", async function () {
      const lab = await newLab();
      const bond = await toMinted(lab);
      const id = await bond.openSettlement(0);
      const s = await bond.settlements(id);
      const encryptedKey = await bond.keyEncryptedSuccessOf(id);
      const fake = { address: await bond.getAddress(), args: { settlementId: id, success: true, payee: lab.parties.investor.address, amount: s.amount, encryptedKey } };
      expect(() => lab.oracle.decrypt(fake)).to.throw("terms differ");
    });

    it("only the oracle can publish a key, and only the requested one", async function () {
      const lab = await newLab();
      const bond = await toMinted(lab);
      const id = await bond.openSettlement(0);
      await expect(bond.publishKey(id, "0x01")).to.be.revertedWithCustomError(bond, "WrongRole");
      await expect(bond.connect(lab.parties.oracle).publishKey(id, "0x01")).to.be.revertedWithCustomError(bond, "WrongSettlementStatus");
    });

    it("bond units cannot be transferred outside the Smart Bond Contract", async function () {
      const lab = await newLab();
      const bond = await toMinted(lab);
      await lab.lockIssuanceCash();
      const token = await ethers.getContractAt("BondToken", await bond.token());
      await expect(token.connect(lab.parties.investor).transfer(lab.parties.issuer.address, 1)).to.be.revertedWithCustomError(token, "TransfersRestricted");
    });

    it("only eligible investors can request trades, within the published size", async function () {
      const lab = await newLab();
      await lab.publishFundingLevel(2, 3.1, 500);
      await expect(lab.factory.connect(lab.parties.investor).requestTrade(2, 100)).to.be.revertedWithCustomError(lab.factory, "NotEligible");
      await lab.approveInvestor();
      await expect(lab.factory.connect(lab.parties.investor).requestTrade(2, 501)).to.be.revertedWithCustomError(lab.factory, "InvalidUnits");
      await expect(lab.factory.connect(lab.parties.investor).publishFundingLevel(5, 1, 1)).to.be.revertedWithCustomError(lab.factory, "OnlyIssuer");
    });
  });

  it("computes ISIN check digits correctly", function () {
    expect(isinCheckDigit("US037833100")).to.equal("5"); // Apple, US0378331005
    expect(isinCheckDigit("DE000716460")).to.equal("0"); // SAP, DE0007164600
  });
});
