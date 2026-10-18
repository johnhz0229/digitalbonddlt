const $ = (id) => document.getElementById(id);
let busy = false;
let current = null;

const errorMessages = {
  WrongRole: "This role is not allowed to take this step.",
  WrongState: "This step is not allowed in the bond's current state.",
  WrongSettlementStatus: "This settlement is not at the right step.",
  NotDue: "Not due yet. Move the clock first.",
  NotEligible: "The investor has not been admitted to the programme yet.",
  NoFundingLevel: "No active funding level for this tenor.",
  InvalidUnits: "The size is outside the published limit.",
  PreviousObligationOpen: "An earlier coupon is still outstanding.",
  SettlementOpen: "A settlement attempt is still open.",
  AlreadyDischarged: "This obligation is already discharged.",
  TermsMismatch: "The terms do not match.",
};

const PARTICIPANTS = [
  ["ISIN agent", "Assigns the ISIN when the terms are confirmed (pilot: WM Datenservice)."],
  ["Registrar", "Deploys and mints the token, keeps the eligibility register (pilot: Cashlink, eWpG)."],
  ["Decryption oracle", "Generates both keys per settlement, later decrypts exactly the requested one (pilot: NTT DATA)."],
  ["Issuer's connector", "Run by the issuer: authorises delivery, verifies incoming cash locks, locks coupon cash."],
  ["Investor's connector", "Run by the investor: verifies coupon and principal locks, claims or recovers cash."],
];

const STATE_LABEL = {
  IndicationPhase: "Indication", TradeIncepted: "Incepted", DistributionPhase: "Distribution", IsinAssigned: "ISIN",
  Minted: "Minted", Issued: "Issued", Redeemed: "Redeemed", Cancelled: "Cancelled",
};

const escapeHtml = (text) => {
  const node = document.createElement("div");
  node.textContent = String(text);
  return node.innerHTML;
};
const euro = (value) => `€${Number(value).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (seconds) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(seconds * 1000));
const short = (hex) => (hex && hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex || "—");

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = `show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ""; }, 4500);
}

function friendlyError(message) {
  const key = Object.keys(errorMessages).find((name) => message.includes(name));
  return key ? errorMessages[key] : message;
}

function nextStep(state) {
  const i = state.instance;
  if (!state.curve.some((level) => level.active)) return "Treasury: publish a funding level";
  if (!state.investorEligible) return "Treasury: admit the investor";
  if (!i || i.state === "Cancelled" || i.state === "Redeemed") return i && i.state === "Redeemed" ? "Done: the bond is redeemed. Reset to start again" : "Investor: request a trade";
  if (i.state === "IndicationPhase") return "Treasury: incept the final terms";
  if (i.state === "TradeIncepted") return "Investor: check and confirm the terms";
  if (i.state === "Minted") {
    const issuance = i.settlements.filter((s) => s.purpose === 0).pop();
    if (!issuance || issuance.status === "Failed") return "Investor: retry the issuance";
    if (issuance.cashLock === "LOCKED") return "Investor: the lock was refused. Abort to recover the cash";
    return "Investor: lock the purchase cash";
  }
  if (i.state === "Issued") {
    const coupon = i.coupons.find((c) => !c.discharged);
    if (coupon) return state.blockTime < coupon.date ? `Clock: move to coupon ${coupon.period}` : `Treasury: pay coupon ${coupon.period}`;
    return state.blockTime < i.maturityDate ? "Clock: move to maturity" : "Investor: request redemption";
  }
  return "Wait for the participants";
}

function render(state) {
  current = state;
  const i = state.instance;
  $("lab-title").textContent = i ? `${i.tenorYears}Y Treasury bond · ${i.units} units` : "Smart Bond Lab";
  $("lab-isin").textContent = i && i.isin ? i.isin : "NO ISIN YET";
  $("lab-state").textContent = i ? STATE_LABEL[i.state].toUpperCase() : "NO TRADE";
  $("lab-address").textContent = i ? i.address : "No trade requested yet";
  $("lab-next").textContent = nextStep(state);
  $("lab-issuer-cash").textContent = euro(state.cash.issuer);
  $("lab-investor-cash").textContent = euro(state.cash.investor);

  const states = i ? i.states : ["IndicationPhase", "TradeIncepted", "DistributionPhase", "IsinAssigned", "Minted", "Issued", "Redeemed"];
  $("lab-states").innerHTML = states.filter((s) => s !== "Cancelled" || (i && i.state === "Cancelled")).map((name, index) => {
    const reached = i && (i.state === name || (i.state !== "Cancelled" && index < i.stateIndex));
    const active = i && i.state === name;
    return `<span class="lab-state${reached ? " reached" : ""}${active ? " active" : ""}">${escapeHtml(STATE_LABEL[name])}</span>`;
  }).join('<span class="lab-arrow">→</span>');

  $("lab-curve").innerHTML = state.curve.length
    ? `<thead><tr><th>Tenor</th><th>Indicative coupon</th><th>Max units</th></tr></thead><tbody>${state.curve.map((level) => `<tr><td>${level.tenorYears}Y</td><td>${level.couponPercent.toFixed(2)}%</td><td>${level.maxUnits}</td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty-state">No funding levels published.</td></tr></tbody>';

  const tenorSelect = $("trade-tenor");
  const chosen = tenorSelect.value;
  const active = state.curve.filter((level) => level.active);
  tenorSelect.innerHTML = active.length
    ? active.map((level) => `<option value="${level.tenorYears}">${level.tenorYears}Y · ${level.couponPercent.toFixed(2)}%</option>`).join("")
    : '<option value="2">no level yet</option>';
  if (active.some((level) => String(level.tenorYears) === chosen)) tenorSelect.value = chosen;

  $("lab-holding").innerHTML = i && i.token
    ? `<div><span>Investor holds</span><strong>${i.token.investor} units</strong></div><div><span>Outstanding supply</span><strong>${i.token.totalSupply} units</strong></div><div><span>Cash locked on payment ledger</span><strong>${euro(state.cash.locked)}</strong></div>`
    : `<div><span>Cash locked on payment ledger</span><strong>${euro(state.cash.locked)}</strong></div>`;

  const lastAction = (actor) => state.monitor.find((entry) => entry.type === "action" && entry.actor === actor);
  $("lab-participants").innerHTML = PARTICIPANTS.map(([name, role]) => {
    const last = lastAction(name);
    return `<div class="lab-participant"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role)}</small><p>${last ? escapeHtml(last.message) : "Listening…"}</p></div>`;
  }).join("");

  $("lab-settlements").innerHTML = i && i.settlements.length
    ? `<thead><tr><th>#</th><th>What</th><th>Payer → payee</th><th>Amount</th><th>Bond side</th><th>Cash lock</th></tr></thead><tbody>${i.settlements.map((s) => `
        <tr><td>${s.id}</td><td>${escapeHtml(s.label)}${s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}</td><td>${s.payer} → ${s.payee}</td><td>${euro(s.amount)}</td>
        <td><span class="lab-badge ${s.status === "Succeeded" ? "ok" : s.status === "Failed" ? "bad" : ""}">${escapeHtml(s.status)}</span></td>
        <td><span class="lab-badge ${s.cashLock === "RELEASED" ? "ok" : s.cashLock === "RETURNED" ? "bad" : ""}">${escapeHtml(s.cashLock)}</span></td></tr>`).join("")}</tbody>`
    : '<tbody><tr><td class="empty-state">No settlement yet.</td></tr></tbody>';

  $("lab-coupons").innerHTML = i && i.coupons.length
    ? `<thead><tr><th>Period</th><th>Date</th><th>Amount</th><th>Claim</th></tr></thead><tbody>${i.coupons.map((c) => `<tr><td>${c.period}</td><td>${date(c.date)}</td><td>${euro(c.amount)}</td><td><span class="lab-badge ${c.discharged ? "ok" : ""}">${c.discharged ? "DISCHARGED" : "OUTSTANDING"}</span></td></tr>`).join("")}
        <tr><td>Principal</td><td>${date(i.maturityDate)}</td><td>${euro(i.units * 1000)}</td><td><span class="lab-badge ${i.redemptionDischarged ? "ok" : ""}">${i.redemptionDischarged ? "DISCHARGED" : "OUTSTANDING"}</span></td></tr></tbody>`
    : '<tbody><tr><td class="empty-state">Appears once the terms are incepted.</td></tr></tbody>';

  $("lab-terms-hash").textContent = i && i.termsHash ? `keccak256 = ${i.termsHash}` : "—";
  $("lab-terms").textContent = i && i.terms ? JSON.stringify(i.terms, null, 2) : "Appears once the issuer incepts the trade.";

  $("lab-monitor").innerHTML = state.monitor.map((entry) => entry.type === "event"
    ? `<div class="activity-item lab-event"><p><span class="chain-tag ${entry.chain}">${entry.chain === "asset" ? "ASSET" : "PAYMENT"}</span> <code>${escapeHtml(entry.contract)}.${escapeHtml(entry.name)}</code> ${escapeHtml(entry.summary || "")}</p></div>`
    : `<div class="activity-item"><p><strong>${escapeHtml(entry.actor)}</strong> ${escapeHtml(entry.message)}</p><time>${new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>`).join("");
}

function paramsFor(action) {
  switch (action) {
    case "publishFundingLevel": return { tenorYears: $("curve-tenor").value, couponPercent: $("curve-coupon").value, maxUnits: $("curve-max").value };
    case "requestTrade": return { tenorYears: $("trade-tenor").value, units: $("trade-units-lab").value };
    case "lockIssuanceCash": return { amountEur: $("lock-amount").value };
    default: return {};
  }
}

async function perform(action, params = paramsFor(action)) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button, input").forEach((element) => { element.disabled = true; });
  try {
    const response = await fetch("/api/lab/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Action failed.");
    render(result.state);
    toast(action === "reset" ? "Fresh ledgers started." : "Done. The participants have reacted.");
  } catch (error) {
    toast(friendlyError(error.message), true);
  } finally {
    busy = false;
    document.querySelectorAll("button, input").forEach((element) => { element.disabled = false; });
  }
}

document.querySelectorAll("[data-lab]").forEach((button) => {
  button.addEventListener("click", () => perform(button.dataset.lab));
});
$("lab-autolock").addEventListener("change", (event) => perform("setAutoLock", { enabled: event.target.checked }));

fetch("/api/lab/state")
  .then((response) => response.json())
  .then(render)
  .catch((error) => toast(error.message, true));
