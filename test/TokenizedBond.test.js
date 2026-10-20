const { expect } = require("chai");
const { ethers } = require("hardhat");

// Each test name starts with the acceptance criterion it checks (docs/USER_STORIES.md).
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const BPS = 10_000n;

describe("TokenizedBond", function () {
  async function deploy() {
    const [issuer, alice, bob, outsider] = await ethers.getSigners();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const faceValue = ethers.parseEther("1");
    const couponRateBps = 500n; // 5.00 % p.a.
    const couponInterval = 90 * DAY;
    const maturityDate = now + 370 * DAY;
    const bond = await (await ethers.getContractFactory("TokenizedBond")).deploy(
      "Demo Digital Bond 2027", "DDB27", faceValue, couponRateBps, couponInterval, maturityDate
    );
    return { bond, issuer, alice, bob, outsider, faceValue, couponRateBps, couponInterval, maturityDate };
  }

  async function issued() {
    const ctx = await deploy();
    await ctx.bond.setWhitelisted(ctx.alice.address, true);
    await ctx.bond.setWhitelisted(ctx.bob.address, true);
    await ctx.bond.issue(ctx.alice.address, 6);
    await ctx.bond.issue(ctx.bob.address, 4);
    return ctx;
  }

  async function moveTo(timestamp) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
    await ethers.provider.send("evm_mine");
  }

  async function atMaturity() {
    const ctx = await issued();
    await moveTo(ctx.maturityDate);
    return ctx;
  }

  describe("US0 Bond terms", function () {
    it("AC0.1 rejects invalid terms at deployment", async function () {
      const Bond = await ethers.getContractFactory("TokenizedBond");
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const one = ethers.parseEther("1");
      const cases = [
        [0, 500, 90 * DAY, now + YEAR],           // zero face value
        [one, 10_001, 90 * DAY, now + YEAR],      // rate above 100 %
        [one, 500, 0, now + YEAR],                // zero interval
        [one, 500, 90 * DAY, now + 30 * DAY],     // matures before first coupon
      ];
      for (const [face, rate, interval, maturity] of cases) {
        await expect(Bond.deploy("x", "X", face, rate, interval, maturity)).to.be.revertedWithCustomError(Bond, "InvalidTerms");
      }
    });
  });

  describe("US1 Investor eligibility", function () {
    it("AC1.1 only the issuer can change the whitelist", async function () {
      const { bond, alice, bob } = await deploy();
      await expect(bond.connect(alice).setWhitelisted(bob.address, true)).to.be.revertedWithCustomError(bond, "OnlyIssuer");
      await bond.setWhitelisted(bob.address, true);
      expect(await bond.isWhitelisted(bob.address)).to.equal(true);
      await bond.setWhitelisted(bob.address, false);
      expect(await bond.isWhitelisted(bob.address)).to.equal(false);
    });

    it("AC1.2 rejects the zero address", async function () {
      const { bond } = await deploy();
      await expect(bond.setWhitelisted(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(bond, "InvalidAmount");
    });

    it("AC1.3 emits InvestorWhitelisted on every change", async function () {
      const { bond, alice } = await deploy();
      await expect(bond.setWhitelisted(alice.address, true)).to.emit(bond, "InvestorWhitelisted").withArgs(alice.address, true);
      await expect(bond.setWhitelisted(alice.address, false)).to.emit(bond, "InvestorWhitelisted").withArgs(alice.address, false);
    });
  });

  describe("US2 Issuance", function () {
    it("AC2.1 only the issuer can issue", async function () {
      const { bond, alice } = await deploy();
      await bond.setWhitelisted(alice.address, true);
      await expect(bond.connect(alice).issue(alice.address, 10)).to.be.revertedWithCustomError(bond, "OnlyIssuer");
    });

    it("AC2.2 issues only to whitelisted investors", async function () {
      const { bond, outsider } = await deploy();
      await expect(bond.issue(outsider.address, 10)).to.be.revertedWithCustomError(bond, "InvestorNotWhitelisted");
    });

    it("AC2.3 rejects zero units", async function () {
      const { bond, alice } = await deploy();
      await bond.setWhitelisted(alice.address, true);
      await expect(bond.issue(alice.address, 0)).to.be.revertedWithCustomError(bond, "InvalidAmount");
    });

    it("AC2.4 updates balance and supply and emits BondIssued and Transfer", async function () {
      const { bond, alice } = await deploy();
      await bond.setWhitelisted(alice.address, true);
      await expect(bond.issue(alice.address, 10))
        .to.emit(bond, "BondIssued").withArgs(alice.address, 10)
        .and.to.emit(bond, "Transfer").withArgs(ethers.ZeroAddress, alice.address, 10);
      expect(await bond.balanceOf(alice.address)).to.equal(10n);
      expect(await bond.totalSupply()).to.equal(10n);
    });

    it("AC2.5 rejects issuance at or after maturity", async function () {
      const { bond, alice, maturityDate } = await atMaturity();
      expect(maturityDate).to.be.greaterThan(0);
      await expect(bond.issue(alice.address, 1)).to.be.revertedWithCustomError(bond, "IssuanceClosed");
    });
  });

  describe("US3 Transfers", function () {
    it("AC3.1 transfers between whitelisted investors update both balances", async function () {
      const { bond, alice, bob } = await issued();
      await expect(bond.connect(alice).transfer(bob.address, 2)).to.emit(bond, "Transfer").withArgs(alice.address, bob.address, 2);
      expect(await bond.balanceOf(alice.address)).to.equal(4n);
      expect(await bond.balanceOf(bob.address)).to.equal(6n);
    });

    it("AC3.2 rejects a transfer to a non-whitelisted address", async function () {
      const { bond, alice, outsider } = await issued();
      await expect(bond.connect(alice).transfer(outsider.address, 1)).to.be.revertedWithCustomError(bond, "InvestorNotWhitelisted");
    });

    it("AC3.3 an investor removed from the whitelist can no longer transfer", async function () {
      const { bond, alice, bob } = await issued();
      await bond.setWhitelisted(alice.address, false);
      await expect(bond.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(bond, "InvestorNotWhitelisted");
    });

    it("AC3.4 rejects transfers above the balance or of zero units", async function () {
      const { bond, alice, bob } = await issued();
      await expect(bond.connect(alice).transfer(bob.address, 7)).to.be.revertedWithCustomError(bond, "InsufficientBalance");
      await expect(bond.connect(alice).transfer(bob.address, 0)).to.be.revertedWithCustomError(bond, "InvalidAmount");
    });

    it("AC3.5 a third party moves units only within the granted allowance", async function () {
      const { bond, alice, bob, outsider } = await issued();
      await expect(bond.connect(outsider).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(bond, "InsufficientAllowance");
      await bond.connect(alice).approve(outsider.address, 2);
      await bond.connect(outsider).transferFrom(alice.address, bob.address, 2);
      expect(await bond.balanceOf(bob.address)).to.equal(6n);
      expect(await bond.allowance(alice.address, outsider.address)).to.equal(0n);
      await expect(bond.connect(outsider).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(bond, "InsufficientAllowance");
    });
  });

  describe("US4 Coupon payments", function () {
    it("AC4.1 coupon per unit = face value x rate x interval / 365 days", async function () {
      const { bond, faceValue, couponRateBps, couponInterval } = await deploy();
      expect(await bond.couponPerUnit()).to.equal((faceValue * couponRateBps * BigInt(couponInterval)) / (BPS * BigInt(YEAR)));
    });

    it("AC4.2 rejects payment before the coupon date", async function () {
      const { bond } = await issued();
      const due = (await bond.couponPerUnit()) * 10n;
      await expect(bond.payCoupon({ value: due })).to.be.revertedWithCustomError(bond, "CouponNotDue");
    });

    it("AC4.3 rejects a payment that differs from coupon per unit x total supply", async function () {
      const { bond } = await issued();
      await moveTo(await bond.nextCouponDate());
      const due = (await bond.couponPerUnit()) * 10n;
      await expect(bond.payCoupon({ value: due - 1n }))
        .to.be.revertedWithCustomError(bond, "IncorrectPayment").withArgs(due, due - 1n);
    });

    it("AC4.4 pays each holder pro rata and moves to the next coupon date", async function () {
      const { bond, alice, bob, couponInterval } = await issued();
      const firstDate = await bond.nextCouponDate();
      await moveTo(firstDate);
      const perUnit = await bond.couponPerUnit();
      await expect(bond.payCoupon({ value: perUnit * 10n })).to.changeEtherBalances([alice, bob], [perUnit * 6n, perUnit * 4n]);
      expect(await bond.couponsPaid()).to.equal(1n);
      expect(await bond.nextCouponDate()).to.equal(firstDate + BigInt(couponInterval));
      await expect(bond.payCoupon({ value: perUnit * 10n })).to.be.revertedWithCustomError(bond, "CouponNotDue");
    });

    it("AC4.5 only the issuer can pay a coupon", async function () {
      const { bond, alice } = await issued();
      await moveTo(await bond.nextCouponDate());
      const due = (await bond.couponPerUnit()) * 10n;
      await expect(bond.connect(alice).payCoupon({ value: due })).to.be.revertedWithCustomError(bond, "OnlyIssuer");
    });
  });

  describe("US5 Principal redemption", function () {
    it("AC5.1 funding only at or after maturity, and only once", async function () {
      const { bond, faceValue, maturityDate } = await issued();
      const principal = faceValue * 10n;
      await expect(bond.fundRedemption({ value: principal })).to.be.revertedWithCustomError(bond, "BondNotMatured");
      await moveTo(maturityDate);
      await expect(bond.fundRedemption({ value: principal })).to.emit(bond, "RedemptionFunded").withArgs(principal);
      await expect(bond.fundRedemption({ value: principal })).to.be.revertedWithCustomError(bond, "RedemptionAlreadyFunded");
    });

    it("AC5.2 funding must equal face value x total supply", async function () {
      const { bond, faceValue } = await atMaturity();
      await expect(bond.fundRedemption({ value: faceValue * 9n }))
        .to.be.revertedWithCustomError(bond, "IncorrectPayment").withArgs(faceValue * 10n, faceValue * 9n);
    });

    it("AC5.3 rejects redemption before funding", async function () {
      const { bond, alice } = await atMaturity();
      await expect(bond.connect(alice).redeem()).to.be.revertedWithCustomError(bond, "RedemptionNotFunded");
    });

    it("AC5.4 pays units x face value and burns the units", async function () {
      const { bond, alice, bob, faceValue } = await atMaturity();
      await bond.fundRedemption({ value: faceValue * 10n });
      await expect(bond.connect(alice).redeem()).to.changeEtherBalance(alice, faceValue * 6n);
      await expect(bond.connect(bob).redeem())
        .to.emit(bond, "Redeemed").withArgs(bob.address, 4, faceValue * 4n)
        .and.to.emit(bond, "Transfer").withArgs(bob.address, ethers.ZeroAddress, 4);
      expect(await bond.totalSupply()).to.equal(0n);
      expect(await bond.balanceOf(alice.address)).to.equal(0n);
    });

    it("AC5.5 a holder without units cannot redeem", async function () {
      const { bond, alice, outsider, faceValue } = await atMaturity();
      await bond.fundRedemption({ value: faceValue * 10n });
      await expect(bond.connect(outsider).redeem()).to.be.revertedWithCustomError(bond, "InvalidAmount");
      await bond.connect(alice).redeem();
      await expect(bond.connect(alice).redeem()).to.be.revertedWithCustomError(bond, "InvalidAmount");
    });
  });
});
