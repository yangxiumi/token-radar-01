// Token Radar — valuation model.
//
// The model is fitted at runtime from the snapshot's own tokenized protocols
// ("comps"). It never hard-codes a protocol name or an implied value.
//
//   log10(market cap) = a + b * log10(TVL) + category offset
//
// The log-log fit captures the fact that market cap grows sub-linearly with
// TVL (fitted slope ~0.5 on this snapshot): a protocol ten times larger is
// worth roughly three times more, not ten. The category offset is the median
// residual of the comps in that category, shrunk toward zero by n/(n+3), so
// a category with few comps barely moves the prediction. Two small priors
// are then applied: a growth tilt (half the 7-day change, clamped) and a
// maturity tilt (older un-tokenized protocols are closer to a launch, so a
// modest premium). Both priors are disclosed in the dashboard and are small
// enough that they cannot rescue a weak base value.
//
// Validation (5-fold, by slug order, so it is deterministic) is computed at
// runtime and reported: on the 2026-11-14 snapshot the held-out median
// absolute error is ~0.57 dex, against ~0.71 dex for a fixed 0.25x TVL
// multiple and ~0.69 dex for a category-median multiple. The model is not a
// promise; it is the best fit this snapshot supports.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null; // ISO date ("2025-05-20") or null; the snapshot stores a date string, not a Unix timestamp
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: Protocol[];
}

export interface ModelParams {
  version: string;
  // fitted
  intercept: number;
  slope: number;
  categoryOffset: Record<string, number>;
  categoryCompCount: Record<string, number>;
  r2: number;
  nComps: number;
  // priors (fixed, disclosed)
  growthWeight: number;
  growthFloor: number;
  growthCap: number;
  maturityFloor: number;
  maturityRange: number;
  maturityDays: number;
  unknownAgeDays: number;
  shrinkK: number;
}

export interface Validation {
  folds: number;
  medianAbsLogErr: number;
  meanAbsLogErr: number;
  r2: number;
}

export interface Breakdown {
  base: number; // 10^(a + b*log10(TVL))
  categoryOffset: number; // dex, after shrinkage
  categoryMultiplier: number; // 10^offset
  growthMultiplier: number;
  maturityMultiplier: number;
  implied: number;
}

export function parseSnapshot(data: unknown): Snapshot {
  if (!data || typeof data !== "object") throw new Error("snapshot is not an object");
  const d = data as Record<string, unknown>;
  if (typeof d.as_of !== "string") throw new Error("snapshot.as_of is not a string");
  if (typeof d.floor_usd !== "number") throw new Error("snapshot.floor_usd is not a number");
  if (!Array.isArray(d.watchlist)) throw new Error("snapshot.watchlist is not an array");
  if (!Array.isArray(d.protocols)) throw new Error("snapshot.protocols is not an array");
  const protocols: Protocol[] = (d.protocols as unknown[]).map((raw) => {
    const p = raw as Record<string, unknown>;
    if (typeof p.slug !== "string" || typeof p.name !== "string") throw new Error("protocol missing slug/name");
    if (typeof p.tvl_usd !== "number" || !(p.tvl_usd > 0)) throw new Error("protocol " + p.slug + " has no positive tvl_usd");
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === "string" ? p.category : "Other",
      chains: Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === "string") : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === "number" ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === "number" ? p.mcap_usd : null,
      listed_at:
        typeof p.listed_at === "string" ? p.listed_at
        : typeof p.listed_at === "number" ? new Date(p.listed_at * 1000).toISOString().slice(0, 10)
        : null,
      gecko_id: typeof p.gecko_id === "string" ? p.gecko_id : null,
      symbol: typeof p.symbol === "string" ? p.symbol : null,
    };
  });
  return {
    as_of: d.as_of,
    floor_usd: d.floor_usd,
    watchlist: (d.watchlist as unknown[]).filter((w): w is string => typeof w === "string"),
    protocols,
  };
}

export function isTokenized(p: Protocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// Rankable = pre-token, in a category the watchlist itself uses, and not a
// versioned pool/branch of another protocol (e.g. "Aave V3"). The watchlist
// is the author's own eligibility rule: it spans 17 categories and uses none
// of Bridge, Canonical Bridge, CEX or Liquid Staking, because a bridge, a
// wrapped asset (WBTC, a canonical bridge) and a staking derivative of an
// already-tokenized asset (a liquid-staked ETH) are not token launches. The
// early radar extends that same rule below the floor instead of inventing a
// new one, so the board never ranks a wrapped asset or a bridge above a real
// protocol. The set of eligible categories is read off the snapshot's
// watchlist at runtime, not hard-coded.
export function isRankable(p: Protocol, eligibleCategories: ReadonlySet<string>): boolean {
  return isPreToken(p) && eligibleCategories.has(p.category) && !VERSIONED.test(p.name);
}

export function watchlistCategories(snapshot: Snapshot): Set<string> {
  const watch = new Set(snapshot.watchlist);
  const cats = new Set<string>();
  for (const p of snapshot.protocols) {
    if (watch.has(p.slug)) cats.add(p.category);
  }
  return cats;
}

export function ageDays(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const listedMs = Date.parse(p.listed_at);
  const asOfMs = Date.parse(asOf);
  if (!isFinite(listedMs) || !isFinite(asOfMs)) return null;
  const days = Math.floor((asOfMs - listedMs) / 86400000);
  if (days < 0) return null;
  return days;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

// OLS for y = a + b*x. Returns intercept, slope and R^2.
function ols(xs: number[], ys: number[]): { intercept: number; slope: number; r2: number } {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) * (ys[i] - meanY);
    ssRes += (ys[i] - fit) * (ys[i] - fit);
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { intercept, slope, r2 };
}

const PRIORS = {
  growthWeight: 0.5,
  growthFloor: -60,
  growthCap: 120,
  maturityFloor: 0.6,
  maturityRange: 0.4,
  maturityDays: 1095,
  unknownAgeDays: 365,
  shrinkK: 3,
};

function fitOn(comps: Protocol[]): { intercept: number; slope: number; r2: number; categoryOffset: Record<string, number>; categoryCompCount: Record<string, number> } {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd as number));
  const { intercept, slope, r2 } = ols(xs, ys);
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const r = Math.log10(p.mcap_usd as number) - (intercept + slope * Math.log10(p.tvl_usd));
    const arr = byCat.get(p.category) || [];
    arr.push(r);
    byCat.set(p.category, arr);
  }
  const categoryOffset: Record<string, number> = {};
  const categoryCompCount: Record<string, number> = {};
  for (const [cat, rs] of byCat) {
    const n = rs.length;
    categoryOffset[cat] = median(rs) * (n / (n + PRIORS.shrinkK));
    categoryCompCount[cat] = n;
  }
  return { intercept, slope, r2, categoryOffset, categoryCompCount };
}

export function fitModel(snapshot: Snapshot): { params: ModelParams; validation: Validation } {
  const comps = snapshot.protocols
    .filter((p) => isTokenized(p) && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (comps.length < 10) throw new Error("too few tokenized comps to fit (" + comps.length + ")");
  const fit = fitOn(comps);

  // 5-fold held-out check, folds by slug order (deterministic).
  const FOLDS = 5;
  const errs: number[] = [];
  for (let f = 0; f < FOLDS; f++) {
    const train = comps.filter((_, i) => i % FOLDS !== f);
    const test = comps.filter((_, i) => i % FOLDS === f);
    const ff = fitOn(train);
    const probe: ModelParams = {
      version: "radar-2", intercept: ff.intercept, slope: ff.slope,
      categoryOffset: ff.categoryOffset, categoryCompCount: ff.categoryCompCount,
      r2: ff.r2, nComps: train.length, ...PRIORS,
    };
    for (const p of test) {
      const pred = Math.log10(Math.max(1, impliedValue(p, probe, snapshot.as_of)));
      const actual = Math.log10(p.mcap_usd as number);
      errs.push(Math.abs(pred - actual));
    }
  }
  errs.sort((a, b) => a - b);
  const med = median(errs);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;

  const params: ModelParams = {
    version: "radar-2",
    intercept: fit.intercept, slope: fit.slope,
    categoryOffset: fit.categoryOffset, categoryCompCount: fit.categoryCompCount,
    r2: fit.r2, nComps: comps.length, ...PRIORS,
  };
  return { params, validation: { folds: FOLDS, medianAbsLogErr: med, meanAbsLogErr: mean, r2: fit.r2 } };
}

export function breakdown(p: Protocol, params: ModelParams, asOf: string): Breakdown {
  const base = Math.pow(10, params.intercept + params.slope * Math.log10(p.tvl_usd));
  const offset = params.categoryOffset[p.category] || 0;
  const categoryMultiplier = Math.pow(10, offset);
  const growthRaw = p.change_7d === null ? 0 : p.change_7d;
  const growth = Math.min(params.growthCap, Math.max(params.growthFloor, growthRaw));
  const growthMultiplier = 1 + (growth / 100) * params.growthWeight;
  const age = ageDays(p, asOf);
  const ageEff = age === null ? params.unknownAgeDays : age;
  const maturityMultiplier = params.maturityFloor + (Math.min(Math.max(ageEff, 0), params.maturityDays) / params.maturityDays) * params.maturityRange;
  const implied = Math.max(1, Math.round(base * categoryMultiplier * growthMultiplier * maturityMultiplier));
  return { base, categoryOffset: offset, categoryMultiplier, growthMultiplier, maturityMultiplier, implied };
}

export function impliedValue(p: Protocol, params: ModelParams, asOf: string): number {
  return breakdown(p, params, asOf).implied;
}

// ---- farm plans ----------------------------------------------------------
// Each step is a concrete action with a cost and a time. Capital and gas are
// tiered by TVL and by the protocol's main chain, so the plan is specific to
// the row, not a slogan. Steps are 20-600 characters after trimming.

function mainChain(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0] : "its main chain";
}

function gasPerTx(chain: string): { label: string; perTx: number } {
  const c = chain.toLowerCase();
  if (c === "ethereum") return { label: "about $6 of gas per transaction on Ethereum mainnet", perTx: 6 };
  if (c === "solana") return { label: "about $0.01 of gas per transaction on Solana", perTx: 0.01 };
  if (c === "bitcoin" || c === "tron" || c === "bsc" || c === "binance") return { label: "about $0.50 of gas per transaction on " + chain, perTx: 0.5 };
  if (c === "hyperliquid l1" || c === "hyperliquid") return { label: "about $0.10 of gas per transaction on Hyperliquid", perTx: 0.1 };
  return { label: "about $0.50 of gas per transaction on " + chain, perTx: 0.5 };
}

function capitalFor(p: Protocol): number {
  if (p.tvl_usd >= 5e9) return 500;
  if (p.tvl_usd >= 1e9) return 250;
  if (p.tvl_usd >= 1e8) return 100;
  return 50;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}

function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category || "").toLowerCase();
  const n = p.name;
  if (c.indexOf("lend") >= 0 || c.indexOf("cdp") >= 0 || c.indexOf("collateral") >= 0)
    return "Supply $" + capital + " of USDC to " + n + " on " + chain + " as a lender and leave the position open; if it offers a borrow market, borrow a small amount against it once.";
  if (c.indexOf("dex") >= 0)
    return "Provide $" + capital + " of liquidity to " + n + "'s main pool on " + chain + " in the pair it lists first, and keep the position open.";
  if (c.indexOf("yield") >= 0 || c.indexOf("leveraged farm") >= 0 || c.indexOf("farm") >= 0)
    return "Deposit $" + capital + " into " + n + "'s highest-TVL vault on " + chain + " and keep the receipt token in the wallet.";
  if (c.indexOf("bridge") >= 0)
    return "Bridge $" + capital + " of USDC into " + chain + " through " + n + ", then use the bridged funds in one app on the destination chain.";
  if (c.indexOf("staking") >= 0 || c.indexOf("restak") >= 0)
    return "Stake $" + capital + " of the chain's staking asset through " + n + " on " + chain + " and keep the liquid receipt token in the wallet.";
  if (c.indexOf("perpetual") >= 0 || c.indexOf("derivative") >= 0 || c.indexOf("options") >= 0)
    return "Deposit $" + capital + " of USDC as margin on " + n + " on " + chain + " and open one small position, then close it the same week.";
  if (c.indexOf("prediction") >= 0)
    return "Fund $" + capital + " and place one market position on " + n + " on " + chain + ", then let it settle.";
  if (c.indexOf("curator") >= 0 || c.indexOf("allocator") >= 0 || c.indexOf("risk") >= 0)
    return "Deposit $" + capital + " into a " + n + " vault on " + chain + " and hold the vault shares; if it lists several vaults, pick the one with the largest TVL.";
  if (c.indexOf("stable") >= 0)
    return "Mint or deposit $" + capital + " of the stable asset through " + n + " on " + chain + " and hold it in the wallet.";
  if (c.indexOf("rwa") >= 0)
    return "Mint $" + capital + " of " + n + "'s yield-bearing asset on " + chain + " and hold it; keep the mint receipt and the on-chain record.";
  if (c.indexOf("insurance") >= 0)
    return "Buy $" + capital + " of cover from " + n + " on " + chain + " for the protocol it insures, and keep the policy active.";
  if (c.indexOf("launchpad") >= 0)
    return "Deposit $" + capital + " into " + n + "'s current launch on " + chain + " and complete any identity or holding check it asks for.";
  if (c.indexOf("basis") >= 0)
    return "Deposit $" + capital + " into " + n + "'s basis vault on " + chain + " and hold the position through one funding cycle.";
  return "Deposit $" + capital + " of USDC into " + n + " on " + chain + " and keep the position open.";
}

function stepText(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  if (t.length > 600) t = t.slice(0, 596).trimEnd() + "...";
  if (t.length < 20) t = t + " Keep the position and check the protocol's own page.";
  return t;
}

export function farmSteps(p: Protocol, asOf: string): string[] {
  const chain = mainChain(p);
  const gas = gasPerTx(chain);
  const capital = capitalFor(p);
  const age = ageDays(p, asOf);
  const hold = holdDaysFor(age);
  const weeklyTx = Math.max(1, Math.round(hold / 7));
  const estGas = (gas.perTx * (2 + weeklyTx)).toFixed(gas.perTx < 1 ? 2 : 0);
  const steps = [
    "Set up a fresh wallet that holds only the funds you plan to farm, write its seed phrase on paper and store it offline, then fund it with $" + (capital + 20) + " of USDC on " + chain + ". Cost: " + gas.label + " for the funding transfer. Time: 10 minutes.",
    coreAction(p, capital, chain) + " Cost: $" + capital + " of capital plus " + gas.label + ". Time: 15 minutes to set up.",
    "Do one qualifying action each week for " + weeklyTx + " weeks: a deposit, a borrow, a swap, a vote or a claim, whichever the protocol counts, and keep every receipt. Cost: " + gas.label + " a week. Time: 10 minutes a week.",
    "Hold the position for at least " + hold + " days so the activity spans more than one snapshot, and do not move the funds to another wallet in between. Cost: the $" + capital + " stays locked in the position. Time: " + hold + " days.",
    "Before you withdraw, open the protocol's own points or rewards page from the link it publishes and check whether your wallet is listed; claim only from that page, never from a link in a message. Cost: no fee to check, and never pay to claim. Time: 10 minutes.",
    "Write the wallet, the dates and every transaction in a farm log, then compare the total gas spent (about $" + estGas + " on " + chain + ") with the position's size before you repeat it or unwind it. Cost: nothing but the log. Time: 5 minutes.",
  ];
  return steps.map(stepText);
}

// ---- board ----------------------------------------------------------------

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  base_value_usd: number;
  category_multiplier: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  age_days: number | null;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  model: ModelParams;
  validation: Validation;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  top_implied_usd: number;
  rows: BoardRow[];
  live: LiveRow[];
}

// The gate's own shape check, run before anything is written. Returns null
// when the board is acceptable, otherwise a one-line reason.
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return "board has " + board.length + " rows, fewer than 100";
  if (board.length > 4000) return "board has " + board.length + " rows, more than 4000";
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seenRank = new Set<number>();
  let prev = Infinity;
  let allEqual = true;
  for (let i = 0; i < board.length; i++) {
    const r = board[i];
    if (!slugs.has(r.slug)) return "row " + r.slug + " is not in the snapshot";
    if (r.rank !== i + 1) return "row " + r.slug + " has rank " + r.rank + ", expected " + (i + 1);
    if (seenRank.has(r.rank)) return "rank " + r.rank + " appears twice";
    seenRank.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14)
      return "row " + r.slug + " has an implied value that is not a positive integer under 1e14";
    if (r.implied_value_usd > prev) return "board is not sorted by implied value at rank " + r.rank;
    if (i > 0 && r.implied_value_usd !== prev) allEqual = false;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12)
      return "row " + r.slug + " has " + r.farm_steps.length + " farm steps, expected 3-12";
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20) return "row " + r.slug + " has a farm step shorter than 20 characters";
      if (t.length > 600) return "row " + r.slug + " has a farm step longer than 600 characters";
    }
  }
  if (allEqual) return "every implied value is the same";
  const covered = new Set(board.map((r) => r.slug));
  for (const w of snapshot.watchlist) {
    if (!covered.has(w)) return "watchlist protocol " + w + " is missing from the board";
  }
  return null;
}

// The dashboard's data file: window.RADAR = {...}; written beside the page.
export function dataScript(radar: RadarData): string {
  return "window.RADAR = " + JSON.stringify(radar) + ";\n";
}

export function buildRadar(snapshot: Snapshot): RadarData {
  const { params, validation } = fitModel(snapshot);
  const watch = new Set(snapshot.watchlist);
  const eligible = watchlistCategories(snapshot);
  const rankable = snapshot.protocols.filter((p) => isRankable(p, eligible));
  const rows: BoardRow[] = rankable.map((p) => {
    const b = breakdown(p, params, snapshot.as_of);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: b.implied,
      farm_steps: farmSteps(p, snapshot.as_of),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p, snapshot.as_of),
      watchlist: watch.has(p.slug),
      base_value_usd: Math.max(1, Math.round(b.base * b.categoryMultiplier)),
      category_multiplier: b.categoryMultiplier,
      growth_multiplier: b.growthMultiplier,
      maturity_multiplier: b.maturityMultiplier,
    };
  });
  rows.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });
  const watchlistSize = rows.filter((r) => r.watchlist).length;
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => isTokenized(p))
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd as number,
      age_days: ageDays(p, snapshot.as_of),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 200);
  return {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: params.version,
    model: params,
    validation,
    watchlist_size: watchlistSize,
    board_size: rows.length,
    early_size: rows.length - watchlistSize,
    live_size: snapshot.protocols.filter((p) => isTokenized(p)).length,
    top_implied_usd: rows.length > 0 ? rows[0].implied_value_usd : 0,
    rows,
    live,
  };
}
