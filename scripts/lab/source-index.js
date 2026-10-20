// Extracts real code excerpts (with line numbers) for the walkthrough page.
// Only snippets registered below can be requested, so no arbitrary file is read.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FILES = {
  Factory: "contracts/lab/SmartBondFactory.sol",
  Bond: "contracts/lab/SmartBondContract.sol",
  Token: "contracts/lab/BondToken.sol",
  CashLock: "contracts/lab/CashLock.sol",
  participants: "scripts/lab/participants.js",
  lab: "scripts/lab/lab.js",
};

// id -> [file key, symbol]
const SNIPPETS = {
  "Factory.publishFundingLevel": ["Factory", "publishFundingLevel"],
  "Factory.setEligibleInvestor": ["Factory", "setEligibleInvestor"],
  "Factory.requestTrade": ["Factory", "requestTrade"],
  "Bond.constructor": ["Bond", "constructor"],
  "Bond.inceptTrade": ["Bond", "inceptTrade"],
  "Bond.confirmTrade": ["Bond", "confirmTrade"],
  "Bond.assignIsin": ["Bond", "assignIsin"],
  "Bond.registerToken": ["Bond", "registerToken"],
  "Bond.commitKeys": ["Bond", "commitKeys"],
  "Bond.attestCashLock": ["Bond", "attestCashLock"],
  "Bond.settle": ["Bond", "settle"],
  "Bond.abort": ["Bond", "abort"],
  "Bond.publishKey": ["Bond", "publishKey"],
  "Bond.retrySettlement": ["Bond", "retrySettlement"],
  "Bond.couponAmount": ["Bond", "couponAmount"],
  "Bond.openCouponSettlement": ["Bond", "openCouponSettlement"],
  "Bond.requestRedemption": ["Bond", "requestRedemption"],
  "Bond._openSettlement": ["Bond", "_openSettlement"],
  "Bond._requestKey": ["Bond", "_requestKey"],
  "Token.mint": ["Token", "mint"],
  "Token.transferFrom": ["Token", "transferFrom"],
  "Token.burn": ["Token", "burn"],
  "CashLock.lock": ["CashLock", "lock"],
  "CashLock.releaseWithKey": ["CashLock", "releaseWithKey"],
  "js.IsinAgent": ["participants", "IsinAgent"],
  "js.Registrar": ["participants", "Registrar"],
  "js.DecryptionOracle": ["participants", "DecryptionOracle"],
  "js.PartyConnector": ["participants", "PartyConnector"],
  "js.Network.pump": ["participants", "pump"],
  "js.buildTerms": ["lab", "buildTerms"],
  "js.verifyTerms": ["lab", "verifyTerms"],
};

const cache = new Map();

function lines(fileKey) {
  if (!cache.has(fileKey)) cache.set(fileKey, fs.readFileSync(path.join(ROOT, FILES[fileKey]), "utf8").split("\n"));
  return cache.get(fileKey);
}

function findStart(source, symbol, isSolidity) {
  const escaped = symbol.replace(/[$]/g, "\\$");
  const patterns = isSolidity
    ? [symbol === "constructor" ? /^\s*constructor\s*\(/ : new RegExp(`^\\s*function\\s+${escaped}\\s*\\(`)]
    : [new RegExp(`^\\s*class\\s+${escaped}\\b`), new RegExp(`^\\s*(async\\s+)?function\\s+${escaped}\\s*\\(`), new RegExp(`^\\s*(async\\s+)?${escaped}\\s*\\(`)];
  for (const pattern of patterns) {
    const index = source.findIndex((line) => pattern.test(line));
    if (index >= 0) return index;
  }
  return -1;
}

/** Includes the doc comment directly above, then everything up to the matching closing brace. */
function extract(id) {
  const entry = SNIPPETS[id];
  if (!entry) return null;
  const [fileKey, symbol] = entry;
  const source = lines(fileKey);
  const isSolidity = FILES[fileKey].endsWith(".sol");
  let start = findStart(source, symbol, isSolidity);
  if (start < 0) return null;

  let end = start;
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i += 1) {
    for (const ch of source[i].replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "")) {
      if (ch === "{") { depth += 1; opened = true; }
      if (ch === "}") depth -= 1;
    }
    if (opened && depth <= 0) { end = i; break; }
    if (!opened && /;\s*$/.test(source[i])) { end = i; break; }
  }

  let docStart = start;
  while (docStart > 0 && /^\s*(\/\/|\/\*\*|\*|\*\/)/.test(source[docStart - 1])) docStart -= 1;

  return {
    id,
    file: FILES[fileKey],
    startLine: docStart + 1,
    endLine: end + 1,
    language: isSolidity ? "solidity" : "javascript",
    code: source.slice(docStart, end + 1).join("\n"),
  };
}

module.exports = { extract, SNIPPETS, FILES };
