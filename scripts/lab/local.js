// Starts the lab on two separate in-memory ledgers: asset chain 7101, payment chain 7102.
const { startLedger } = require("../lib/crosschain-scenario");
const { SmartBondLab } = require("./lab");

async function createLocalLab() {
  const asset = await startLedger(7101, 6);
  const payment = await startLedger(7102, 6);
  const lab = await SmartBondLab.create({ asset, payment });
  lab.close = async () => {
    await asset.raw.disconnect();
    await payment.raw.disconnect();
  };
  return lab;
}

module.exports = { createLocalLab };
