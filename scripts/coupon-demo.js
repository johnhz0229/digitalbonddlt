// Coupon "payment versus discharge" on two separate in-memory ledgers.
// Usage: npm run coupon
const path = require("path");
const fs = require("fs");

const runtimeTemp = process.env.DEMO_TMP_DIR || path.join(__dirname, "..", ".runtime-tmp");
fs.mkdirSync(runtimeTemp, { recursive: true });
process.env.TMPDIR = runtimeTemp;

const { CouponScenario, STEPS } = require("./lib/coupon-scenario");

const LABEL = { asset: "ASSET CHAIN  ", payment: "PAYMENT CHAIN", "off-chain": "OFF-CHAIN    " };

async function status(scenario) {
  const state = await scenario.state();
  console.log(`      bond claim: ${state.bond.claimStatus} (attempt ${state.bond.attemptId ?? "—"}: ${state.bond.attemptStatus}) | payment: ${state.payment.status} | Alice EUR ${state.payment.aliceEur}`);
}

async function runAttempt(scenario, option) {
  for (let index = scenario.step; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    const before = scenario.log.length;
    await scenario.run(step.id, option);
    console.log(`\n  [${LABEL[step.chain]}] ${step.title}`);
    scenario.log.slice(before).forEach((entry) => console.log(`      ${entry.message}`));
    if (["execute", "forward"].includes(step.id)) await status(scenario);
  }
}

(async () => {
  console.log("\n=== 1. Coupon paid: the claim is discharged only when the bond accepts the success key ===");
  let scenario = await CouponScenario.create();
  scenario.log.forEach((entry) => console.log(`  ${entry.message}`));
  await runAttempt(scenario, "pay");
  await scenario.run("reforward");
  console.log(`\n  ${scenario.log[scenario.log.length - 1].message}`);
  await status(scenario);
  await scenario.close();

  console.log("\n=== 2. Payment fails, the claim survives, a second attempt succeeds ===");
  scenario = await CouponScenario.create();
  await runAttempt(scenario, "fail");
  await scenario.run("retry");
  console.log(`\n  ${scenario.log[scenario.log.length - 1].message}`);
  await runAttempt(scenario, "pay");
  await scenario.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
