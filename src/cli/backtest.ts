import { amber, bold, dim, faint, lime, money, white } from "../ansi.ts";
import { openDb } from "../db.ts";
import { loadModel } from "../score.ts";
import {
  BLOCKS_PER_SECOND, cohort, coveredHours, measureCosts, measureImpact, MIN_ENTRY_BLOCKS,
  bootstrapMean, checkPoolJoin, cohort as pick, nets, prepare, simulate, summarise, withoutBest,
  type ExitRule, type Summary,
} from "../backtest.ts";

/**
 * What following the board would have returned.
 *
 * augur backtest [--entry-sec 3.5] [--size 0.05] [--tp 2] [--sl 0.5] [--hold-hours 4]
 *                 [--no-tp] [--no-sl] [--no-pool] [--coverage 0.98] [--sweep]
 *
 * The plain run prints one rule across four cohorts. `--sweep` searches exit rules, and does it the
 * only way a search over a few dozen rules can be reported honestly: each rule is scored on the
 * older half of the window, and the winner's number is then read off the newer half, which no rule
 * was chosen against. The gap between those two columns is the size of the lie a single-column
 * sweep would have told.
 */
const argv = process.argv.slice(2);
const has = (n: string): boolean => argv.includes(`--${n}`);
const arg = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};

const entrySec = arg("entry-sec", 3.5);
const sizeEth = arg("size", 0.05);
const holdHours = arg("hold-hours", 4);
const coverage = arg("coverage", 0.98);
const settleSec = arg("settle-hours", 4) * 3600;
const blocks = (hours: number): number => Math.round(hours * 3600 * BLOCKS_PER_SECOND);

const delayBlocks = Math.max(MIN_ENTRY_BLOCKS, Math.round(entrySec * BLOCKS_PER_SECOND));

const db = openDb();
const model = loadModel();
if (!model) {
  console.error("no model at data/model.json — run `npm run train` first");
  process.exit(1);
}

if (!coveredHours(db, coverage).length) {
  console.error(`\nNo hour has >=${(coverage * 100).toFixed(0)}% curve coverage, so there is nothing`);
  console.error("honest to test on: the launches that do have price paths were mostly read because");
  console.error("somebody opened their card, and cards get opened for launches that scored well.\n");
  console.error("Run `npm run curves` to read curves in bulk, then try again.");
  process.exit(1);
}

const costs = measureCosts(db);
const impact = measureImpact(db, sizeEth * 1e18);
const entry = { delayBlocks, impact };

const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;
const x = (v: number): string => `${v.toFixed(2)}x`;

const started = Date.now();
const ctx = prepare(db, model, { minCoverage: coverage, settleSec });

const label = (k: string): string => dim(k.padEnd(11));
console.log(`\n${bold(lime("augur backtest"))}  ${dim("what the ranking is worth in money")}\n`);
console.log(label("window") + white(`${ctx.hours.length} covered hours`) + dim(`, ${iso(ctx.hours[0] * 3600)} to ${iso((ctx.hours[ctx.hours.length - 1] + 1) * 3600)} UTC`));
console.log(label("coverage") + dim(`>=${pct(coverage)} of each hour's launches had their curve read`));
console.log(label("eligible") + white(`${ctx.rows.length.toLocaleString()} launches`) + dim(`, each settled at least ${settleSec / 3600}h`));
console.log(label("entry") + white(`+${delayBlocks} blocks (${(delayBlocks / BLOCKS_PER_SECOND).toFixed(1)} s)`) + dim(", just past the 3 s / 99% opening tax"));
console.log(label("costs") + white(`${pct(costs.buy)} a side`) + dim(", from the fee and tax charged on every CurveBuy"));
console.log(label("impact") + white(`${pct(impact)} at ${sizeEth}`) + dim(" of the quote asset, from how far real buys moved the curve"));

// The curve and the pool are the same price seen twice at the moment a token graduates, so their
// ratio is a unit check that runs on real data. Printed rather than asserted: a reader who does not
// trust the two legs are on the same scale can see whether they meet.
const join = checkPoolJoin(ctx.paths, ctx.pools);
if (join.n) {
  const sane = join.median > 0.8 && join.median < 1.25;
  console.log(label("handover") + dim(`curve's last price vs the pool's first, over ${join.n} graduated tokens: median `) +
    (sane ? lime(`${join.median.toFixed(2)}x`) : amber(`${join.median.toFixed(2)}x`)) + dim(`, ${pct(join.within2x)} inside 2x`));
}

const COHORTS = [
  { label: "everything", minPercentile: 0 },
  { label: "top half", minPercentile: 50 },
  { label: "shortlist (top 10%)", minPercentile: 90 },
  { label: "top 1%", minPercentile: 99 },
];

const exit: ExitRule = {
  takeProfit: has("no-tp") ? null : arg("tp", 2),
  stopLoss: has("no-sl") ? null : arg("sl", 0.5),
  holdBlocks: blocks(holdHours),
  followIntoPool: !has("no-pool"),
};

const rule = (e: ExitRule): string =>
  `tp ${e.takeProfit ? x(e.takeProfit) : "none"}, sl ${e.stopLoss ? x(e.stopLoss) : "none"}, ` +
  `hold ${(e.holdBlocks / BLOCKS_PER_SECOND / 3600).toFixed(2)}h${e.followIntoPool ? ", into pool" : ""}`;

const attempts = simulate(ctx, entry, exit, costs);
const summaries = COHORTS.map((c) => summarise(c.label, cohort(ctx, attempts, c.minPercentile)));

console.log(`\n${dim("rule:")} ${white(rule(exit))}\n`);
console.log(dim("cohort                 launches   filled    win%    median      mean    staked"));
console.log(faint("-".repeat(72)));
for (const s of summaries) {
  // The shortlist and the top percentile are the two rows anyone came here to read; the other two
  // are the baseline they only mean anything against.
  const headline = s.label.startsWith("shortlist") || s.label.startsWith("top 1");
  console.log(
    (headline ? bold(white(s.label.padEnd(21))) : dim(s.label.padEnd(21))) +
    white(String(s.launches).padStart(9)) +
    dim(pct(s.launches ? s.trades / s.launches : 0).padStart(9)) +
    white(pct(s.trades ? s.wins / s.trades : 0).padStart(8)) +
    money(s.medianNet, x(s.medianNet).padStart(10)) +
    money(s.meanNet, x(s.meanNet).padStart(10)) +
    money(s.totalReturn, x(s.totalReturn).padStart(10)),
  );
}
console.log(dim(
  "\n  median and mean are per position actually filled. `staked` is the whole cohort bought\n" +
  "  equally, with launches that could not be filled returning their stake untouched, which is\n" +
  "  what a reader who follows the whole list experiences.",
));

const shortNets = nets(pick(ctx, attempts, 90));
if (shortNets.length) {
  const ci = bootstrapMean(shortNets);
  const mean = shortNets.reduce((a, b) => a + b, 0) / shortNets.length;
  console.log(`
${dim("how sure is the shortlist's")} ${money(mean)}${dim("?")}`);
  console.log(dim(`  resampling those ${shortNets.length} positions: 90% of the time between `) + money(ci.lo) + dim(" and ") + money(ci.hi));
  for (const k of [1, 3, 10]) {
    const v = withoutBest(shortNets, k);
    console.log(dim(`  with the best ${String(k).padStart(2)} position${k > 1 ? "s" : " "} removed: `) + money(v));
  }
}

const short = summaries.find((s) => s.label.startsWith("shortlist")) as Summary;
if (short.trades) {
  console.log(`\nhow the shortlist's ${short.trades.toLocaleString()} positions ended:`);
  for (const [why, n] of Object.entries(short.exitReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${why.padEnd(18)} ${String(n).padStart(6)}   ${pct(n / short.trades)}`);
  }
  const drops = Object.entries(short.drops).filter(([, n]) => n > 0);
  if (drops.length) {
    console.log("  never filled:");
    for (const [why, n] of drops) console.log(`  ${why.padEnd(18)} ${String(n).padStart(6)}   ${pct(n / short.launches)}`);
  }
}

if (has("sweep")) {
  const ts = new Map(ctx.rows.map((r) => [r.token, r.ts]));
  const times = [...ts.values()].sort((a, b) => a - b);
  const cut = times[Math.floor(times.length / 2)];

  const grid: ExitRule[] = [];
  for (const tp of [1.25, 1.5, 2, 3, 5, 10, null]) {
    for (const sl of [0.4, 0.7, null]) {
      for (const h of [0.1, 0.5, 2, 8]) {
        grid.push({ takeProfit: tp, stopLoss: sl, holdBlocks: blocks(h), followIntoPool: true });
      }
    }
  }

  const half = (e: ExitRule, older: boolean): Summary => {
    const a = simulate(ctx, entry, e, costs);
    return summarise("shortlist", cohort(ctx, a, 90, (t) => {
      const at = ts.get(t);
      return at !== undefined && (older ? at < cut : at >= cut);
    }));
  };

  console.log(`\n\nexit-rule search over ${grid.length} rules`);
  console.log(`chosen on launches before ${iso(cut)} UTC, reported on the ones after\n`);

  const fitted = grid.map((e) => ({ e, s: half(e, true) }))
    .filter((r) => r.s.trades >= 30)
    .sort((a, b) => b.s.totalReturn - a.s.totalReturn);

  if (!fitted.length) {
    console.log("  every rule filled fewer than 30 positions on the older half — window too small.");
  } else {
    console.log("rule                                        chosen-on   reported-on");
    for (const { e, s } of fitted.slice(0, 6)) {
      console.log(rule(e).padEnd(42) + x(s.totalReturn).padStart(10) + x(half(e, false).totalReturn).padStart(14));
    }
    console.log(
      "\n  A rule that wins the left column and loses the right one was fitted to noise. Only the\n" +
      "  right column is a claim about money.",
    );
  }
}

console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
db.close();
