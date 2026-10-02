// Runs the ERC-7573-style cross-chain DvP on two separate in-memory ledgers
// and prints every step. Usage: npm run crosschain
const path = require("path");
const fs = require("fs");

const runtimeTemp = process.env.DEMO_TMP_DIR || path.join(__dirname, "..", ".runtime-tmp");
fs.mkdirSync(runtimeTemp, { recursive: true });
process.env.TMPDIR = runtimeTemp;

const { CrossChainScenario, STEPS } = require("./lib/crosschain-scenario");

const LABEL = { asset: "ASSET CHAIN  ", payment: "PAYMENT CHAIN", "off-chain": "OFF-CHAIN    " };

async function balances(scenario) {
  const state = await scenario.state();
  const { bonds } = state.asset;
  const { eur } = state.payment;
  console.log(`      bonds  Alice ${bonds.alice} | Bob ${bonds.bob} | locked ${bonds.locked}`);
  console.log(`      EUR    Alice ${eur.alice} | Bob ${eur.bob}`);
}

async function run(title, { priceEur, option }) {
  console.log(`\n=== ${title} ===`);
  const scenario = await CrossChainScenario.create();
  await scenario.reset({ units: 10, priceEur });
  scenario.log.forEach((entry) => console.log(`  ${entry.message}`));
  await balances(scenario);

  for (const step of STEPS) {
    const before = scenario.log.length;
    await scenario.run(step.id, option);
    console.log(`\n  [${LABEL[step.chain]}] ${step.title}`);
    scenario.log.slice(before).forEach((entry) => console.log(`      ${entry.message}`));
  }
  console.log("\n  Final balances:");
  await balances(scenario);
  await scenario.close();
}

(async () => {
  await run("1. Success: Bob pays EUR 1,000 and receives 10 bonds", { priceEur: 1_000, option: "pay" });
  await run("2. Failure: price EUR 9,000, Bob only holds EUR 5,000", { priceEur: 9_000, option: "pay" });
  await run("3. Cancellation: Alice cancels before Bob pays", { priceEur: 1_000, option: "cancel" });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
