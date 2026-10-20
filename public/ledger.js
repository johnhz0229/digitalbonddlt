// In-browser ledger for the static build: runs TokenizedBond on Ganache inside
// the page and exposes the same state/action interface as /api/state and /api/action.
(() => {
  const { ethers } = window;
  const artifact = window.BOND_ARTIFACT;
  const DAY = 24 * 60 * 60;
  const TERMS = { name: "Demo Digital Bond 2027", symbol: "DDB27", faceValue: "1", couponPercent: 5, couponIntervalDays: 90, maturityYears: 1 };
  const INVESTORS = ["alice", "bob", "carol"];
  const bondInterface = new ethers.Interface(artifact.abi);

  let ctx = null;
  let queue = Promise.resolve();

  async function initialize() {
    if (ctx) await ctx.raw.disconnect();
    const raw = window.Ganache.provider({
      logging: { quiet: true },
      wallet: { totalAccounts: 4, defaultBalance: 10_000 },
      chain: { chainId: 1337, hardfork: "shanghai" },
      miner: { blockGasLimit: 30_000_000 },
    });
    // cacheTimeout -1: never reuse a cached (e.g. failed) gas estimate after state changes.
    const provider = new ethers.BrowserProvider(raw, undefined, { cacheTimeout: -1 });
    const signers = await Promise.all([0, 1, 2, 3].map((index) => provider.getSigner(index)));
    const actors = {
      issuer: { label: "Issuer", signer: signers[0] },
      alice: { label: "Investor Alice", signer: signers[1] },
      bob: { label: "Investor Bob", signer: signers[2] },
      carol: { label: "Investor Carol", signer: signers[3] },
    };
    for (const a of Object.values(actors)) a.address = await a.signer.getAddress();
    const latest = await provider.getBlock("latest");
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signers[0]);
    const bond = await factory.deploy(
      TERMS.name,
      TERMS.symbol,
      ethers.parseEther(TERMS.faceValue),
      Math.round(TERMS.couponPercent * 100),
      TERMS.couponIntervalDays * DAY,
      latest.timestamp + (TERMS.maturityYears * 365 + 1) * DAY
    );
    await bond.waitForDeployment();
    const payments = Object.fromEntries(INVESTORS.map((name) => [name, { coupon: 0n, principal: 0n }]));
    ctx = { raw, provider, actors, bond, payments };
  }

  function nameOf(value) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
      if (value === ethers.ZeroAddress) return "0x0";
      const match = Object.entries(ctx.actors).find(([, a]) => a.address.toLowerCase() === value.toLowerCase());
      return match ? match[0] : `${value.slice(0, 8)}…`;
    }
    return typeof value === "bigint" ? value.toString() : String(value);
  }

  async function state() {
    const { bond, actors, payments, provider } = ctx;
    const block = await provider.getBlock("latest");
    const accounts = {};
    for (const name of INVESTORS) {
      accounts[name] = {
        label: actors[name].label,
        address: actors[name].address,
        whitelisted: await bond.isWhitelisted(actors[name].address),
        units: Number(await bond.balanceOf(actors[name].address)),
        couponReceived: ethers.formatEther(payments[name].coupon),
        principalReceived: ethers.formatEther(payments[name].principal),
      };
    }
    return {
      contractAddress: await bond.getAddress(),
      blockTime: block.timestamp,
      terms: {
        name: await bond.name(),
        symbol: await bond.symbol(),
        faceValue: ethers.formatEther(await bond.faceValue()),
        annualCouponPercent: Number(await bond.annualCouponRateBps()) / 100,
        couponPerUnit: ethers.formatEther(await bond.couponPerUnit()),
        couponIntervalDays: TERMS.couponIntervalDays,
        nextCouponDate: Number(await bond.nextCouponDate()),
        maturityDate: Number(await bond.maturityDate()),
      },
      totalSupply: Number(await bond.totalSupply()),
      couponsPaid: Number(await bond.couponsPaid()),
      redemptionFunded: await bond.redemptionFunded(),
      accounts,
      events: (await bond.queryFilter("*", 0)).slice(-60).reverse().map((log) => ({
        block: log.blockNumber,
        name: log.fragment ? log.fragment.name : "unknown",
        args: log.fragment ? log.fragment.inputs.map((input, i) => `${input.name}=${nameOf(log.args[i])}`).join(", ") : "",
      })),
    };
  }

  async function advanceTime(target) {
    const block = await ctx.provider.getBlock("latest");
    if (block.timestamp < target) {
      await ctx.provider.send("evm_increaseTime", [target - block.timestamp]);
      await ctx.provider.send("evm_mine", []);
    }
  }

  function actor(name) {
    const selected = ctx.actors[name];
    if (!selected) throw new Error(`Unknown participant: ${name}`);
    return selected;
  }

  async function send(signer, method, ...args) {
    const tx = await ctx.bond.connect(signer)[method](...args);
    await tx.wait();
  }

  async function transact(action, params) {
    const { bond, actors, payments } = ctx;
    const issuer = actors.issuer.signer;
    switch (action) {
      case "reset":
        return initialize();
      case "whitelist":
        return send(issuer, "setWhitelisted", actor(params.investor).address, true);
      case "issue":
        return send(issuer, "issue", actor(params.investor).address, Number(params.units));
      case "transfer":
        return send(actor(params.from).signer, "transfer", actor(params.to).address, Number(params.units));
      case "issueAsInvestor":
        // Deliberate violation: an investor tries to issue units (AC2.1).
        return send(actors.alice.signer, "issue", actors.alice.address, 5);
      case "advanceCoupon": {
        const next = Number(await bond.nextCouponDate());
        if (next >= Number(await bond.maturityDate())) throw new Error("No coupon date remains before maturity.");
        return advanceTime(next);
      }
      case "payCoupon": {
        const perUnit = await bond.couponPerUnit();
        const balances = {};
        for (const name of INVESTORS) balances[name] = await bond.balanceOf(actors[name].address);
        await send(issuer, "payCoupon", { value: perUnit * (await bond.totalSupply()) });
        for (const name of INVESTORS) payments[name].coupon += perUnit * balances[name];
        return;
      }
      case "payCouponWrongAmount": {
        // Deliberate violation: the coupon is underpaid by one wei (AC4.3).
        const due = (await bond.couponPerUnit()) * (await bond.totalSupply());
        return send(issuer, "payCoupon", { value: due > 0n ? due - 1n : 1n });
      }
      case "advanceMaturity":
        return advanceTime(Number(await bond.maturityDate()));
      case "fundRedemption":
        return send(issuer, "fundRedemption", { value: (await bond.faceValue()) * (await bond.totalSupply()) });
      case "fundRedemptionWrongAmount": {
        // Deliberate violation: principal funding is short by one wei (AC5.2).
        const due = (await bond.faceValue()) * (await bond.totalSupply());
        return send(issuer, "fundRedemption", { value: due > 0n ? due - 1n : 1n });
      }
      case "redeem": {
        const investor = actor(params.investor);
        const principal = (await bond.balanceOf(investor.address)) * (await bond.faceValue());
        await send(investor.signer, "redeem");
        payments[params.investor].principal += principal;
        return;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  // Ganache nests revert data where ethers does not look, so decode custom errors here.
  function revertReason(error) {
    const data = error?.data || error?.info?.error?.data?.result || error?.info?.error?.data;
    if (typeof data !== "string" || data.length < 10) return null;
    try {
      return bondInterface.parseError(data)?.name || null;
    } catch {
      return null;
    }
  }

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  const ready = initialize();

  window.BondLedger = {
    state: () => serialize(async () => { await ready; return state(); }),
    action: (action, params = {}) => serialize(async () => {
      await ready;
      try {
        await transact(action, params);
      } catch (error) {
        throw new Error(revertReason(error) || error.shortMessage || error.message || "Transaction failed.");
      }
      return state();
    }),
  };
})();
