import { spawnSync } from "node:child_process";

/**
 * The scheduled job: catch up on history, fill in the launch transactions, refit.
 *
 * Order matters. Enriching before backfilling would skip launches that are not in the database yet,
 * and training before enriching would fit on a window that is only partly covered. Curves come
 * last before training because the peak model is fitted on them: it needs launches that have both
 * settled and been read, and reading is the step that lags. Its limit is deliberate rather than
 * unbounded, since the read is rate-limited at roughly 1.7 curves a second, which puts four
 * thousand of them at about forty minutes.
 *
 * `pools` follows the graduated ones past the curve. It is cheap next to the rest: the swap read is
 * chain-wide against Uniswap v4's singleton, so one pass covers every graduated token at once at
 * roughly 430 reads a day, against the curve indexer's 1.7 a second.
 */
/**
 * `recalibrate` is deliberately not here.
 *
 * It was, running just before the retrain on the reasoning that the model trained a minute later
 * would inherit the fit. It does not: a correction is stamped with the model that produced the
 * claims and refused for any other, and training reads no correction at all. So the step fitted a
 * correction for a model that was replaced sixty seconds later, and nothing ever applied it — on the
 * live server the file had never once been written.
 *
 * Nor should it inherit. The correction exists because the market moved away from what the model was
 * fitted on; a model retrained overnight has just been fitted on that same moved market, so it
 * starts closer to right, and carrying yesterday's correction onto it would push it past. The honest
 * sequence is to let the new model serve uncorrected until its own claims settle, then fit from
 * those — which is a job for a timer through the day, not for a step that runs once at half past
 * four. See DEPLOY.md.
 */
const steps: Array<[string, string[]]> = [
  ["backfill", ["--hours", "26"]],
  ["enrich-window", ["--hours", "20", "--workers", "6"]],
  ["curves", ["--limit", "4000", "--min-age-hours", "4", "--max-age-hours", "168"]],
  ["pools", ["--max-blocks", "900000"]],
  // The chain-wide swap pass folds every pool to a high, low and last, which is all four thousand of
  // them can afford. The coin page draws a line, and a line needs the series: this reads that one
  // pool on its own, where a chunk covers a hundred and fifty thousand blocks instead of a thousand.
  // Without it the chart is empty and looks broken, which is how it was found.
  ["coin", []],
  ["train", []],
  // Housekeeping last, once the night's reading is in. Folding a curve costs its per-transaction
  // detail and nothing else: checked across every curve in the database, the summary reports the
  // same target its trades did and rebuilds the same cards.
  ["compact", ["--older-than-days", "2", "--vacuum"]],
];

for (const [script, args] of steps) {
  console.log(`\n=== ${script} ${args.join(" ")} ===`);
  const r = spawnSync("npm", ["run", "--silent", script, "--", ...args], { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`${script} failed with code ${r.status}; stopping so a bad step does not feed the next one`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nnightly complete");
