const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const runtimeTemp = process.env.DEMO_TMP_DIR || path.join(__dirname, "..", ".runtime-tmp");
fs.mkdirSync(runtimeTemp, { recursive: true });
process.env.TMPDIR = runtimeTemp;

const ganache = require("ganache");
const { ethers } = require("ethers");
const bondArtifact = require("../artifacts/contracts/TokenizedBond.sol/TokenizedBond.json");
const cashArtifact = require("../artifacts/contracts/TokenisedEuro.sol/TokenisedEuro.json");
const dvpArtifact = require("../artifacts/contracts/DvPSettlement.sol/DvPSettlement.json");
const lockingArtifact = require("../artifacts/contracts/AssetLockingContract.sol/AssetLockingContract.json");
const paymentArtifact = require("../artifacts/contracts/PaymentDecryptionContract.sol/PaymentDecryptionContract.json");
const { CrossChainScenario } = require("./lib/crosschain-scenario");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DAY = 24 * 60 * 60;
const SESSION_TTL = Number(process.env.SESSION_MINUTES || 30) * 60 * 1000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 12);
const sessions = new Map();
const INITIAL_CASH_EUR = 5_000;
const TRADE_STATUS = ["NONE", "PROPOSED", "CONFIRMED", "SETTLED", "FAILED", "CANCELLED"];
const FAILURE_REASON = [
  null,
  "Seller not whitelisted",
  "Buyer not whitelisted",
  "Seller has insufficient bonds",
  "Seller has not authorised the bonds",
  "Buyer has insufficient cash",
  "Buyer has not authorised the cash",
];

const DEFAULT_CONFIG = Object.freeze({
  name: "Demo Digital Bond 2027",
  symbol: "DDB27",
  faceValue: "1",
  couponPercent: 5,
  couponIntervalDays: 90,
  maturityYears: 1,
});

function normalizeConfig(input = {}) {
  const name = String(input.name || "").trim();
  const symbol = String(input.symbol || "").trim().toUpperCase();
  const faceValue = Number(input.faceValue);
  const couponPercent = Number(input.couponPercent);
  const couponIntervalDays = Number(input.couponIntervalDays);
  const maturityYears = Number(input.maturityYears);

  if (name.length < 3 || name.length > 64) throw new Error("Bond name must contain 3 to 64 characters.");
  if (!/^[A-Z0-9]{2,8}$/.test(symbol)) throw new Error("Symbol must contain 2 to 8 letters or numbers.");
  if (!Number.isFinite(faceValue) || faceValue <= 0 || faceValue > 1_000_000) throw new Error("Face value must be between 0 and 1,000,000.");
  if (!Number.isFinite(couponPercent) || couponPercent < 0 || couponPercent > 20) throw new Error("Annual coupon must be between 0% and 20%.");
  if (![30, 90, 180, 365].includes(couponIntervalDays)) throw new Error("Select a supported coupon frequency.");
  if (![1, 2, 3, 5].includes(maturityYears)) throw new Error("Select a supported maturity.");

  return { name, symbol, faceValue: String(faceValue), couponPercent, couponIntervalDays, maturityYears };
}

function addActivity(context, kind, message, txHash = null) {
  context.activity.unshift({ kind, message, txHash, at: new Date().toISOString() });
  context.activity = context.activity.slice(0, 40);
}

function toCents(eur) {
  return BigInt(Math.round(Number(eur) * 100));
}

function formatEur(cents) {
  return ethers.formatUnits(cents, 2);
}

function eurText(cents) {
  return Number(formatEur(cents)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function tradeById(context, id) {
  const tradeId = Number(id);
  if (!Number.isInteger(tradeId) || tradeId <= 0) throw new Error("Unknown trade.");
  const trade = await context.dvp.trades(tradeId);
  if (trade.status === 0n) throw new Error("Unknown trade.");
  return { tradeId, trade };
}

function actorByAddress(context, address) {
  return Object.entries(context.actors).find(([, value]) => value.address === address);
}

function actor(context, name) {
  const selected = context.actors[name];
  if (!selected) throw new Error(`Unknown participant: ${name}`);
  return selected;
}

async function closeLedger(context) {
  if (context.cross) await context.cross.close();
  if (context.rawProvider && typeof context.rawProvider.disconnect === "function") {
    await context.rawProvider.disconnect();
  }
}

async function initializeLedger(context, config) {
  await closeLedger(context);
  context.currentConfig = config;
  context.activity = [];
  context.payments = { alice: { coupon: 0n, principal: 0n }, bob: { coupon: 0n, principal: 0n } };
  context.rawProvider = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 4, defaultBalance: 10_000 },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000 },
  });
  // cacheTimeout -1: never reuse a cached (e.g. failed) gas estimate after state changes.
  context.provider = new ethers.BrowserProvider(context.rawProvider, undefined, { cacheTimeout: -1 });
  const signers = await Promise.all([0, 1, 2, 3].map((index) => context.provider.getSigner(index)));
  context.actors = {
    issuer: { label: "Issuer Treasury", signer: signers[0] },
    alice: { label: "Investor Alice", signer: signers[1] },
    bob: { label: "Investor Bob", signer: signers[2] },
    cashBank: { label: "Settlement bank", signer: signers[3] },
  };

  for (const value of Object.values(context.actors)) value.address = await value.signer.getAddress();
  const latest = await context.provider.getBlock("latest");
  const maturityDate = latest.timestamp + (config.maturityYears * 365 + 1) * DAY;
  const factory = new ethers.ContractFactory(bondArtifact.abi, bondArtifact.bytecode, signers[0]);
  context.bond = await factory.deploy(
    config.name,
    config.symbol,
    ethers.parseEther(config.faceValue),
    Math.round(config.couponPercent * 100),
    config.couponIntervalDays * DAY,
    maturityDate
  );
  await context.bond.waitForDeployment();

  const cashFactory = new ethers.ContractFactory(cashArtifact.abi, cashArtifact.bytecode, signers[3]);
  context.cash = await cashFactory.deploy();
  await context.cash.waitForDeployment();
  const dvpFactory = new ethers.ContractFactory(dvpArtifact.abi, dvpArtifact.bytecode, signers[0]);
  context.dvp = await dvpFactory.deploy(await context.bond.getAddress(), await context.cash.getAddress());
  await context.dvp.waitForDeployment();
  for (const name of ["alice", "bob"]) {
    const tx = await context.cash.mint(await context.actors[name].signer.getAddress(), toCents(INITIAL_CASH_EUR));
    await tx.wait();
  }

  addActivity(context, "system", `${config.name} (${config.symbol}) was deployed on this private demo ledger.`);
  addActivity(context, "system", `The settlement bank credited EUR ${INITIAL_CASH_EUR.toLocaleString("en-GB")} in tokenised euro to Alice and Bob.`);
}

async function createSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (oldest) {
      sessions.delete(oldest.id);
      await closeLedger(oldest);
    }
  }
  const context = {
    id: crypto.randomUUID(),
    lastAccess: Date.now(),
    queue: Promise.resolve(),
    currentConfig: { ...DEFAULT_CONFIG },
    rawProvider: null,
  };
  await initializeLedger(context, context.currentConfig);
  context.cross = await CrossChainScenario.create();
  sessions.set(context.id, context);
  return context;
}

function sessionIdFrom(request) {
  const cookies = String(request.headers.cookie || "").split(";");
  const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith("dbond_session="));
  const value = entry ? entry.slice("dbond_session=".length) : "";
  return /^[0-9a-f-]{36}$/.test(value) ? value : null;
}

async function getSession(request) {
  const id = sessionIdFrom(request);
  let context = id ? sessions.get(id) : null;
  const isNew = !context;
  if (!context) context = await createSession();
  context.lastAccess = Date.now();
  return { context, isNew };
}

async function state(context) {
  const bond = context.bond;
  const block = await context.provider.getBlock("latest");
  const totalSupply = await bond.totalSupply();
  const maturityDate = Number(await bond.maturityDate());
  const nextCouponDate = Number(await bond.nextCouponDate());
  const redemptionFunded = await bond.redemptionFunded();
  const accounts = {};

  for (const name of ["alice", "bob"]) {
    const selected = context.actors[name];
    accounts[name] = {
      label: selected.label,
      address: await selected.signer.getAddress(),
      whitelisted: await bond.isWhitelisted(await selected.signer.getAddress()),
      units: Number(await bond.balanceOf(await selected.signer.getAddress())),
      cash: formatEur(await context.cash.balanceOf(await selected.signer.getAddress())),
      couponReceived: ethers.formatEther(context.payments[name].coupon),
      principalReceived: ethers.formatEther(context.payments[name].principal),
    };
  }

  let phase = "ISSUANCE";
  if (block.timestamp >= maturityDate) phase = redemptionFunded ? "REDEMPTION" : "MATURED";
  else if (block.timestamp >= nextCouponDate) phase = "COUPON_DUE";
  else if (totalSupply > 0n) phase = "ACTIVE";
  if (redemptionFunded && totalSupply === 0n) phase = "CLOSED";

  const trades = [];
  const tradeCount = Number(await context.dvp.tradeCount());
  for (let id = tradeCount; id >= 1 && trades.length < 12; id -= 1) {
    const trade = await context.dvp.trades(id);
    const status = TRADE_STATUS[Number(trade.status)];
    const seller = actorByAddress(context, trade.seller);
    const buyer = actorByAddress(context, trade.buyer);
    const check = status === "CONFIRMED" ? FAILURE_REASON[Number(await context.dvp.checkSettlement(id))] : null;
    trades.push({
      id,
      seller: seller ? seller[0] : trade.seller,
      buyer: buyer ? buyer[0] : trade.buyer,
      units: Number(trade.units),
      cash: formatEur(trade.cashAmount),
      status,
      failureReason: FAILURE_REASON[Number(trade.failureReason)],
      bondsAuthorised: (await bond.allowance(trade.seller, await context.dvp.getAddress())) >= trade.units,
      cashAuthorised: (await context.cash.allowance(trade.buyer, await context.dvp.getAddress())) >= trade.cashAmount,
      preCheck: check,
    });
  }

  return {
    contractAddress: await bond.getAddress(),
    dvpAddress: await context.dvp.getAddress(),
    cashAddress: await context.cash.getAddress(),
    trades,
    phase,
    blockTime: block.timestamp,
    terms: {
      name: await bond.name(),
      symbol: await bond.symbol(),
      faceValue: ethers.formatEther(await bond.faceValue()),
      annualCouponPercent: Number(await bond.annualCouponRateBps()) / 100,
      couponPerUnit: ethers.formatEther(await bond.couponPerUnit()),
      couponIntervalDays: context.currentConfig.couponIntervalDays,
      maturityYears: context.currentConfig.maturityYears,
      nextCouponDate,
      maturityDate,
    },
    totalSupply: Number(totalSupply),
    couponsPaid: Number(await bond.couponsPaid()),
    redemptionFunded,
    accounts,
    activity: context.activity,
  };
}

async function advanceTime(context, targetTimestamp) {
  const block = await context.provider.getBlock("latest");
  if (block.timestamp < targetTimestamp) {
    await context.provider.send("evm_increaseTime", [targetTimestamp - block.timestamp]);
    await context.provider.send("evm_mine", []);
  }
}

async function transact(context, action, params = {}) {
  const bond = context.bond;
  let tx;
  switch (action) {
    case "reset":
      await initializeLedger(context, context.currentConfig);
      return;
    case "configure":
      await initializeLedger(context, normalizeConfig(params));
      return;
    case "whitelist": {
      const investor = actor(context, params.investor);
      tx = await bond.connect(context.actors.issuer.signer).setWhitelisted(await investor.signer.getAddress(), true);
      await tx.wait();
      addActivity(context, "compliance", `${investor.label} passed the simulated KYC whitelist check.`, tx.hash);
      return;
    }
    case "issue": {
      const investor = actor(context, params.investor);
      const units = Number(params.units);
      if (!Number.isInteger(units) || units <= 0 || units > 1000) throw new Error("Units must be an integer between 1 and 1,000.");
      tx = await bond.connect(context.actors.issuer.signer).issue(await investor.signer.getAddress(), units);
      await tx.wait();
      addActivity(context, "issuance", `Issuer allocated ${units} bond unit${units === 1 ? "" : "s"} to ${investor.label}.`, tx.hash);
      return;
    }
    case "transfer": {
      const from = actor(context, params.from);
      const to = actor(context, params.to);
      const units = Number(params.units);
      if (from === to) throw new Error("Choose two different investors.");
      if (!Number.isInteger(units) || units <= 0) throw new Error("Enter a positive whole number of units.");
      tx = await bond.connect(from.signer).transfer(await to.signer.getAddress(), units);
      await tx.wait();
      addActivity(context, "transfer", `${from.label} transferred ${units} unit${units === 1 ? "" : "s"} to ${to.label}.`, tx.hash);
      return;
    }
    case "proposeTrade": {
      const seller = actor(context, params.seller);
      const buyer = actor(context, params.buyer);
      const units = Number(params.units);
      const price = Number(params.price);
      if (seller === buyer) throw new Error("Choose two different investors.");
      if (!Number.isInteger(units) || units <= 0 || units > 1000) throw new Error("Units must be an integer between 1 and 1,000.");
      if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw new Error("Price must be between EUR 0.01 and EUR 1,000,000.");
      tx = await context.dvp.connect(seller.signer).proposeTrade(buyer.address, units, toCents(price));
      await tx.wait();
      const id = Number(await context.dvp.tradeCount());
      addActivity(context, "trade", `Trade #${id}: ${seller.label} proposed to sell ${units} unit${units === 1 ? "" : "s"} to ${buyer.label} for EUR ${price.toLocaleString("en-GB")}.`, tx.hash);
      return;
    }
    case "confirmTrade": {
      const { tradeId, trade } = await tradeById(context, params.id);
      const [, buyer] = actorByAddress(context, trade.buyer);
      tx = await context.dvp.connect(buyer.signer).confirmTrade(tradeId, trade.units, trade.cashAmount);
      await tx.wait();
      addActivity(context, "trade", `Trade #${tradeId}: ${buyer.label} confirmed the same terms.`, tx.hash);
      return;
    }
    case "authoriseBonds": {
      const { tradeId, trade } = await tradeById(context, params.id);
      const [, seller] = actorByAddress(context, trade.seller);
      tx = await bond.connect(seller.signer).approve(await context.dvp.getAddress(), trade.units);
      await tx.wait();
      addActivity(context, "trade", `Trade #${tradeId}: ${seller.label} authorised the DvP contract to deliver ${trade.units} unit(s).`, tx.hash);
      return;
    }
    case "authoriseCash": {
      const { tradeId, trade } = await tradeById(context, params.id);
      const [, buyer] = actorByAddress(context, trade.buyer);
      tx = await context.cash.connect(buyer.signer).approve(await context.dvp.getAddress(), trade.cashAmount);
      await tx.wait();
      addActivity(context, "trade", `Trade #${tradeId}: ${buyer.label} authorised the DvP contract to pay EUR ${eurText(trade.cashAmount)}.`, tx.hash);
      return;
    }
    case "settleTrade": {
      const { tradeId, trade } = await tradeById(context, params.id);
      const [, seller] = actorByAddress(context, trade.seller);
      tx = await context.dvp.connect(seller.signer).settle(tradeId);
      await tx.wait();
      const after = await context.dvp.trades(tradeId);
      if (after.status === 3n) {
        addActivity(context, "settlement", `Trade #${tradeId} settled atomically: ${trade.units} unit(s) against EUR ${eurText(trade.cashAmount)}.`, tx.hash);
      } else {
        addActivity(context, "failure", `Trade #${tradeId} failed and was recorded: ${FAILURE_REASON[Number(after.failureReason)]}. No bonds or cash moved.`, tx.hash);
      }
      return;
    }
    case "cancelTrade": {
      const { tradeId, trade } = await tradeById(context, params.id);
      const [, seller] = actorByAddress(context, trade.seller);
      tx = await context.dvp.connect(seller.signer).cancelTrade(tradeId);
      await tx.wait();
      addActivity(context, "trade", `Trade #${tradeId} was cancelled before confirmation.`, tx.hash);
      return;
    }
    case "advanceCoupon": {
      const current = await state(context);
      if (current.terms.nextCouponDate >= current.terms.maturityDate) throw new Error("No coupon date remains before maturity.");
      await advanceTime(context, current.terms.nextCouponDate);
      addActivity(context, "time", "The demo clock advanced to the next coupon date.");
      return;
    }
    case "payCoupon": {
      const perUnit = await bond.couponPerUnit();
      const balances = {};
      let total = 0n;
      for (const name of ["alice", "bob"]) {
        balances[name] = await bond.balanceOf(await context.actors[name].signer.getAddress());
        total += balances[name];
      }
      const payment = perUnit * total;
      tx = await bond.connect(context.actors.issuer.signer).payCoupon({ value: payment });
      await tx.wait();
      for (const name of ["alice", "bob"]) context.payments[name].coupon += perUnit * balances[name];
      addActivity(context, "payment", `Issuer distributed ${ethers.formatEther(payment)} test-currency units as coupon.`, tx.hash);
      return;
    }
    case "advanceMaturity": {
      const current = await state(context);
      await advanceTime(context, current.terms.maturityDate);
      addActivity(context, "time", "The demo clock advanced to the bond maturity date.");
      return;
    }
    case "fundRedemption": {
      const payment = (await bond.faceValue()) * (await bond.totalSupply());
      tx = await bond.connect(context.actors.issuer.signer).fundRedemption({ value: payment });
      await tx.wait();
      addActivity(context, "payment", `Issuer funded ${ethers.formatEther(payment)} test-currency units for principal redemption.`, tx.hash);
      return;
    }
    case "redeem": {
      const investorName = params.investor;
      const investor = actor(context, investorName);
      const address = await investor.signer.getAddress();
      const units = await bond.balanceOf(address);
      const principal = units * (await bond.faceValue());
      tx = await bond.connect(investor.signer).redeem();
      await tx.wait();
      context.payments[investorName].principal += principal;
      addActivity(context, "redemption", `${investor.label} redeemed ${units} unit${units === 1n ? "" : "s"} for ${ethers.formatEther(principal)} test-currency units.`, tx.hash);
      return;
    }
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

const contractInterfaces = [bondArtifact, cashArtifact, dvpArtifact, lockingArtifact, paymentArtifact].map((artifact) => new ethers.Interface(artifact.abi));

// Ganache nests revert data where ethers does not look, so decode custom errors here.
function revertReason(error) {
  const data = error?.data || error?.info?.error?.data?.result;
  if (typeof data !== "string" || data.length < 10) return null;
  for (const contractInterface of contractInterfaces) {
    try {
      const parsed = contractInterface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      // Not an error of this contract; try the next one.
    }
  }
  return null;
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(response, status, body, sessionCookie = null) {
  const headers = securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (sessionCookie) headers["Set-Cookie"] = `dbond_session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) reject(new Error("Request too large."));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON request.")); }
    });
    request.on("error", reject);
  });
}

function serveFile(requestPath, response) {
  const routes = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
  const filename = routes[requestPath];
  if (!filename) {
    response.writeHead(404, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    response.end("Not found");
    return;
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  response.writeHead(200, securityHeaders({
    "Content-Type": `${types[path.extname(filename)]}; charset=utf-8`,
    "Cache-Control": filename === "index.html" ? "no-cache" : "public, max-age=300",
  }));
  fs.createReadStream(path.join(PUBLIC_DIR, filename)).pipe(response);
}

async function handleRequest(request, response) {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, { status: "ok", activeSessions: sessions.size });
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/state") {
      const { context, isNew } = await getSession(request);
      return sendJson(response, 200, await state(context), isNew ? context.id : null);
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/action") {
      const { context, isNew } = await getSession(request);
      const body = await readBody(request);
      context.queue = context.queue.catch(() => {}).then(() => transact(context, body.action, body.params));
      await context.queue;
      return sendJson(response, 200, { ok: true, state: await state(context) }, isNew ? context.id : null);
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/cross/state") {
      const { context, isNew } = await getSession(request);
      return sendJson(response, 200, await context.cross.state(), isNew ? context.id : null);
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/cross/action") {
      const { context, isNew } = await getSession(request);
      const body = await readBody(request);
      const params = body.params || {};
      context.queue = context.queue.catch(() => {}).then(() => (
        body.action === "reset"
          ? context.cross.reset({ units: params.units, priceEur: params.priceEur })
          : context.cross.run(String(body.action), params.option === "cancel" ? "cancel" : "pay")
      ));
      await context.queue;
      return sendJson(response, 200, { ok: true, state: await context.cross.state() }, isNew ? context.id : null);
    }
    if (request.method === "GET") return serveFile(requestUrl.pathname, response);
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = revertReason(error) || error.shortMessage || error.reason || error.message || "Transaction failed.";
    sendJson(response, 400, { error: message.replace(/^VM Exception while processing transaction: /, "") });
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}`;
  console.log(`\nDigital Bond Dashboard is running at ${localUrl}`);
  console.log("Each browser receives an isolated 30-minute demo ledger.");
  console.log("Press Ctrl+C to stop it.\n");
  if (process.platform === "darwin" && !process.env.NO_OPEN) {
    const opener = spawn("open", [localUrl], { detached: true, stdio: "ignore" });
    opener.unref();
  }
});

setInterval(async () => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, context] of sessions.entries()) {
    if (context.lastAccess < cutoff) {
      sessions.delete(id);
      await closeLedger(context);
    }
  }
}, 60_000).unref();

async function shutdown() {
  server.close();
  await Promise.all([...sessions.values()].map(closeLedger));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
