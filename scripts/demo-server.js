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

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DAY = 24 * 60 * 60;
const SESSION_TTL = Number(process.env.SESSION_MINUTES || 30) * 60 * 1000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 12);
const sessions = new Map();

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

function actor(context, name) {
  const selected = context.actors[name];
  if (!selected) throw new Error(`Unknown participant: ${name}`);
  return selected;
}

async function closeLedger(context) {
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
    wallet: { totalAccounts: 3, defaultBalance: 10_000 },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000 },
  });
  context.provider = new ethers.BrowserProvider(context.rawProvider);
  const signers = await Promise.all([0, 1, 2].map((index) => context.provider.getSigner(index)));
  context.actors = {
    issuer: { label: "Issuer Treasury", signer: signers[0] },
    alice: { label: "Investor Alice", signer: signers[1] },
    bob: { label: "Investor Bob", signer: signers[2] },
  };

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
  addActivity(context, "system", `${config.name} (${config.symbol}) was deployed on this private demo ledger.`);
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
      couponReceived: ethers.formatEther(context.payments[name].coupon),
      principalReceived: ethers.formatEther(context.payments[name].principal),
    };
  }

  let phase = "ISSUANCE";
  if (block.timestamp >= maturityDate) phase = redemptionFunded ? "REDEMPTION" : "MATURED";
  else if (block.timestamp >= nextCouponDate) phase = "COUPON_DUE";
  else if (totalSupply > 0n) phase = "ACTIVE";
  if (redemptionFunded && totalSupply === 0n) phase = "CLOSED";

  return {
    contractAddress: await bond.getAddress(),
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
    if (request.method === "GET") return serveFile(requestUrl.pathname, response);
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error.shortMessage || error.reason || error.message || "Transaction failed.";
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
