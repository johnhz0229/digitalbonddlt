const { expect } = require("chai");
const { ethers } = require("hardhat");

// Each describe block maps to one acceptance criterion in docs/learn/01-dvp.md.
const Status = { Proposed: 1n, Confirmed: 2n, Settled: 3n, Failed: 4n, Cancelled: 5n };
const Reason = {
  None: 0n,
  SellerNotWhitelisted: 1n,
  BuyerNotWhitelisted: 2n,
  InsufficientBonds: 3n,
  InsufficientBondAllowance: 4n,
  InsufficientCash: 5n,
  InsufficientCashAllowance: 6n,
};
const eur = (amount) => BigInt(Math.round(amount * 100)); // tEUR has two decimals

describe("DvPSettlement", function () {
  const UNITS = 10n;
  const PRICE = eur(1_000); // EUR 1,000 for 10 units

  async function deploy() {
    const [issuer, seller, buyer, outsider] = await ethers.getSigners();
    const now = (await ethers.provider.getBlock("latest")).timestamp;

    const bond = await (await ethers.getContractFactory("TokenizedBond")).deploy(
      "Demo Digital Bond", "DDB", ethers.parseEther("1"), 500, 90 * 86400, now + 400 * 86400
    );
    const cash = await (await ethers.getContractFactory("TokenisedEuro")).deploy();
    const dvp = await (await ethers.getContractFactory("DvPSettlement")).deploy(
      await bond.getAddress(), await cash.getAddress()
    );

    await bond.setWhitelisted(seller.address, true);
    await bond.setWhitelisted(buyer.address, true);
    await bond.issue(seller.address, 20);
    await cash.mint(buyer.address, eur(5_000));

    return { bond, cash, dvp, issuer, seller, buyer, outsider };
  }

  async function confirmedTrade(ctx, { units = UNITS, price = PRICE } = {}) {
    await ctx.dvp.connect(ctx.seller).proposeTrade(ctx.buyer.address, units, price);
    const id = await ctx.dvp.tradeCount();
    await ctx.dvp.connect(ctx.buyer).confirmTrade(id, units, price);
    return id;
  }

  async function authoriseBothLegs(ctx, { units = UNITS, price = PRICE } = {}) {
    await ctx.bond.connect(ctx.seller).approve(await ctx.dvp.getAddress(), units);
    await ctx.cash.connect(ctx.buyer).approve(await ctx.dvp.getAddress(), price);
  }

  async function balances(ctx) {
    return {
      sellerBonds: await ctx.bond.balanceOf(ctx.seller.address),
      buyerBonds: await ctx.bond.balanceOf(ctx.buyer.address),
      sellerCash: await ctx.cash.balanceOf(ctx.seller.address),
      buyerCash: await ctx.cash.balanceOf(ctx.buyer.address),
    };
  }

  describe("AC1 success: both legs settle in one transaction", function () {
    it("swaps bonds and cash and records the trade as settled", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      await authoriseBothLegs(ctx);

      await expect(ctx.dvp.connect(ctx.buyer).settle(id))
        .to.emit(ctx.dvp, "TradeSettled").withArgs(id, UNITS, PRICE);

      expect(await balances(ctx)).to.deep.equal({
        sellerBonds: 10n, buyerBonds: 10n, sellerCash: PRICE, buyerCash: eur(4_000),
      });
      expect((await ctx.dvp.trades(id)).status).to.equal(Status.Settled);
    });

    it("cannot settle the same trade twice", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      await authoriseBothLegs(ctx);
      await ctx.dvp.connect(ctx.buyer).settle(id);

      await expect(ctx.dvp.connect(ctx.buyer).settle(id))
        .to.be.revertedWithCustomError(ctx.dvp, "WrongStatus");
    });
  });

  describe("AC2 buyer has insufficient cash", function () {
    it("records a failure with the reason and moves nothing", async function () {
      const ctx = await deploy();
      const tooExpensive = eur(9_000); // buyer only holds EUR 5,000
      const id = await confirmedTrade(ctx, { price: tooExpensive });
      await authoriseBothLegs(ctx, { price: tooExpensive });
      const before = await balances(ctx);

      await expect(ctx.dvp.connect(ctx.seller).settle(id))
        .to.emit(ctx.dvp, "SettlementFailed").withArgs(id, Reason.InsufficientCash);

      expect(await balances(ctx)).to.deep.equal(before);
      const trade = await ctx.dvp.trades(id);
      expect(trade.status).to.equal(Status.Failed);
      expect(trade.failureReason).to.equal(Reason.InsufficientCash);
    });

    it("also fails when the buyer has the cash but did not authorise it", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      await ctx.bond.connect(ctx.seller).approve(await ctx.dvp.getAddress(), UNITS);

      await expect(ctx.dvp.connect(ctx.seller).settle(id))
        .to.emit(ctx.dvp, "SettlementFailed").withArgs(id, Reason.InsufficientCashAllowance);
    });
  });

  describe("AC3 seller has insufficient bonds", function () {
    it("records a failure and moves nothing", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx, { units: 50n }); // seller holds 20
      await authoriseBothLegs(ctx, { units: 50n });
      const before = await balances(ctx);

      await expect(ctx.dvp.connect(ctx.buyer).settle(id))
        .to.emit(ctx.dvp, "SettlementFailed").withArgs(id, Reason.InsufficientBonds);
      expect(await balances(ctx)).to.deep.equal(before);
    });
  });

  describe("AC4 buyer is not whitelisted", function () {
    it("records a compliance failure and moves nothing", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      await authoriseBothLegs(ctx);
      await ctx.bond.setWhitelisted(ctx.buyer.address, false); // e.g. KYC expired
      const before = await balances(ctx);

      await expect(ctx.dvp.connect(ctx.seller).settle(id))
        .to.emit(ctx.dvp, "SettlementFailed").withArgs(id, Reason.BuyerNotWhitelisted);
      expect(await balances(ctx)).to.deep.equal(before);
    });
  });

  describe("AC5 both parties must agree on the same terms", function () {
    it("rejects a confirmation with different terms", async function () {
      const ctx = await deploy();
      await ctx.dvp.connect(ctx.seller).proposeTrade(ctx.buyer.address, UNITS, PRICE);

      await expect(ctx.dvp.connect(ctx.buyer).confirmTrade(1, UNITS, eur(990)))
        .to.be.revertedWithCustomError(ctx.dvp, "TermsMismatch");
    });

    it("cannot settle a trade the buyer has not confirmed", async function () {
      const ctx = await deploy();
      await ctx.dvp.connect(ctx.seller).proposeTrade(ctx.buyer.address, UNITS, PRICE);
      await authoriseBothLegs(ctx);

      await expect(ctx.dvp.connect(ctx.seller).settle(1))
        .to.be.revertedWithCustomError(ctx.dvp, "WrongStatus").withArgs(Status.Proposed);
    });

    it("only the named buyer can confirm", async function () {
      const ctx = await deploy();
      await ctx.dvp.connect(ctx.seller).proposeTrade(ctx.buyer.address, UNITS, PRICE);

      await expect(ctx.dvp.connect(ctx.outsider).confirmTrade(1, UNITS, PRICE))
        .to.be.revertedWithCustomError(ctx.dvp, "NotCounterparty");
    });
  });

  describe("Operations controls", function () {
    it("lets operations see a problem before settling", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      expect(await ctx.dvp.checkSettlement(id)).to.equal(Reason.InsufficientBondAllowance);
      await authoriseBothLegs(ctx);
      expect(await ctx.dvp.checkSettlement(id)).to.equal(Reason.None);
    });

    it("lets a party cancel a proposal that was not yet confirmed", async function () {
      const ctx = await deploy();
      await ctx.dvp.connect(ctx.seller).proposeTrade(ctx.buyer.address, UNITS, PRICE);
      await expect(ctx.dvp.connect(ctx.buyer).cancelTrade(1)).to.emit(ctx.dvp, "TradeCancelled");
      await expect(ctx.dvp.connect(ctx.buyer).confirmTrade(1, UNITS, PRICE))
        .to.be.revertedWithCustomError(ctx.dvp, "WrongStatus");
    });

    it("outsiders cannot trigger settlement", async function () {
      const ctx = await deploy();
      const id = await confirmedTrade(ctx);
      await expect(ctx.dvp.connect(ctx.outsider).settle(id))
        .to.be.revertedWithCustomError(ctx.dvp, "NotCounterparty");
    });
  });
});
