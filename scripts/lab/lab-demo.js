// Smart Bond Lab in the terminal: one bond from funding level to redemption.
// Usage: npm run lab
const path = require("path");
const fs = require("fs");

const runtimeTemp = process.env.DEMO_TMP_DIR || path.join(__dirname, "..", "..", ".runtime-tmp");
fs.mkdirSync(runtimeTemp, { recursive: true });
process.env.TMPDIR = runtimeTemp;

const { createLocalLab } = require("./local");

const CHAIN = { asset: "ASSET  ", payment: "PAYMENT" };
let printed = 0;

function flush(lab) {
  for (const entry of lab.net.monitor.slice(printed)) {
    if (entry.type === "event") {
      console.log(`      · [${CHAIN[entry.chain]}] ${entry.contract}.${entry.name}${entry.summary ? `: ${entry.summary}` : ""}`);
    } else {
      console.log(`  ${entry.actor.padEnd(20)} ${entry.message}`);
    }
  }
  printed = lab.net.monitor.length;
}

async function step(lab, title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
  flush(lab);
}

(async () => {
  const lab = await createLocalLab();
  flush(lab);
  await step(lab, "1. The issuer publishes its funding curve", async () => {
    await lab.publishFundingLevel(1, 2.85, 500);
    await lab.publishFundingLevel(2, 3.10, 500);
    await lab.publishFundingLevel(3, 3.35, 300);
    await lab.approveInvestor();
  });
  await step(lab, "2. The investor requests 100 units at the 2Y level", () => lab.requestTrade(2, 100));
  await step(lab, "3. The issuer incepts the final terms", () => lab.inceptTrade());
  await step(lab, "4. The investor confirms; infrastructure participants take over", () => lab.confirmTrade());
  await step(lab, "5. The investor locks only EUR 90,000 (wrong amount)", () => lab.lockIssuanceCash(90_000));
  await step(lab, "6. The investor aborts and gets the cash back, then retries", async () => {
    await lab.abortIssuance();
    await lab.retryIssuance();
  });
  await step(lab, "7. The investor locks the correct EUR 100,000", () => lab.lockIssuanceCash());
  for (const period of [1, 2]) {
    await step(lab, `${7 + period}. Coupon ${period}`, async () => {
      await lab.advanceToNextCoupon();
      await lab.payCoupon();
    });
  }
  await step(lab, "10. Redemption at maturity", async () => {
    await lab.advanceToMaturity();
    await lab.requestRedemption();
  });

  const state = await lab.state();
  console.log("\n=== Result ===");
  console.log(`  Bond ${state.instance.isin}: ${state.instance.state}, units outstanding ${state.instance.token.totalSupply}`);
  console.log(`  Cash: issuer EUR ${state.cash.issuer.toLocaleString("en-GB")}, investor EUR ${state.cash.investor.toLocaleString("en-GB")}, still locked EUR ${state.cash.locked}`);
  await lab.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
