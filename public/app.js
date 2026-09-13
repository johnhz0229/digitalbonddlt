const $ = (id) => document.getElementById(id);
let busy = false;

const errorMessages = {
  InvestorNotWhitelisted: "Compliance control blocked this transaction: the investor is not whitelisted.",
  OnlyIssuer: "Authority control blocked this transaction: only the issuer may perform it.",
  InsufficientBalance: "Settlement failed: the investor does not hold enough bond units.",
  CouponNotDue: "The coupon cannot be paid before its scheduled date or after maturity.",
  BondNotMatured: "Principal funding is only available after the maturity date.",
  RedemptionNotFunded: "The issuer must fund principal before investors can redeem.",
  InvalidAmount: "Enter a valid positive amount.",
};

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(timestamp * 1000));
}

function trimAmount(value) {
  const number = Number(value);
  return number.toLocaleString("en-GB", { maximumFractionDigits: 6 });
}

function setText(id, value) { $(id).textContent = value; }

function renderInvestor(name, data) {
  setText(`${name}-status`, data.whitelisted ? "Whitelisted" : "Not approved");
  setText(`${name}-units`, data.units);
  setText(`${name}-coupon`, trimAmount(data.couponReceived));
  setText(`${name}-principal`, trimAmount(data.principalReceived));
  $(`${name}-card`).classList.toggle("approved", data.whitelisted);
}

function render(state) {
  setText("contract-address", state.contractAddress);
  setText("phase", state.phase.replaceAll("_", " "));
  setText("supply", state.totalSupply);
  setText("coupons-paid", state.couponsPaid);
  setText("block-time", formatDate(state.blockTime));
  setText("bond-name", state.terms.name);
  setText("bond-symbol", state.terms.symbol);
  setText("face-value", `${trimAmount(state.terms.faceValue)} test unit`);
  setText("coupon-rate", `${state.terms.annualCouponPercent.toFixed(2)}% p.a.`);
  setText("next-coupon", formatDate(state.terms.nextCouponDate));
  setText("maturity", formatDate(state.terms.maturityDate));
  renderInvestor("alice", state.accounts.alice);
  renderInvestor("bob", state.accounts.bob);

  $("activity").innerHTML = state.activity.map((item) => `
    <div class="activity-item">
      <p>${escapeHtml(item.message)}</p>
      <time>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
    </div>`).join("");
}

function escapeHtml(text) {
  const node = document.createElement("div");
  node.textContent = text;
  return node.innerHTML;
}

function toast(message, isError = false) {
  const element = $("toast");
  element.textContent = message;
  element.className = `show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ""; }, 4000);
}

function friendlyError(message) {
  const match = Object.keys(errorMessages).find((key) => message.includes(key));
  return match ? errorMessages[match] : message;
}

function activateTab(name) {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === name);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refresh() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not read the local ledger.");
  render(await response.json());
}

async function perform(action, params = {}) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Transaction failed.");
    render(result.state);
    const confirmations = {
      reset: "The current bond has been reset with the same terms.",
      configure: "New terms deployed. A fresh Solidity bond is now live.",
    };
    toast(confirmations[action] || "Transaction confirmed on the local ledger.");
  } catch (error) {
    toast(friendlyError(error.message), true);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => perform(button.dataset.action, { investor: button.dataset.investor }));
});

document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

document.querySelectorAll("[data-open-tab]").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.openTab));
});

const requestedView = new URLSearchParams(window.location.search).get("view");
if (["overview", "demo", "requirements", "assurance"].includes(requestedView)) {
  activateTab(requestedView);
}

$("issue-button").addEventListener("click", () => perform("issue", {
  investor: $("issue-investor").value,
  units: $("issue-units").value,
}));

$("configure-button").addEventListener("click", () => perform("configure", {
  name: $("config-name").value,
  symbol: $("config-symbol").value,
  faceValue: $("config-face-value").value,
  couponPercent: $("config-coupon").value,
  couponIntervalDays: $("config-frequency").value,
  maturityYears: $("config-maturity").value,
}));

$("transfer-button").addEventListener("click", () => perform("transfer", {
  from: $("transfer-from").value,
  to: $("transfer-to").value,
  units: $("transfer-units").value,
}));

if (window.location.protocol === "file:") {
  setText("phase", "PREVIEW");
  setText("contract-address", "Run npm run demo to connect the local Solidity ledger");
  toast("Visual preview only. Run npm run demo and open http://127.0.0.1:3000 for live transactions.");
} else {
  refresh().catch((error) => toast(error.message, true));
}
