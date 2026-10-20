const $ = (id) => document.getElementById(id);

const STEPS = [
  {
    text: "Issuer publishes indicative coupons (1Y 2.85 %, 2Y 3.10 %, 3Y 3.35 %) and admits the investor.",
    code: ["Factory.publishFundingLevel", "Factory.setEligibleInvestor"],
    run: async () => {
      await act("publishFundingLevel", { tenorYears: 1, couponPercent: 2.85, maxUnits: 500 });
      await act("publishFundingLevel", { tenorYears: 2, couponPercent: 3.10, maxUnits: 500 });
      await act("publishFundingLevel", { tenorYears: 3, couponPercent: 3.35, maxUnits: 300 });
      return act("approveInvestor");
    },
  },
  {
    text: "Investor requests 100 units (EUR 100,000) at the 2Y level; the factory deploys a dedicated bond instance.",
    code: ["Factory.requestTrade", "Bond.constructor"],
    run: () => act("requestTrade", { tenorYears: 2, units: 100 }),
  },
  {
    text: "Issuer incepts the final terms: structured record, coupon and issue date.",
    code: ["Bond.inceptTrade", "js.buildTerms"],
    run: () => act("inceptTrade", {}),
  },
  {
    text: "Investor checks the record against the contract and confirms its hash. ISIN agent, registrar and oracle react automatically.",
    code: ["js.verifyTerms", "Bond.confirmTrade", "js.Registrar", "Bond.registerToken", "Bond.commitKeys"],
    run: () => act("confirmTrade"),
  },
  {
    text: "Investor locks EUR 90,000 instead of EUR 100,000. The issuer's connector refuses to attest; nothing is delivered.",
    code: ["CashLock.lock", "js.PartyConnector", "Bond.attestCashLock"],
    run: () => act("lockIssuanceCash", { amountEur: 90000 }),
  },
  {
    text: "Investor aborts: the failure key returns the cash. A second attempt is opened with fresh keys.",
    code: ["Bond.abort", "Bond.publishKey", "CashLock.releaseWithKey", "Bond.retrySettlement"],
    run: async () => {
      await act("abortIssuance");
      return act("retryIssuance");
    },
  },
  {
    text: "Investor locks EUR 100,000. Units are delivered and the success key releases the cash to the issuer.",
    code: ["Bond.settle", "Token.transferFrom", "Bond.publishKey"],
    run: () => act("lockIssuanceCash", {}),
  },
  {
    text: "First coupon date: EUR 3,100 is locked by the issuer, verified by the investor and discharged by the success key.",
    code: ["Bond.openCouponSettlement", "Bond.couponAmount", "Bond.publishKey"],
    run: async () => {
      await act("advanceToNextCoupon");
      return act("payCoupon");
    },
  },
  {
    text: "Second coupon, due on the maturity date.",
    code: ["Bond.openCouponSettlement"],
    run: async () => {
      await act("advanceToNextCoupon");
      return act("payCoupon");
    },
  },
  {
    text: "Redemption: EUR 100,000 against the return of the units, which are burned.",
    code: ["Bond.requestRedemption", "Bond.settle", "Token.burn"],
    run: async () => {
      await act("advanceToMaturity");
      return act("requestRedemption");
    },
  },
];

let done = 0;
let busy = false;
let lastState = null;
const snippets = new Map();

const escapeHtml = (text) => {
  const node = document.createElement("div");
  node.textContent = String(text);
  return node.innerHTML;
};
const eur = (v) => Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function act(action, params = {}) {
  const response = await fetch("/api/lab/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Action failed.");
  return result.state;
}

function progressFrom(state) {
  const i = state.instance;
  if (!state.curve.length || !state.investorEligible) return 0;
  if (!i) return 1;
  if (i.state === "IndicationPhase") return 2;
  if (i.state === "TradeIncepted") return 3;
  if (i.state === "Minted") {
    const attempts = i.settlements.filter((s) => s.purpose === 0);
    if (attempts.length >= 2) return 6;
    return attempts.length === 1 && attempts[0].cashLock !== "—" ? 5 : 4;
  }
  if (i.state === "Issued") return 7 + i.coupons.filter((c) => c.discharged).length;
  if (i.state === "Redeemed") return 10;
  return 0;
}

function summary(state) {
  const i = state.instance;
  const parts = [`state ${i ? i.state : "—"}`];
  if (i && i.isin) parts.push(`ISIN ${i.isin}`);
  if (i && i.token) parts.push(`units issuer ${i.token.issuer} / investor ${i.token.investor} / outstanding ${i.token.totalSupply}`);
  parts.push(`cash issuer ${eur(state.cash.issuer)} / investor ${eur(state.cash.investor)} / locked ${eur(state.cash.locked)}`);
  return parts.join(" · ");
}

function eventLine(entry) {
  if (entry.type === "action") return `<li class="act">${escapeHtml(entry.actor)}: ${escapeHtml(entry.message)}</li>`;
  const params = Object.entries(entry.params || {}).map(([k, v]) => `${k}=${v}`).join(", ");
  return `<li><span class="chain">${entry.chain === "asset" ? "A" : "P"}</span>${escapeHtml(entry.contract)}.${escapeHtml(entry.name)}(${escapeHtml(params)})</li>`;
}

/** Builds the list once; outputs of earlier steps stay in place. */
function buildList() {
  $("steps").innerHTML = STEPS.map((step, index) => `<li id="step-${index}">
      <div class="row"><p>${escapeHtml(step.text)}</p><button data-run="${index}">Run</button></div>
      <div class="out" id="out-${index}"></div>
    </li>`).join("");
  render();
}

function render() {
  STEPS.forEach((_, index) => {
    $(`step-${index}`).className = index < done ? "done" : index === done ? "next" : "";
    const button = $(`step-${index}`).querySelector("button");
    button.disabled = busy || index !== done;
    button.textContent = index < done ? "Done" : "Run";
  });
}

async function codeBlock(id) {
  if (!snippets.has(id)) {
    const response = await fetch(`/api/source?id=${encodeURIComponent(id)}`);
    snippets.set(id, response.ok ? await response.json() : null);
  }
  const s = snippets.get(id);
  if (!s) return "";
  const numbered = s.code.split("\n").map((line, i) => `<span class="ln">${s.startLine + i}</span>${escapeHtml(line)}`).join("\n");
  return `<p class="file">${escapeHtml(s.file)}, lines ${s.startLine}–${s.endLine}</p><pre class="code">${numbered}</pre>`;
}

function showResult(index, state, entries) {
  const step = STEPS[index];
  const out = $(`out-${index}`);
  out.innerHTML = `<p class="state">${escapeHtml(summary(state))}</p>
    <details><summary>Events and actions (${entries.length})</summary><ul class="events">${entries.map(eventLine).join("")}</ul></details>
    <details class="codes"><summary>Source code (${step.code.length})</summary><div class="code-body">Loading…</div></details>`;
  out.querySelector(".codes").addEventListener("toggle", async (event) => {
    const body = event.target.querySelector(".code-body");
    if (!event.target.open || body.dataset.loaded) return;
    body.innerHTML = (await Promise.all(step.code.map(codeBlock))).join("");
    body.dataset.loaded = "1";
  });
}

async function run(index) {
  if (busy || index !== done) return;
  busy = true;
  render();
  $("status").textContent = "Running…";
  const since = lastState ? lastState.monitorCount : 0;
  try {
    const state = await STEPS[index].run();
    const entries = state.monitor.filter((entry) => entry.seq >= since).reverse();
    lastState = state;
    done = index + 1;
    busy = false;
    render();
    showResult(index, state, entries);
    $("status").textContent = "";
  } catch (error) {
    busy = false;
    render();
    $("status").textContent = error.message;
  }
}

$("steps").addEventListener("click", (event) => {
  const button = event.target.closest("[data-run]");
  if (button) run(Number(button.dataset.run));
});

$("reset").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  $("status").textContent = "Starting fresh ledgers…";
  try {
    lastState = await act("reset");
    done = 0;
    buildList();
  } catch (error) {
    $("status").textContent = error.message;
  }
  busy = false;
  render();
  $("status").textContent = "";
});

fetch("/api/lab/state")
  .then((response) => response.json())
  .then((state) => {
    lastState = state;
    done = progressFrom(state);
    buildList();
    if (done > 0) $("status").textContent = `Continuing at step ${done + 1}. Reset to start over.`;
  })
  .catch((error) => { $("status").textContent = error.message; });
