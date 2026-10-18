// Smart Bond Lab: two ledgers, event-driven participants, and the actions the
// two humans take (Group Treasury as issuer, an institutional investor).
const { ethers } = require("ethers");
const {
  ABI, STATES, SETTLEMENT_STATUS, artifact, legacyArtifact, lockIdFor,
  Network, IsinAgent, Registrar, DecryptionOracle, PartyConnector,
} = require("./participants");

const FACE_VALUE_CENTS = 100_000n; // EUR 1,000 per unit
const YEAR = 365 * 24 * 60 * 60;
const eurCents = (eur) => BigInt(Math.round(Number(eur) * 100));
const eur = (cents) => Number(ethers.formatUnits(cents, 2));
const iso = (seconds) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

async function deploy(name, signer, args = [], legacy = false) {
  const a = legacy ? legacyArtifact(name) : artifact(name);
  const contract = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

/** The structured issuance terms (simplified, inspired by the ICMA Bond Data Taxonomy). */
function buildTerms({ programme, bondAddress, issuer, investor, units, tenorYears, couponBps, issueDate }) {
  return JSON.stringify({
    note: "Simplified record inspired by the ICMA Bond Data Taxonomy; not schema-validated.",
    programme,
    issuer,
    investor,
    smartBondContract: bondAddress,
    instrument: { type: "fixed rate bond", form: "crypto security (eWpG), simulated", currency: "EUR", denomination: Number(FACE_VALUE_CENTS) / 100, units, nominal: units * Number(FACE_VALUE_CENTS) / 100 },
    interest: { rateBps: couponBps, frequency: "annual", dayCount: "ACT/ACT (ICMA), regular annual periods" },
    dates: { issueDate: iso(issueDate), maturityDate: iso(BigInt(issueDate) + BigInt(tenorYears * YEAR)), tenorYears },
    settlement: { type: "DvP", cashLeg: "cash locked on the payment ledger (Trigger Solution model)", keys: "ERC-7573 style, oracle-generated" },
  });
}

/** What the investor's connector checks before confirming: the record says what the contract enforces. */
async function verifyTerms(bond, investorAddress) {
  const terms = JSON.parse(await bond.terms());
  const checks = [
    [ethers.getAddress(terms.smartBondContract) === ethers.getAddress(await bond.getAddress()), "contract address"],
    [ethers.getAddress(terms.investor) === ethers.getAddress(investorAddress), "investor"],
    [BigInt(terms.instrument.units) === (await bond.units()), "units"],
    [BigInt(terms.interest.rateBps) === (await bond.couponBps()), "coupon"],
    [terms.dates.issueDate === iso(await bond.issueDate()), "issue date"],
    [terms.dates.maturityDate === iso(await bond.maturityDate()), "maturity date"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
  if (failed.length) throw new Error(`Terms record and contract differ: ${failed.join(", ")}`);
  return ethers.keccak256(ethers.toUtf8Bytes(await bond.terms()));
}

class SmartBondLab {
  /**
   * `chains` = { asset: { provider, signers }, payment: { provider, signers } } with signers
   * [issuer, investor, registrar, isinAgent, oracle, cashBank]; the same index is the same party.
   */
  static async create(chains, { programme = "Demo Group Treasury EUR Programme" } = {}) {
    const lab = new SmartBondLab();
    lab.chains = chains;
    lab.programme = programme;
    const [issuer, investor, registrar, isinAgent, oracle] = chains.asset.signers;
    const [issuerP, investorP, , , , bank] = chains.payment.signers;
    lab.parties = { issuer, investor, registrar, isinAgent, oracle, issuerP, investorP, bank };

    lab.factory = await deploy("SmartBondFactory", issuer, [programme, await registrar.getAddress(), await isinAgent.getAddress(), await oracle.getAddress(), FACE_VALUE_CENTS]);
    lab.cash = await deploy("TokenisedEuro", bank, [], true);
    lab.cashLock = await deploy("CashLock", bank, [await lab.cash.getAddress()]);
    await (await lab.cash.mint(await investorP.getAddress(), eurCents(1_000_000))).wait();
    await (await lab.cash.mint(await issuerP.getAddress(), eurCents(250_000))).wait();

    lab.net = new Network({ asset: { provider: chains.asset.provider }, payment: { provider: chains.payment.provider } });
    lab.net.watch("asset", "Factory", await lab.factory.getAddress());
    lab.net.watch("payment", "CashLock", await lab.cashLock.getAddress());
    lab.issuerConnector = new PartyConnector({ label: "Issuer's connector", assetSigner: issuer, paymentSigner: issuerP, cashLock: lab.cashLock, cash: lab.cash, autoLockCash: true });
    lab.investorConnector = new PartyConnector({ label: "Investor's connector", assetSigner: investor, paymentSigner: investorP, cashLock: lab.cashLock, cash: lab.cash });
    lab.oracle = new DecryptionOracle(oracle, await lab.cashLock.getAddress());
    for (const p of [new IsinAgent(isinAgent), new Registrar(registrar), lab.oracle, lab.issuerConnector, lab.investorConnector]) lab.net.join(p);
    lab.net.join({ on: async (event, net) => {
      // New Smart Bond instances join the network as soon as the factory deploys them.
      if (event.contract === "Factory" && event.name === "TradeRequested") net.watch("asset", "SmartBond", event.args.instance);
    } });
    await lab.net.startCursors();
    lab.net.note("Setup", `Programme "${programme}" deployed. The investor holds EUR 1,000,000 and the issuer EUR 250,000 on the payment ledger.`);
    return lab;
  }

  bond(address, signer) {
    return new ethers.Contract(address, ABI.SmartBond, signer);
  }

  async latestInstance() {
    const count = await this.factory.instanceCount();
    if (count === 0n) throw new Error("No trade has been requested yet.");
    return this.factory.instances(count - 1n);
  }

  /** Runs one human action, then lets the participants react until everything settles. */
  async act(actor, description, fn) {
    const tx = await fn();
    if (tx && tx.wait) await tx.wait();
    this.net.note(actor, description, tx && tx.hash);
    await this.net.pump();
  }

  // ---- Group Treasury (issuer) ----

  async publishFundingLevel(tenorYears, couponPercent, maxUnits) {
    const bps = Math.round(Number(couponPercent) * 100);
    return this.act("Group Treasury", `Published the ${tenorYears}Y funding level: ${Number(couponPercent).toFixed(2)}% for up to ${maxUnits} units.`,
      () => this.factory.connect(this.parties.issuer).publishFundingLevel(tenorYears, bps, maxUnits));
  }

  async approveInvestor() {
    return this.act("Group Treasury", "Admitted the investor to the programme (eligibility after onboarding).",
      async () => this.factory.connect(this.parties.issuer).setEligibleInvestor(await this.parties.investor.getAddress(), true));
  }

  async inceptTrade({ couponPercent } = {}) {
    const address = await this.latestInstance();
    const bond = this.bond(address, this.parties.issuer);
    const couponBps = couponPercent === undefined ? Number(await bond.indicativeCouponBps()) : Math.round(Number(couponPercent) * 100);
    const issueDate = (await this.chains.asset.provider.getBlock("latest")).timestamp;
    const terms = buildTerms({
      programme: this.programme, bondAddress: address,
      issuer: await this.parties.issuer.getAddress(), investor: await this.parties.investor.getAddress(),
      units: Number(await bond.units()), tenorYears: Number(await bond.tenorYears()), couponBps, issueDate,
    });
    return this.act("Group Treasury", `Incepted the trade with final terms at ${(couponBps / 100).toFixed(2)}%.`,
      () => bond.inceptTrade(terms, couponBps, issueDate));
  }

  async payCoupon() {
    const address = await this.latestInstance();
    const bond = this.bond(address, this.parties.issuer);
    let period = 1;
    while (await bond.discharged(period)) period += 1;
    return this.act("Group Treasury", `Opened the settlement of coupon ${period}.`, () => bond.openCouponSettlement(period));
  }

  // ---- Investor ----

  async requestTrade(tenorYears, units) {
    return this.act("Investor", `Requested ${units} units at the ${tenorYears}Y funding level.`,
      () => this.factory.connect(this.parties.investor).requestTrade(tenorYears, units));
  }

  async confirmTrade() {
    const bond = this.bond(await this.latestInstance(), this.parties.investor);
    const hash = await verifyTerms(bond, await this.parties.investor.getAddress());
    return this.act("Investor", "Checked the terms record against the contract and confirmed its hash. The terms are now immutable.",
      () => bond.confirmTrade(hash));
  }

  /** The investor locks the purchase price; `amountEur` lets you try a wrong amount. */
  async lockIssuanceCash(amountEur) {
    const address = await this.latestInstance();
    const bond = this.bond(address, this.parties.investor);
    const id = await bond.openSettlement(0);
    if (id === 0n) throw new Error("There is no open issuance settlement.");
    const s = await bond.settlements(id);
    const amount = amountEur === undefined ? s.amount : eurCents(amountEur);
    const cash = this.cash.connect(this.parties.investorP);
    await (await cash.approve(await this.cashLock.getAddress(), amount)).wait();
    return this.act("Investor", `Locked EUR ${eur(amount).toLocaleString("en-GB")} on the payment ledger for the purchase (settlement #${id}).`,
      () => this.cashLock.connect(this.parties.investorP).lock(lockIdFor(address, id), s.payee, amount, s.hashSuccess, s.hashFailure));
  }

  async abortIssuance() {
    const bond = this.bond(await this.latestInstance(), this.parties.investor);
    const id = await bond.openSettlement(0);
    return this.act("Investor", `Aborted settlement #${id} before delivery.`, () => bond.abort(id));
  }

  async retryIssuance() {
    const bond = this.bond(await this.latestInstance(), this.parties.investor);
    return this.act("Investor", "Opened a new issuance settlement attempt with fresh keys.", () => bond.retrySettlement(0));
  }

  async requestRedemption() {
    const bond = this.bond(await this.latestInstance(), this.parties.investor);
    return this.act("Investor", "Requested redemption at maturity.", () => bond.requestRedemption());
  }

  // ---- Simulation clock ----

  async advanceTo(target, label) {
    const provider = this.chains.asset.provider;
    const now = (await provider.getBlock("latest")).timestamp;
    if (Number(target) > now) {
      await provider.send("evm_increaseTime", [Number(target) - now]);
      await provider.send("evm_mine", []);
    }
    this.net.note("Clock", label);
  }

  async advanceToNextCoupon() {
    const bond = this.bond(await this.latestInstance(), this.parties.issuer);
    let period = 1;
    while (await bond.discharged(period)) period += 1;
    if (period > Number(await bond.couponCount())) throw new Error("All coupons are paid.");
    await this.advanceTo(await bond.couponDate(period), `Moved to the date of coupon ${period}.`);
  }

  async advanceToMaturity() {
    const bond = this.bond(await this.latestInstance(), this.parties.issuer);
    await this.advanceTo(await bond.maturityDate(), "Moved to maturity.");
  }

  // ---- View ----

  async state() {
    const factory = this.factory;
    const tenorCount = Number(await factory.tenorCount());
    const curve = [];
    for (let i = 0; i < tenorCount; i += 1) {
      const tenor = await factory.tenors(i);
      const level = await factory.fundingLevels(tenor);
      curve.push({ tenorYears: Number(tenor), couponPercent: Number(level.couponBps) / 100, maxUnits: Number(level.maxUnits), active: level.active });
    }
    curve.sort((a, b) => a.tenorYears - b.tenorYears);

    const investorAddress = await this.parties.investor.getAddress();
    const issuerAddress = await this.parties.issuer.getAddress();
    const view = {
      programme: this.programme,
      blockTime: (await this.chains.asset.provider.getBlock("latest")).timestamp,
      investorEligible: await factory.isEligibleInvestor(investorAddress),
      curve,
      cash: {
        issuer: eur(await this.cash.balanceOf(issuerAddress)),
        investor: eur(await this.cash.balanceOf(investorAddress)),
        locked: eur(await this.cash.balanceOf(await this.cashLock.getAddress())),
      },
      instance: null,
      monitor: [...this.net.monitor].reverse().slice(0, 150),
    };

    const count = await factory.instanceCount();
    if (count === 0n) return view;
    const address = await factory.instances(count - 1n);
    const bond = this.bond(address, this.parties.issuer);
    const stateIndex = Number(await bond.state());
    const couponCount = Number(await bond.couponCount());
    const issued = stateIndex >= 2;
    const tokenAddress = await bond.token();
    const hasToken = tokenAddress !== ethers.ZeroAddress;
    const token = hasToken ? new ethers.Contract(tokenAddress, ABI.BondToken, this.parties.issuer) : null;

    const purposes = [0, ...Array.from({ length: couponCount }, (_, i) => i + 1), couponCount + 1];
    const settlements = [];
    for (const purpose of purposes) {
      const attempts = Number(await bond.attemptCount(purpose));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const id = purpose * 100 + attempt;
        const s = await bond.settlements(id);
        const lock = await this.cashLock.locks(lockIdFor(address, id));
        settlements.push({
          id, purpose, attempt,
          label: purpose === 0 ? "Issuance" : purpose === couponCount + 1 ? "Redemption" : `Coupon ${purpose}`,
          payer: ethers.getAddress(s.payer) === issuerAddress ? "Issuer" : "Investor",
          payee: ethers.getAddress(s.payee) === issuerAddress ? "Issuer" : "Investor",
          amount: eur(s.amount),
          status: SETTLEMENT_STATUS[Number(s.status)],
          cashLock: ["—", "LOCKED", "RELEASED", "RETURNED"][Number(lock.status)],
        });
      }
    }

    view.instance = {
      address,
      state: STATES[stateIndex],
      stateIndex,
      states: STATES,
      units: Number(await bond.units()),
      tenorYears: Number(await bond.tenorYears()),
      indicativeCouponPercent: Number(await bond.indicativeCouponBps()) / 100,
      couponPercent: issued || stateIndex === 1 ? Number(await bond.couponBps()) / 100 : null,
      termsHash: stateIndex >= 1 ? await bond.termsHash() : null,
      terms: stateIndex >= 1 ? JSON.parse(await bond.terms()) : null,
      isin: await bond.isin(),
      token: hasToken ? { address: tokenAddress, issuer: Number(await token.balanceOf(issuerAddress)), investor: Number(await token.balanceOf(investorAddress)), totalSupply: Number(await token.totalSupply()) } : null,
      maturityDate: stateIndex >= 1 ? Number(await bond.maturityDate()) : null,
      coupons: stateIndex >= 1 ? await Promise.all(Array.from({ length: couponCount }, async (_, i) => ({
        period: i + 1,
        date: Number(await bond.couponDate(i + 1)),
        amount: eur(await bond.couponAmount()),
        discharged: await bond.discharged(i + 1),
      }))) : [],
      redemptionDischarged: await bond.discharged(couponCount + 1),
      openIssuanceSettlement: Number(await bond.openSettlement(0)),
      settlements,
    };
    return view;
  }
}

module.exports = { SmartBondLab, buildTerms, verifyTerms, FACE_VALUE_CENTS };
