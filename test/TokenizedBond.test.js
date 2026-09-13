const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;

describe("TokenizedBond", function () {
  async function deployFixture() {
    const [issuer, alice, bob, outsider] = await ethers.getSigners();
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const faceValue = ethers.parseEther("1");
    const couponRateBps = 500; // 5.00% p.a.
    const couponInterval = 90 * DAY;
    const maturityDate = now + 370 * DAY;

    const Bond = await ethers.getContractFactory("TokenizedBond");
    const bond = await Bond.deploy(
      "Demo DZ Digital Bond 2027",
      "DDB27",
      faceValue,
      couponRateBps,
      couponInterval,
      maturityDate
    );

    return {
      bond,
      issuer,
      alice,
      bob,
      outsider,
      faceValue,
      couponRateBps,
      couponInterval,
      maturityDate,
    };
  }

  async function moveTo(timestamp) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await ethers.provider.send("evm_mine");
  }

  it("allows only the issuer to whitelist and issue", async function () {
    const { bond, alice, outsider } = await deployFixture();

    await expect(bond.connect(outsider).setWhitelisted(alice.address, true))
      .to.be.revertedWithCustomError(bond, "OnlyIssuer");

    await expect(bond.issue(alice.address, 10))
      .to.be.revertedWithCustomError(bond, "InvestorNotWhitelisted");

    await bond.setWhitelisted(alice.address, true);
    await expect(bond.issue(alice.address, 10))
      .to.emit(bond, "BondIssued")
      .withArgs(alice.address, 10);

    expect(await bond.balanceOf(alice.address)).to.equal(10);
    expect(await bond.totalSupply()).to.equal(10);
  });

  it("restricts secondary transfers to whitelisted investors", async function () {
    const { bond, alice, bob, outsider } = await deployFixture();
    await bond.setWhitelisted(alice.address, true);
    await bond.setWhitelisted(bob.address, true);
    await bond.issue(alice.address, 10);

    await expect(bond.connect(alice).transfer(outsider.address, 2))
      .to.be.revertedWithCustomError(bond, "InvestorNotWhitelisted");

    await bond.connect(alice).transfer(bob.address, 4);
    expect(await bond.balanceOf(alice.address)).to.equal(6);
    expect(await bond.balanceOf(bob.address)).to.equal(4);
  });

  it("pays a scheduled coupon according to current holdings", async function () {
    const { bond, alice, bob, couponInterval } = await deployFixture();
    await bond.setWhitelisted(alice.address, true);
    await bond.setWhitelisted(bob.address, true);
    await bond.issue(alice.address, 6);
    await bond.issue(bob.address, 4);

    const dueDate = Number(await bond.nextCouponDate());
    const payment = (await bond.couponPerUnit()) * 10n;

    await expect(bond.payCoupon({ value: payment }))
      .to.be.revertedWithCustomError(bond, "CouponNotDue");

    await moveTo(dueDate);
    await expect(bond.payCoupon({ value: payment }))
      .to.emit(bond, "CouponPaid")
      .withArgs(1, dueDate + 1, payment);

    expect(await bond.couponsPaid()).to.equal(1);
    expect(await bond.nextCouponDate()).to.equal(dueDate + couponInterval);
    expect(await ethers.provider.getBalance(bond.target)).to.equal(0);
  });

  it("rejects an incorrectly funded coupon", async function () {
    const { bond, alice } = await deployFixture();
    await bond.setWhitelisted(alice.address, true);
    await bond.issue(alice.address, 1);
    await moveTo(Number(await bond.nextCouponDate()));

    const required = await bond.couponPerUnit();
    await expect(bond.payCoupon({ value: required - 1n }))
      .to.be.revertedWithCustomError(bond, "IncorrectPayment")
      .withArgs(required, required - 1n);
  });

  it("funds redemption after maturity and lets investors redeem principal", async function () {
    const { bond, alice, bob, faceValue, maturityDate } = await deployFixture();
    await bond.setWhitelisted(alice.address, true);
    await bond.setWhitelisted(bob.address, true);
    await bond.issue(alice.address, 3);
    await bond.issue(bob.address, 2);

    await expect(bond.fundRedemption({ value: faceValue * 5n }))
      .to.be.revertedWithCustomError(bond, "BondNotMatured");

    await moveTo(maturityDate);
    await bond.fundRedemption({ value: faceValue * 5n });
    await bond.connect(alice).redeem();
    await bond.connect(bob).redeem();

    expect(await bond.balanceOf(alice.address)).to.equal(0);
    expect(await bond.balanceOf(bob.address)).to.equal(0);
    expect(await bond.totalSupply()).to.equal(0);
    expect(await ethers.provider.getBalance(bond.target)).to.equal(0);
  });
});
