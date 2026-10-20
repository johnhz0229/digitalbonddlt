const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Step definitions. Every claim here corresponds to code shown in the right panel.
// ---------------------------------------------------------------------------

const STEPS = [
  {
    chapter: "Overview",
    title: "What you are looking at",
    actor: null,
    what: [
      "Two separate EVM ledgers run inside this server: an <b>asset ledger</b> (chain 7101) with the factory, one Smart Bond Contract per trade and the bond token, and a <b>payment ledger</b> (chain 7102) with a tokenised euro and a <code>CashLock</code> contract that models the Bundesbank Trigger Solution.",
      "Two humans act: <b>Group Treasury</b> (issuer) and an <b>institutional investor</b>. Five participants react to on-chain events with their own keys: an ISIN agent, the crypto securities registrar, a stateless decryption oracle, and the issuer's and investor's own connectors. No server-side orchestrator decides what happens next.",
      "The contracts never call across ledgers. The only links between them are oracle-generated keys and the participants' connectors.",
    ],
    why: "The pilot report's thesis is \"protocol, not platform\": each participant integrates directly with open contracts and nobody holds the workflow state centrally. This walkthrough makes that visible: you click only for the two humans; everything else is participants reacting to events.",
    calls: [],
    code: ["js.Network.pump", "Bond.constructor"],
    tests: ["Smart Bond Lab: runs the full life cycle: issuance DvP, two coupons, redemption with burn"],
    runLabel: "Start with fresh ledgers",
    run: async (api) => api("reset"),
  },
  {
    chapter: "1 · Funding levels",
    title: "Group Treasury publishes its funding curve",
    actor: "Group Treasury (human)",
    what: [
      "Treasury publishes an indicative fixed coupon and a maximum size for the 1Y, 2Y and 3Y tenors on the factory, then admits one investor after (assumed off-chain) onboarding.",
    ],
    why: "This is where Funding Management meets the protocol: the issuer's price list becomes machine-readable, and access control sits in the same contract. In the pilot report the factory is described as \"registry & access control\" and issuers publish funding levels on-chain.",
    calls: ["factory.publishFundingLevel(1, 285, 500)", "factory.publishFundingLevel(2, 310, 500)", "factory.publishFundingLevel(3, 335, 300)", "factory.setEligibleInvestor(investor, true)"],
    code: ["Factory.publishFundingLevel", "Factory.setEligibleInvestor"],
    tests: ["only eligible investors can request trades, within the published size"],
    run: async (api) => {
      await api("publishFundingLevel", { tenorYears: 1, couponPercent: 2.85, maxUnits: 500 });
      await api("publishFundingLevel", { tenorYears: 2, couponPercent: 3.10, maxUnits: 500 });
      await api("publishFundingLevel", { tenorYears: 3, couponPercent: 3.35, maxUnits: 300 });
      return api("approveInvestor");
    },
  },
  {
    chapter: "2 · Trade request",
    title: "The investor requests 100 units at the 2Y level",
    actor: "Investor (human)",
    what: [
      "The factory checks eligibility and size, then deploys a <b>dedicated Smart Bond Contract</b> for this one trade. Issuer, investor, registrar, ISIN agent, oracle, size and the indicative coupon are fixed in its constructor.",
    ],
    why: "One instance per transaction keeps roles immutable and isolates failures: a problem in one trade cannot touch another. The pilot report: \"Each transaction is served by a dedicated smart contract instance.\"",
    calls: ["factory.requestTrade(2, 100)"],
    code: ["Factory.requestTrade", "Bond.constructor"],
    tests: ["only eligible investors can request trades, within the published size"],
    run: async (api) => api("requestTrade", { tenorYears: 2, units: 100 }),
  },
  {
    chapter: "3 · Inception",
    title: "Treasury incepts the final terms",
    actor: "Group Treasury (human)",
    what: [
      "Treasury submits the structured terms record (a simplified JSON inspired by the ICMA Bond Data Taxonomy) together with the numeric fields the contract will enforce: coupon and issue date. The contract stores the record and its keccak256 hash and moves to <code>TradeIncepted</code>.",
    ],
    why: "The record is the single source of truth from which documents can be derived; the numeric fields are what the code enforces. Both must say the same thing, which is checked in the next step.",
    calls: ["bond.inceptTrade(termsJson, 310, issueDate)"],
    code: ["Bond.inceptTrade", "js.buildTerms"],
    tests: ["each step needs the right role"],
    run: async (api) => api("inceptTrade", {}),
  },
  {
    chapter: "4 · Confirmation and distribution",
    title: "The investor confirms; the infrastructure takes over",
    actor: "Investor (human), then ISIN agent, registrar, issuer's connector, oracle",
    what: [
      "The investor's connector compares the terms record with what the contract enforces (address, investor, units, coupon, dates) and confirms the record's hash, in the incept/confirm style of ERC-6123. The terms are now immutable.",
      "Then, without any further click: the ISIN agent writes an ISIN (valid check digit), the registrar deploys the token, registers eligibility and mints 100 units to the issuer, the issuer's connector authorises delivery, and the oracle generates a success and a failure key for the issuance settlement, publishing only their hashes and encryptions.",
    ],
    why: "Watch the event log: every reaction is triggered by an event and signed by a different key. The oracle generating the key pair (as in the pilot) guarantees that hash and ciphertext belong together and that no participant knows a preimage.",
    calls: ["bond.confirmTrade(keccak256(terms))", "→ bond.assignIsin(isin)", "→ registrar: new BondToken(…), token.mint(issuer, 100), bond.registerToken(token)", "→ token.approve(bond, 100)", "→ bond.commitKeys(id, hashSuccess, encSuccess, hashFailure, encFailure)"],
    code: ["js.verifyTerms", "Bond.confirmTrade", "Bond.assignIsin", "js.Registrar", "Bond.registerToken", "Bond._openSettlement", "js.DecryptionOracle", "Bond.commitKeys"],
    tests: ["the investor confirms only the exact terms; a mismatching record is caught before confirming", "each step needs the right state", "computes ISIN check digits correctly"],
    run: async (api) => api("confirmTrade"),
  },
  {
    chapter: "5 · A wrong cash lock",
    title: "The investor locks EUR 90,000 instead of EUR 100,000",
    actor: "Investor (human), then issuer's connector",
    what: [
      "On the payment ledger the investor locks cash against the two hashes. The issuer's connector sees the <code>CashLocked</code> event, compares payer, amount and both hashes with the bond's settlement, finds a shortfall, and <b>refuses to attest</b>. Nothing is delivered.",
    ],
    why: "The bond contract cannot see the payment ledger, so someone must confirm that the cash is really locked. Here it is the payee, because the payee would lose from a fake lock. This is a design choice of mine; how the pilot handles it is a question I would like to ask.",
    calls: ["cash.approve(cashLock, 90 000 EUR)", "cashLock.lock(lockId, issuer, 90 000 EUR, hashSuccess, hashFailure)", "→ issuer's connector: refuses bond.attestCashLock(...)"],
    code: ["CashLock.lock", "js.PartyConnector", "Bond.attestCashLock"],
    tests: ["the issuer's connector refuses a wrong cash lock; the investor aborts, recovers the cash and retries", "only the payee can attest a cash lock"],
    run: async (api) => api("lockIssuanceCash", { amountEur: 90000 }),
  },
  {
    chapter: "6 · Abort and retry",
    title: "The investor aborts, recovers the cash, and opens a new attempt",
    actor: "Investor (human), then oracle, investor's connector",
    what: [
      "<code>abort</code> requests the <b>failure</b> key. The oracle checks the key document (contract, settlement, payee, amount, outcome) and publishes it; the bond accepts it only if it matches the stored failure hash. The investor's connector presents it to <code>CashLock</code> and the EUR 90,000 come back.",
      "The attempt is closed, the obligation is not. <code>retrySettlement</code> opens attempt 2 with fresh keys.",
    ],
    why: "A failure closes an attempt, never the obligation, so the failure path is always harmless and operations can simply retry. Exactly one key is ever requested per attempt.",
    calls: ["bond.abort(1)", "→ oracle: bond.publishKey(1, failurePreimage)", "→ cashLock.releaseWithKey(lockId, failurePreimage)", "bond.retrySettlement(0)", "→ oracle: bond.commitKeys(2, …)"],
    code: ["Bond.abort", "Bond._requestKey", "Bond.publishKey", "CashLock.releaseWithKey", "Bond.retrySettlement"],
    tests: ["the issuer's connector refuses a wrong cash lock; the investor aborts, recovers the cash and retries", "only the oracle can publish a key, and only the requested one"],
    run: async (api) => {
      await api("abortIssuance");
      return api("retryIssuance");
    },
  },
  {
    chapter: "7 · Issuance DvP",
    title: "The correct lock: delivery versus payment across two ledgers",
    actor: "Investor (human), then issuer's connector, oracle",
    what: [
      "The investor locks EUR 100,000. The issuer's connector verifies and attests the lock and triggers <code>settle</code>: the bond contract moves 100 units from the issuer to the investor, enters <code>Issued</code>, and requests the <b>success</b> key. The oracle publishes it, the issuance obligation is discharged, and the issuer's connector collects the cash.",
    ],
    why: "Cash is locked irrevocably before the asset moves, so the issuer never delivers without being paid (principal risk), and no time-lock is needed. If the oracle were offline, the cash would stay locked, not lost: a liveness dependency, not a safety one.",
    calls: ["cashLock.lock(lockId, issuer, 100 000 EUR, …)", "→ bond.attestCashLock(2, lockId); bond.settle(2)", "   → token.transferFrom(issuer, investor, 100)", "→ oracle: bond.publishKey(2, successPreimage)", "→ cashLock.releaseWithKey(lockId, successPreimage)"],
    code: ["Bond.settle", "Token.transferFrom", "Bond.publishKey", "CashLock.releaseWithKey"],
    tests: ["runs the full life cycle: issuance DvP, two coupons, redemption with burn"],
    run: async (api) => api("lockIssuanceCash", {}),
  },
  {
    chapter: "8 · Coupon 1",
    title: "First annual coupon: the same pattern, reversed",
    actor: "Clock, Group Treasury (human), then all connectors and the oracle",
    what: [
      "The clock moves to the first coupon date. Treasury opens the coupon settlement: EUR 100,000 × 3.10% = EUR 3,100 (a regular annual period). The issuer's connector locks the cash automatically, the investor's connector verifies and settles, the oracle releases the success key and the investor collects.",
    ],
    why: "Payment versus discharge: the coupon is recorded as paid only when the bond itself accepts the success preimage, never because some system reported \"paid\". The pilot report describes coupons and redemption as the DvP process \"run in reverse\".",
    calls: ["evm_increaseTime → coupon date", "bond.openCouponSettlement(1)", "→ issuer's connector: cashLock.lock(…, investor, 3 100 EUR, …)", "→ investor's connector: attestCashLock, settle", "→ oracle: publishKey → ObligationDischarged(1)"],
    code: ["Bond.openCouponSettlement", "Bond.couponAmount", "js.PartyConnector", "Bond.publishKey"],
    tests: ["a coupon is only discharged when the bond accepts the success key", "coupons and redemption are not due early"],
    run: async (api) => {
      await api("advanceToNextCoupon");
      return api("payCoupon");
    },
  },
  {
    chapter: "9 · Coupon 2",
    title: "Second coupon, due on the maturity date",
    actor: "Clock, Group Treasury (human), then all connectors and the oracle",
    what: [
      "Coupons are settled in order; the contract refuses coupon 2 while coupon 1 is outstanding. For a 2Y bond with annual coupons, the last coupon date equals the maturity date.",
    ],
    why: "Ordering and due dates are enforced by the contract, not by a back office. Day count is simplified to regular annual periods.",
    calls: ["evm_increaseTime → coupon date 2", "bond.openCouponSettlement(2)", "→ … same pattern … → ObligationDischarged(2)"],
    code: ["Bond.openCouponSettlement", "Bond.couponAmount"],
    tests: ["runs the full life cycle: issuance DvP, two coupons, redemption with burn"],
    run: async (api) => {
      await api("advanceToNextCoupon");
      return api("payCoupon");
    },
  },
  {
    chapter: "10 · Redemption",
    title: "Redemption at maturity: principal against burned units",
    actor: "Investor (human), then all connectors and the oracle",
    what: [
      "The investor requests redemption. The issuer's connector locks EUR 100,000; the investor's connector verifies, authorises the return of the units and settles. The bond contract takes back the 100 units, <b>burns</b> them, enters <code>Redeemed</code> and requests the success key, which releases the principal to the investor.",
    ],
    why: "Redemption is again DvP: units against principal. Only the bond contract can move or burn units, and only after both coupons are discharged.",
    calls: ["bond.requestRedemption()", "→ issuer's connector: cashLock.lock(…, investor, 100 000 EUR, …)", "→ investor's connector: token.approve(bond, 100); attestCashLock; settle", "   → token.transferFrom(investor, bond, 100); token.burn(100)", "→ oracle: publishKey → ObligationDischarged(3)"],
    code: ["Bond.requestRedemption", "Bond.settle", "Token.burn"],
    tests: ["bond units cannot be transferred outside the Smart Bond Contract", "runs the full life cycle: issuance DvP, two coupons, redemption with burn"],
    run: async (api) => {
      await api("advanceToMaturity");
      return api("requestRedemption");
    },
  },
  {
    chapter: "Review",
    title: "What this shows, and what it does not",
    actor: null,
    what: [
      "<b>Shows:</b> a deterministic life cycle as an explicit state machine; one contract instance per trade; terms confirmed by hash; infrastructure participants reacting to events with their own keys; DvP for issuance, coupons and redemption with cash locked before the asset moves; oracle-generated keys bound to contract, settlement, payee, amount and outcome; payment versus discharge; failure paths that are always recoverable.",
      "<b>Does not:</b> legal effect (no eWpG register, no real ISIN), real central bank money or the real Trigger Solution, privacy, threshold decryption, secondary trading, business-day and full day-count conventions, audit.",
      "<b>Differences from the pilot</b> as I understand the report: Polygon PoS and T2 instead of local ledgers; ICMA BDT XML/XSLT instead of a simplified JSON; the registrar was triggered via an off-chain API. In the pilot the investor seems to confirm the cash lock; here the payee's connector attests it.",
      "<b>Open question:</b> in the cash-lock model the asset ledger cannot see the payment ledger. How does the Smart Bond Contract know that the cash is really locked, and who attests it?",
    ],
    why: "Earlier learning modules (linked at the top) cover same-ledger DvP, a simplified ERC-7573 asset-lock variant including a self-payment attack I found and fixed, and payment versus discharge for coupons. 54 automated tests cover all of them.",
    calls: [],
    code: ["js.PartyConnector", "js.DecryptionOracle"],
    tests: [],
    run: null,
  },
];

// ---------------------------------------------------------------------------

let current = 0;
let progress = 0; // number of steps already executed on the server
let busy = false;
let lastState = null;
const results = new Map(); // step index -> { entries, before, after }
const snippetCache = new Map();
let activeSnippet = null;
let statusMessage = "";

const escapeHtml = (text) => {
  const node = document.createElement("div");
  node.textContent = String(text);
  return node.innerHTML;
};
const euro = (value) => `€${Number(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = `show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ""; }, 4500);
}

async function api(action, params = {}) {
  const response = await fetch("/api/lab/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Action failed.");
  return result.state;
}

/** How far the server-side lab already is, so a page reload continues where it was. */
function progressFrom(state) {
  const i = state.instance;
  if (!state.curve.length && !i) return 1; // fresh ledgers: overview done
  if (!state.investorEligible || !state.curve.length) return 1;
  if (!i) return 2;
  if (i.state === "IndicationPhase") return 3;
  if (i.state === "TradeIncepted") return 4;
  if (i.state === "Minted") {
    const attempts = i.settlements.filter((s) => s.purpose === 0);
    if (attempts.length >= 2) return 7;
    if (attempts.length === 1 && attempts[0].cashLock !== "—") return 6;
    return 5;
  }
  if (i.state === "Issued") return 8 + i.coupons.filter((c) => c.discharged).length;
  if (i.state === "Redeemed") return 11;
  return 1;
}

// ---- rendering --------------------------------------------------------------

function renderNav() {
  $("wt-nav").innerHTML = STEPS.map((step, index) => {
    const done = index < progress;
    const isNext = index === progress;
    return `<button class="wt-nav-item${index === current ? " active" : ""}${done ? " done" : ""}${isNext ? " next" : ""}" data-step="${index}">
      <span class="wt-nav-dot">${done ? "✓" : index}</span><span><small>${escapeHtml(step.chapter)}</small>${escapeHtml(step.title)}</span></button>`;
  }).join("");
}

function renderStep() {
  const step = STEPS[current];
  $("wt-chapter").textContent = step.chapter.toUpperCase();
  $("wt-title").textContent = step.title;
  $("wt-actor").innerHTML = step.actor ? `<span>WHO ACTS</span>${escapeHtml(step.actor)}` : "";
  $("wt-what").innerHTML = step.what.map((p) => `<p>${p}</p>`).join("");
  $("wt-why").innerHTML = `<strong>Why it is designed this way</strong><p>${escapeHtml(step.why)}</p>`;
  $("wt-calls").innerHTML = step.calls.length
    ? `<strong>Calls in this step</strong><pre>${step.calls.map(escapeHtml).join("\n")}</pre>`
    : "";

  const runButton = $("wt-run");
  runButton.hidden = !step.run;
  runButton.textContent = step.runLabel || (current < progress ? "Already run" : "Run this step");
  runButton.disabled = busy || !step.run || (current !== progress && current !== 0);
  $("wt-next").hidden = current >= STEPS.length - 1;
  $("wt-run-status").textContent = statusMessage || (current > progress && step.run ? "Run the earlier steps first." : "");

  renderCodeTabs(step);
  renderTests(step);
  renderResult();
  renderNav();
}

function renderTests(step) {
  $("wt-tests").innerHTML = step.tests.length
    ? `<p class="overline">TESTS COVERING THIS STEP</p><ul>${step.tests.map((t) => `<li><span>PASS</span>${escapeHtml(t)}</li>`).join("")}</ul>`
    : "";
}

function renderState(state, before) {
  if (!state) return;
  const i = state.instance;
  const states = ["IndicationPhase", "TradeIncepted", "DistributionPhase", "IsinAssigned", "Minted", "Issued", "Redeemed"];
  $("wt-states").innerHTML = states.map((name, index) => {
    const reached = i && i.state !== "Cancelled" && index <= i.stateIndex;
    const active = i && i.state === name;
    return `<span class="lab-state${reached ? " reached" : ""}${active ? " active" : ""}">${name}</span>`;
  }).join('<span class="lab-arrow">→</span>');

  const delta = (now, then) => {
    if (then === undefined || then === null || now === then) return "";
    const diff = now - then;
    return `<em class="${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : "−"}${euro(Math.abs(diff)).slice(1)}</em>`;
  };
  const unitsDelta = (now, then) => (then === undefined || now === then ? "" : `<em class="${now > then ? "up" : "down"}">${now > then ? "+" : "−"}${Math.abs(now - then)}</em>`);
  const b = before || {};
  const bi = b.instance && b.instance.token;

  $("wt-bond-address").textContent = i ? i.address : "no trade yet";
  const curve = state.curve.map((l) => `${l.tenorYears}Y ${l.couponPercent.toFixed(2)}%`).join(" · ") || "—";
  $("wt-asset").innerHTML = `
    <div><span>Funding curve</span><strong>${escapeHtml(curve)}</strong></div>
    <div><span>Bond state</span><strong>${i ? i.state : "—"}</strong></div>
    <div><span>ISIN</span><strong>${i && i.isin ? i.isin : "—"}</strong></div>
    <div><span>Units: issuer</span><strong>${i && i.token ? i.token.issuer : 0} ${i && i.token ? unitsDelta(i.token.issuer, bi ? bi.issuer : (before ? 0 : undefined)) : ""}</strong></div>
    <div><span>Units: investor</span><strong>${i && i.token ? i.token.investor : 0} ${i && i.token ? unitsDelta(i.token.investor, bi ? bi.investor : (before ? 0 : undefined)) : ""}</strong></div>
    <div><span>Units outstanding</span><strong>${i && i.token ? i.token.totalSupply : 0}</strong></div>
    <div><span>Coupons discharged</span><strong>${i ? `${i.coupons.filter((c) => c.discharged).length} / ${i.coupons.length || "—"}` : "—"}</strong></div>`;
  $("wt-payment").innerHTML = `
    <div><span>Treasury (issuer)</span><strong>${euro(state.cash.issuer)} ${delta(state.cash.issuer, b.cash && b.cash.issuer)}</strong></div>
    <div><span>Investor</span><strong>${euro(state.cash.investor)} ${delta(state.cash.investor, b.cash && b.cash.investor)}</strong></div>
    <div><span>Locked in CashLock</span><strong>${euro(state.cash.locked)} ${delta(state.cash.locked, b.cash && b.cash.locked)}</strong></div>`;

  $("wt-settlements").innerHTML = i && i.settlements.length
    ? `<table class="lab-table"><thead><tr><th>#</th><th>Settlement</th><th>Payer → payee</th><th>Amount</th><th>Bond side</th><th>Cash lock</th></tr></thead><tbody>${i.settlements.map((s) => `
        <tr><td>${s.id}</td><td>${escapeHtml(s.label)}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}</td><td>${s.payer} → ${s.payee}</td><td>${euro(s.amount)}</td>
        <td><span class="lab-badge ${s.status === "Succeeded" ? "ok" : s.status === "Failed" ? "bad" : ""}">${s.status}</span></td>
        <td><span class="lab-badge ${s.cashLock === "RELEASED" ? "ok" : s.cashLock === "RETURNED" ? "bad" : ""}">${s.cashLock}</span></td></tr>`).join("")}</tbody></table>`
    : "";
}

function renderResult() {
  const result = results.get(current);
  renderState(result ? result.after : lastState, result ? result.before : null);
  if (!result) {
    $("wt-log").innerHTML = `<div class="empty-state">${current < progress ? "This step ran before the page was loaded; its log is in the Lab dashboard's event monitor." : "Run the step to see its transactions."}</div>`;
    return;
  }
  $("wt-log").innerHTML = result.entries.length ? result.entries.map((entry) => {
    if (entry.type === "action") {
      return `<div class="wt-entry action"><span class="wt-who">${escapeHtml(entry.actor)}</span><p>${escapeHtml(entry.message)}</p>${entry.txHash ? `<code>${escapeHtml(entry.txHash.slice(0, 18))}…</code>` : ""}</div>`;
    }
    const params = Object.entries(entry.params || {}).map(([k, v]) => `<span><b>${escapeHtml(k)}</b>=${escapeHtml(v)}</span>`).join("");
    return `<div class="wt-entry event"><span class="chain-tag ${entry.chain}">${entry.chain === "asset" ? "ASSET" : "PAYMENT"}</span>
      <div><code class="wt-event-name">${escapeHtml(entry.contract)}.${escapeHtml(entry.name)}</code> <small>block ${entry.blockNumber}</small><div class="wt-params">${params}</div></div></div>`;
  }).join("") : '<div class="empty-state">No transactions in this step.</div>';
}

// ---- code panel ---------------------------------------------------------------

const KEYWORDS = new Set(("function constructor returns return if else revert emit require external public private view pure memory calldata storage " +
  "uint256 bytes32 bytes address bool string mapping struct enum event error modifier contract interface import pragma immutable constant " +
  "const let async await class new this for of while throw try catch true false null undefined").split(" "));

function highlight(line) {
  let out = "";
  const pattern = /(\/\/.*$|\/\*.*?\*\/|^\s*\*.*$|^\s*\/\*\*.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b[A-Za-z_$][\w$]*\b|\b\d[\d_]*\b)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(line))) {
    out += escapeHtml(line.slice(last, match.index));
    const token = match[0];
    let cls = "";
    if (/^(\/\/|\/\*|\s*\*)/.test(token)) cls = "c";
    else if (/^["'`]/.test(token)) cls = "s";
    else if (KEYWORDS.has(token)) cls = "k";
    else if (/^\d/.test(token)) cls = "n";
    out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
    last = match.index + token.length;
  }
  return out + escapeHtml(line.slice(last));
}

async function loadSnippet(id) {
  if (!snippetCache.has(id)) {
    const response = await fetch(`/api/source?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Source not available.");
    snippetCache.set(id, await response.json());
  }
  return snippetCache.get(id);
}

async function showSnippet(id) {
  activeSnippet = id;
  document.querySelectorAll(".wt-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.snippet === id));
  try {
    const s = await loadSnippet(id);
    if (activeSnippet !== id) return;
    $("wt-code-file").innerHTML = `<code>${escapeHtml(s.file)}</code><span>lines ${s.startLine}–${s.endLine} · ${s.language}</span>`;
    $("wt-code").innerHTML = `<code>${s.code.split("\n").map((line, i) => `<span class="ln">${s.startLine + i}</span>${highlight(line)}`).join("\n")}</code>`;
  } catch (error) {
    $("wt-code").textContent = error.message;
  }
}

function renderCodeTabs(step) {
  $("wt-tabs").innerHTML = step.code.map((id) => `<button class="wt-tab" data-snippet="${id}" role="tab">${escapeHtml(id.replace(/^js\./, ""))}</button>`).join("");
  if (step.code.length) showSnippet(step.code[0]);
}

// ---- running ------------------------------------------------------------------

async function runCurrent() {
  const step = STEPS[current];
  if (!step.run || busy) return;
  busy = true;
  statusMessage = "Running transactions…";
  renderStep();
  const before = current === 0 ? null : lastState;
  const since = lastState ? lastState.monitorCount : 0;
  try {
    const after = await step.run(api);
    const entries = after.monitor.filter((entry) => current === 0 || entry.seq >= since).reverse();
    results.set(current, { before, after, entries });
    lastState = after;
    progress = current === 0 ? 1 : current + 1;
    if (current === 0) results.forEach((_, key) => { if (key !== 0) results.delete(key); });
    statusMessage = `Done: ${entries.filter((e) => e.type === "event").length} events, ${entries.filter((e) => e.type === "action").length} actions.`;
  } catch (error) {
    toast(error.message, true);
    statusMessage = "";
  } finally {
    busy = false;
    renderStep();
    renderStats();
  }
}

function renderStats() {
  const s = lastState;
  const i = s && s.instance;
  $("wt-stats").innerHTML = `
    <div><span>Step</span><strong>${Math.min(progress, STEPS.length - 1)} / ${STEPS.length - 1}</strong></div>
    <div><span>Bond</span><strong>${i ? i.state : "—"}</strong></div>
    <div><span>Events so far</span><strong>${s ? s.monitor.filter((e) => e.type === "event").length + (s.monitorCount > 150 ? "+" : "") : 0}</strong></div>`;
}

$("wt-nav").addEventListener("click", (event) => {
  const item = event.target.closest("[data-step]");
  if (!item) return;
  current = Number(item.dataset.step);
  statusMessage = "";
  renderStep();
});
$("wt-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-snippet]");
  if (tab) showSnippet(tab.dataset.snippet);
});
$("wt-run").addEventListener("click", runCurrent);
$("wt-next").addEventListener("click", () => {
  current = Math.min(current + 1, STEPS.length - 1);
  statusMessage = "";
  renderStep();
  window.scrollTo({ top: $("wt-chapter").getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" });
});

fetch("/api/lab/state")
  .then((response) => response.json())
  .then((state) => {
    lastState = state;
    progress = progressFrom(state);
    current = Math.min(progress, STEPS.length - 1);
    if (progress <= 1 && !state.curve.length) current = 0;
    renderStep();
    renderStats();
  })
  .catch((error) => toast(error.message, true));
