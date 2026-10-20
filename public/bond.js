const $ = (id) => document.getElementById(id);

const STEPS = [
  { text: "Issuer whitelists Alice and Bob after KYC.", ids: "AC1.1", run: async () => { await act("whitelist", { investor: "alice" }); return act("whitelist", { investor: "bob" }); } },
  { text: "Issuer issues 10 units to Alice.", ids: "AC2.4", run: () => act("issue", { investor: "alice", units: 10 }) },
  { text: "Alice transfers 4 units to Bob.", ids: "AC3.1", run: () => act("transfer", { from: "alice", to: "bob", units: 4 }) },
  { text: "Move the ledger clock to the first coupon date.", ids: "", run: () => act("advanceCoupon") },
  { text: "Issuer pays the coupon to both holders, pro rata.", ids: "AC4.4", run: () => act("payCoupon") },
  { text: "Move the ledger clock to maturity.", ids: "", run: () => act("advanceMaturity") },
  { text: "Issuer funds the principal.", ids: "AC5.1", run: () => act("fundRedemption") },
  { text: "Alice and Bob redeem; their units are burned.", ids: "AC5.4", run: async () => { await act("redeem", { investor: "alice" }); return act("redeem", { investor: "bob" }); } },
];

const CHECKS = [
  { id: "AC2.1", text: "Alice tries to issue units to herself", expect: "OnlyIssuer", run: () => act("issueAsInvestor") },
  { id: "AC2.2", text: "Issuer issues 1 unit to Carol, who is not whitelisted", expect: "InvestorNotWhitelisted", run: () => act("issue", { investor: "carol", units: 1 }) },
  { id: "AC3.2", text: "Alice transfers 1 unit to Carol", expect: "InvestorNotWhitelisted", run: () => act("transfer", { from: "alice", to: "carol", units: 1 }) },
  { id: "AC4.2", text: "Issuer pays a coupon before its date", expect: "CouponNotDue", when: (s) => s.blockTime < s.terms.nextCouponDate, hint: "before a coupon date", run: () => act("payCoupon") },
  { id: "AC4.3", text: "Issuer underpays a due coupon by 1 wei", expect: "IncorrectPayment", when: (s) => s.blockTime >= s.terms.nextCouponDate && s.blockTime < s.terms.maturityDate, hint: "on a coupon date", run: () => act("payCouponWrongAmount") },
  { id: "AC5.1", text: "Issuer funds the principal before maturity", expect: "BondNotMatured", when: (s) => s.blockTime < s.terms.maturityDate, hint: "before maturity", run: () => act("fundRedemption") },
  { id: "AC5.2", text: "Issuer funds the principal 1 wei short", expect: "IncorrectPayment", when: (s) => s.blockTime >= s.terms.maturityDate && !s.redemptionFunded, hint: "at maturity, before funding", run: () => act("fundRedemptionWrongAmount") },
  { id: "AC5.3", text: "Alice redeems before the principal is funded", expect: "RedemptionNotFunded", when: (s) => !s.redemptionFunded, hint: "before funding", run: () => act("redeem", { investor: "alice" }) },
];

let state = null;
let done = 0;
let busy = false;
const checkResults = new Map();

const escapeHtml = (text) => {
  const node = document.createElement("div");
  node.textContent = String(text);
  return node.innerHTML;
};
const date = (seconds) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(seconds * 1000));
const num = (value) => Number(value).toLocaleString("en-GB", { maximumFractionDigits: 6 });

async function act(action, params = {}) {
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Transaction failed.");
  return result.state;
}

async function refresh() {
  const response = await fetch("/api/state");
  return response.json();
}

function progressFrom(s) {
  const a = s.accounts;
  if (!a.alice.whitelisted || !a.bob.whitelisted) return 0;
  if (s.totalSupply === 0 && !s.redemptionFunded) return 1;
  if (a.bob.units === 0 && !s.redemptionFunded) return 2;
  if (s.couponsPaid === 0) return s.blockTime < s.terms.nextCouponDate ? 3 : 4;
  if (!s.redemptionFunded) return s.blockTime < s.terms.maturityDate ? 5 : 6;
  if (s.totalSupply > 0) return 7;
  return 8;
}

function render() {
  const t = state.terms;
  $("terms").innerHTML = `<b>${escapeHtml(t.name)}</b> (${escapeHtml(t.symbol)}) · face value ${num(t.faceValue)} test ETH per unit · coupon ${t.annualCouponPercent.toFixed(2)} % p.a. every ${t.couponIntervalDays} days · coupon per unit ${num(t.couponPerUnit)} · next coupon ${t.nextCouponDate >= t.maturityDate ? "none" : date(t.nextCouponDate)} · maturity ${date(t.maturityDate)} · ledger date ${date(state.blockTime)}<br><code>${escapeHtml(state.contractAddress)}</code>`;

  $("register").innerHTML = ["alice", "bob", "carol"].map((name) => {
    const a = state.accounts[name];
    return `<tr><td>${escapeHtml(a.label.replace("Investor ", ""))}</td><td>${a.whitelisted ? "yes" : "no"}</td><td class="num">${a.units}</td><td class="num">${num(a.couponReceived)}</td><td class="num">${num(a.principalReceived)}</td></tr>`;
  }).join("") + `<tr class="total"><td>Total supply</td><td></td><td class="num">${state.totalSupply}</td><td class="num">${state.couponsPaid} paid</td><td class="num">${state.redemptionFunded ? "funded" : "—"}</td></tr>`;

  $("steps").innerHTML = STEPS.map((step, i) => `
    <li class="${i < done ? "done" : i === done ? "next" : ""}">
      <div class="row"><p>${escapeHtml(step.text)} ${step.ids ? `<span class="ac">${step.ids}</span>` : ""}</p>
      <button data-step="${i}" ${busy || i !== done ? "disabled" : ""}>${i < done ? "Done" : "Run"}</button></div>
    </li>`).join("");

  $("checks").innerHTML = CHECKS.map((check, i) => {
    const available = !check.when || check.when(state);
    const result = checkResults.get(i);
    const cell = result
      ? `<span class="${result.ok ? "pass" : "fail"}">${escapeHtml(result.text)}</span>`
      : available ? "" : `<span class="muted">available ${escapeHtml(check.hint)}</span>`;
    return `<tr><td>${check.id}</td><td>${escapeHtml(check.text)}</td><td><button data-check="${i}" ${busy || !available ? "disabled" : ""}>Try</button></td><td>${cell}</td></tr>`;
  }).join("");

  $("events").innerHTML = state.events.length
    ? state.events.map((e) => `<li><span class="blk">#${e.block}</span>${escapeHtml(e.name)}(${escapeHtml(e.args)})</li>`).join("")
    : "<li>No events yet.</li>";
}

async function runStep(i) {
  if (busy || i !== done) return;
  busy = true;
  render();
  $("status").textContent = "Running…";
  try {
    state = await STEPS[i].run();
    done = progressFrom(state);
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = error.message;
  }
  busy = false;
  render();
}

async function runCheck(i) {
  if (busy) return;
  const check = CHECKS[i];
  busy = true;
  render();
  try {
    state = await check.run();
    checkResults.set(i, { ok: false, text: "Executed: not rejected" });
  } catch (error) {
    const reason = error.message.split(/[\s(:]/)[0];
    checkResults.set(i, reason === check.expect
      ? { ok: true, text: `Rejected: ${reason}` }
      : { ok: false, text: `Rejected with ${reason}, expected ${check.expect}` });
    state = await refresh();
  }
  done = progressFrom(state);
  busy = false;
  render();
}

document.addEventListener("click", (event) => {
  const step = event.target.closest("[data-step]");
  if (step) runStep(Number(step.dataset.step));
  const check = event.target.closest("[data-check]");
  if (check) runCheck(Number(check.dataset.check));
});

$("reset").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  $("status").textContent = "Resetting…";
  try {
    state = await act("reset");
    done = 0;
    checkResults.clear();
    $("status").textContent = "";
  } catch (error) {
    $("status").textContent = error.message;
  }
  busy = false;
  render();
});

refresh()
  .then((s) => {
    state = s;
    done = progressFrom(s);
    render();
  })
  .catch((error) => { $("status").textContent = error.message; });
