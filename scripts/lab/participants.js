// Event-driven participants of the Smart Bond Lab. There is no central
// orchestrator: every participant watches on-chain events and reacts with its
// own key only. `Network` stands in for each participant running its own node:
// it just delivers new events to everyone.
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { createOracleKeyPair, prepareKey } = require("../lib/erc7573");

const artifact = (name) => require(path.join(__dirname, "..", "..", "artifacts", "contracts", "lab", `${name}.sol`, `${name}.json`));
const legacyArtifact = (name) => require(path.join(__dirname, "..", "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`));
const ABI = {
  Factory: artifact("SmartBondFactory").abi,
  SmartBond: artifact("SmartBondContract").abi,
  BondToken: artifact("BondToken").abi,
  CashLock: artifact("CashLock").abi,
  Cash: legacyArtifact("TokenisedEuro").abi,
};
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };

const STATES = ["IndicationPhase", "TradeIncepted", "DistributionPhase", "IsinAssigned", "Minted", "Issued", "Redeemed", "Cancelled"];
const SETTLEMENT_STATUS = ["None", "KeysRequested", "KeysCommitted", "CashLocked", "SuccessRequested", "FailureRequested", "Succeeded", "Failed"];

const lockIdFor = (bondAddress, settlementId) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [bondAddress, settlementId]));
const eurText = (cents) => `EUR ${Number(ethers.formatUnits(cents, 2)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const same = (a, b) => ethers.getAddress(a) === ethers.getAddress(b);

// ISIN = 2-letter country + 9-character NSIN + Luhn check digit over the digit-expanded string.
function isinCheckDigit(body) {
  const digits = body.split("").map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
const makeIsin = (sequence) => {
  const body = `DE000LAB${String(sequence).padStart(3, "0")}`;
  return body + isinCheckDigit(body);
};

class Network {
  constructor({ asset, payment }) {
    this.chains = { asset, payment }; // { provider }
    this.watched = new Map(); // address -> { chain, contract, iface }
    this.cursors = new Map(); // provider -> last processed block
    this.participants = [];
    this.monitor = [];
  }

  watch(chain, contract, address) {
    this.watched.set(ethers.getAddress(address), { chain, contract, iface: new ethers.Interface(ABI[contract]) });
  }

  join(participant) {
    this.participants.push(participant);
  }

  note(actor, message, txHash = null) {
    this.monitor.push({ seq: this.monitor.length, type: "action", actor, message, txHash, at: new Date().toISOString() });
  }

  async startCursors() {
    for (const provider of new Set(Object.values(this.chains).map((c) => c.provider))) {
      this.cursors.set(provider, await provider.getBlockNumber());
    }
  }

  async fetchNew() {
    const events = [];
    for (const [provider, from] of this.cursors) {
      const latest = await provider.getBlockNumber();
      if (latest <= from) continue;
      const addresses = [...this.watched.keys()];
      const logs = addresses.length ? await provider.getLogs({ fromBlock: from + 1, toBlock: latest, address: addresses }) : [];
      this.cursors.set(provider, latest);
      for (const log of logs) {
        const watched = this.watched.get(ethers.getAddress(log.address));
        if (!watched) continue;
        const parsed = watched.iface.parseLog(log);
        if (!parsed) continue;
        events.push({
          chain: watched.chain,
          contract: watched.contract,
          address: ethers.getAddress(log.address),
          name: parsed.name,
          args: parsed.args,
          params: Object.fromEntries(parsed.fragment.inputs.map((input, i) => [
            input.name,
            parsed.name === "StateChanged" ? `${parsed.args[i]} (${STATES[Number(parsed.args[i])]})` : displayValue(parsed.args[i]),
          ])),
          blockNumber: log.blockNumber,
          logIndex: log.index,
          txHash: log.transactionHash,
        });
      }
    }
    return events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  /** Delivers events until nobody reacts any more. */
  async pump() {
    for (let round = 0; round < 200; round += 1) {
      const events = await this.fetchNew();
      if (!events.length) return;
      for (const event of events) {
        this.monitor.push({ seq: this.monitor.length, type: "event", chain: event.chain, contract: event.contract, address: event.address, name: event.name, summary: summarise(event), params: event.params, blockNumber: event.blockNumber, txHash: event.txHash, at: new Date().toISOString() });
        for (const participant of this.participants) await participant.on(event, this);
      }
    }
    throw new Error("Event loop did not settle.");
  }
}

// Event arguments as short, JSON-safe strings for the monitor.
function displayValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && value.length > 66) return `${value.slice(0, 18)}…(${(value.length - 2) / 2} bytes)`;
  if (typeof value === "string" && value.length > 120) return `${value.slice(0, 117)}…`;
  return value;
}

function summarise(event) {
  const a = event.args;
  const eur = eurText;
  switch (event.name) {
    case "FundingLevelPublished": return `${a.tenorYears}Y at ${(Number(a.couponBps) / 100).toFixed(2)}%, up to ${a.maxUnits} units`;
    case "TradeRequested": return `${a.units} units, ${a.tenorYears}Y, indicative ${(Number(a.indicativeCouponBps) / 100).toFixed(2)}%`;
    case "StateChanged": return STATES[Number(a.newState)];
    case "TradeIncepted": return `terms hash ${a.termsHash.slice(0, 10)}…`;
    case "TradeConfirmed": return `investor confirmed ${a.termsHash.slice(0, 10)}…`;
    case "IsinAssigned": return a.isin;
    case "KeysRequested": return `settlement #${a.settlementId}: ${eur(a.amount)}`;
    case "KeysCommitted": return `settlement #${a.settlementId}: hashes frozen`;
    case "CashLockAttested": return `settlement #${a.settlementId}`;
    case "DecryptionRequested": return `settlement #${a.settlementId}: ${a.success ? "success" : "failure"} key`;
    case "KeyReleased": return `settlement #${a.settlementId}: ${a.success ? "success" : "failure"} key published`;
    case "ObligationDischarged": return `purpose ${a.purpose}: ${eur(a.amount)}`;
    case "SettlementFailed": return `settlement #${a.settlementId}: ${a.reason}`;
    case "CashLocked": return `${eur(a.amount)} locked`;
    case "CashReleased": return `${eur(a.amount)} paid out`;
    case "CashReturned": return `${eur(a.amount)} returned to payer`;
    default: return "";
  }
}

/** Mock of the ISIN numbering agency. */
class IsinAgent {
  constructor(signer) {
    this.label = "ISIN agent";
    this.signer = signer;
    this.sequence = 0;
  }

  async on(event, net) {
    if (event.contract !== "SmartBond" || event.name !== "TradeConfirmed") return;
    const isin = makeIsin(++this.sequence);
    const tx = await new ethers.Contract(event.address, ABI.SmartBond, this.signer).assignIsin(isin);
    await tx.wait();
    net.note(this.label, `Assigned ISIN ${isin} on-chain.`, tx.hash);
  }
}

/** Crypto securities registrar: deploys and mints the token. */
class Registrar {
  constructor(signer) {
    this.label = "Registrar";
    this.signer = signer;
  }

  async on(event, net) {
    if (event.contract !== "SmartBond" || event.name !== "IsinAssigned") return;
    const bond = new ethers.Contract(event.address, ABI.SmartBond, this.signer);
    const [issuer, investor, units, tenor] = await Promise.all([bond.issuer(), bond.investor(), bond.units(), bond.tenorYears()]);
    const factory = new ethers.ContractFactory(ABI.BondToken, artifact("BondToken").bytecode, this.signer);
    const token = await factory.deploy(`Demo Treasury Bond ${tenor}Y`, `DTB${tenor}Y`, event.args.isin, event.address);
    await token.waitForDeployment();
    for (const holder of [issuer, investor]) await (await token.setEligible(holder, true)).wait();
    await (await token.mint(issuer, units)).wait();
    const tx = await bond.registerToken(await token.getAddress());
    await tx.wait();
    net.note(this.label, `Deployed the token for ${event.args.isin}, registered issuer and investor as eligible, minted ${units} units to the issuer.`, tx.hash);
  }
}

/**
 * Stateless decryption oracle. It generates
 * both keys per settlement and forgets the plaintexts; later it decrypts only
 * the key a Smart Bond Contract asks for, after checking that the key names
 * that very contract, settlement, payee, amount and outcome.
 */
class DecryptionOracle {
  constructor(signer, cashLockAddress, keyPair = createOracleKeyPair()) {
    this.label = "Decryption oracle";
    this.signer = signer;
    this.cashLockAddress = cashLockAddress;
    this.keyPair = keyPair;
  }

  async on(event, net) {
    if (event.contract !== "SmartBond") return;
    const bond = new ethers.Contract(event.address, ABI.SmartBond, this.signer);
    if (event.name === "KeysRequested") {
      const { settlementId, payee, amount } = event.args;
      const terms = { oraclePublicKey: this.keyPair.publicKey, contract: event.address, id: settlementId, paymentContract: this.cashLockAddress, payee, amount };
      const success = prepareKey({ ...terms, outcome: "success" });
      const failure = prepareKey({ ...terms, outcome: "failure" });
      const tx = await bond.commitKeys(settlementId, success.hash, success.encrypted, failure.hash, failure.encrypted);
      await tx.wait();
      net.note(this.label, `Generated success and failure keys for settlement #${settlementId}; published hashes and encryptions; kept no plaintext.`, tx.hash);
    }
    if (event.name === "DecryptionRequested") {
      const key = this.decrypt(event);
      const tx = await bond.publishKey(event.args.settlementId, key);
      await tx.wait();
      net.note(this.label, `Decrypted and published the ${event.args.success ? "success" : "failure"} key for settlement #${event.args.settlementId}.`, tx.hash);
    }
  }

  decrypt(event) {
    const { settlementId, success, payee, amount, encryptedKey } = event.args;
    const plaintext = crypto.privateDecrypt({ key: this.keyPair.privateKey, ...OAEP }, Buffer.from(ethers.getBytes(encryptedKey)));
    const doc = JSON.parse(plaintext.toString("utf8"));
    if (!same(doc.contract, event.address)) throw new Error("Oracle refused: key names another contract");
    if (doc.id !== String(settlementId)) throw new Error("Oracle refused: key is for another settlement");
    if (!same(doc.payee, payee) || doc.amount !== String(amount)) throw new Error("Oracle refused: terms differ from the key");
    if (doc.outcome !== (success ? "success" : "failure")) throw new Error("Oracle refused: wrong outcome");
    return plaintext;
  }
}

/**
 * A party's own connector (issuer or investor). It holds that party's keys and
 * automates what the party has decided in advance:
 * - as payee: verify the payer's cash lock on the payment ledger, attest it, settle;
 * - as payer of coupons/principal (issuer, if autoLockCash): lock the cash;
 * - claim or recover cash with whichever key the oracle released.
 */
class PartyConnector {
  constructor({ label, assetSigner, paymentSigner, cashLock, cash, autoLockCash = false }) {
    this.label = label;
    this.assetSigner = assetSigner;
    this.paymentSigner = paymentSigner;
    this.cashLock = cashLock.connect(paymentSigner);
    this.cash = cash.connect(paymentSigner);
    this.autoLockCash = autoLockCash;
    this.expectedIncoming = new Map(); // lockId -> settlement we are payee of
  }

  async address() {
    return this.assetSigner.getAddress();
  }

  async on(event, net) {
    const me = await this.address();
    if (event.contract === "SmartBond") {
      const bond = new ethers.Contract(event.address, ABI.SmartBond, this.assetSigner);

      if (event.name === "TokenRegistered" && same(await bond.issuer(), me)) {
        const token = new ethers.Contract(event.args.token, ABI.BondToken, this.assetSigner);
        const tx = await token.approve(event.address, event.args.units);
        await tx.wait();
        net.note(this.label, `Authorised the Smart Bond Contract to deliver ${event.args.units} units at settlement.`, tx.hash);
      }

      if (event.name === "KeysCommitted") {
        const s = await bond.settlements(event.args.settlementId);
        const lockId = lockIdFor(event.address, event.args.settlementId);
        if (same(s.payee, me)) {
          this.expectedIncoming.set(lockId, { bond: event.address, id: event.args.settlementId, s });
        }
        if (same(s.payer, me) && this.autoLockCash && Number(s.purpose) !== 0) {
          await (await this.cash.approve(await this.cashLock.getAddress(), s.amount)).wait();
          const tx = await this.cashLock.lock(lockId, s.payee, s.amount, s.hashSuccess, s.hashFailure);
          await tx.wait();
          net.note(this.label, `Locked ${eurText(s.amount)} on the payment ledger for settlement #${event.args.settlementId} (automated).`, tx.hash);
        }
      }

      if (event.name === "KeyReleased") {
        const s = await bond.settlements(event.args.settlementId);
        const mine = event.args.success ? same(s.payee, me) : same(s.payer, me);
        const lockId = lockIdFor(event.address, event.args.settlementId);
        const lock = await this.cashLock.locks(lockId);
        if (mine && Number(lock.status) === 1) {
          const tx = await this.cashLock.releaseWithKey(lockId, event.args.key);
          await tx.wait();
          net.note(this.label, event.args.success
            ? `Presented the success key on the payment ledger and received ${eurText(lock.amount)}.`
            : `Presented the failure key and recovered the locked ${eurText(lock.amount)}.`, tx.hash);
        }
      }
    }

    if (event.contract === "CashLock" && event.name === "CashLocked" && same(event.args.payee, me)) {
      const expected = this.expectedIncoming.get(event.args.lockId);
      if (!expected) {
        net.note(this.label, "Ignored a cash lock that matches none of our open settlements.");
        return;
      }
      const { s } = expected;
      const problems = [];
      if (!same(event.args.payer, s.payer)) problems.push("wrong payer");
      if (event.args.amount !== s.amount) problems.push(`amount ${eurText(event.args.amount)} instead of ${eurText(s.amount)}`);
      if (event.args.hashSuccess !== s.hashSuccess || event.args.hashFailure !== s.hashFailure) problems.push("hashes differ from the bond's commitment");
      if (problems.length) {
        net.note(this.label, `Refused to attest the cash lock for settlement #${expected.id}: ${problems.join(", ")}. Nothing is delivered; the payer can abort to recover the cash.`);
        return;
      }
      const bond = new ethers.Contract(expected.bond, ABI.SmartBond, this.assetSigner);
      if (Number(s.purpose) === Number(await bond.couponCount()) + 1) {
        const token = new ethers.Contract(await bond.token(), ABI.BondToken, this.assetSigner);
        await (await token.approve(expected.bond, await bond.units())).wait();
      }
      await (await bond.attestCashLock(expected.id, event.args.lockId)).wait();
      const tx = await bond.settle(expected.id);
      await tx.wait();
      this.expectedIncoming.delete(event.args.lockId);
      net.note(this.label, `Verified the cash lock on the payment ledger, attested it and triggered settlement #${expected.id}.`, tx.hash);
    }
  }
}

module.exports = {
  ABI, STATES, SETTLEMENT_STATUS, artifact, legacyArtifact, lockIdFor, makeIsin, isinCheckDigit,
  Network, IsinAgent, Registrar, DecryptionOracle, PartyConnector,
};
