const { ethers } = require("hardhat");

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const faceValue = ethers.parseEther("1"); // Test currency only
  const annualCouponRateBps = 500; // 5.00%
  const couponInterval = 90 * 24 * 60 * 60;
  const maturityDate = now + 370 * 24 * 60 * 60;

  const Bond = await ethers.getContractFactory("TokenizedBond");
  const bond = await Bond.deploy(
    "Demo DZ Digital Bond 2027",
    "DDB27",
    faceValue,
    annualCouponRateBps,
    couponInterval,
    maturityDate
  );
  await bond.waitForDeployment();

  console.log("TokenizedBond deployed to:", await bond.getAddress());
  console.log("Maturity timestamp:", maturityDate);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
