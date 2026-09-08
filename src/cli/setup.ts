import { spawnSync } from "node:child_process";

/**
 * Everything a fresh clone needs before the board is useful, and nothing it does not.
 *
 * The two collection steps differ in cost by two orders of magnitude, and knowing why is the whole
 * point of this script:
 *
 *   backfill  reads factory events. Who launched, when, and what graduated — one request per 60,000
 *             blocks. A week costs about five minutes, and it is what makes creator history correct:
 *             a creator with a thousand launches behind them has to read as one.
 *   enrich    reads each launch transaction to recover the creator's declared terms. One request per
 *             launch. A week would be forty minutes; the last six hours is two.
 *
 * So: a week of history, but only the visible window decoded. That is the shortest path to a board
 * that scores live launches correctly, and the rest can fill in later with `npm run enrich-window`.
 */
const HOURS_OF_HISTORY = 168;
const HOURS_TO_DECODE = 8;

const steps: Array<[string, string[], string]> = [
  ["doctor", [], "checking the chain is reachable and pons has not moved its contracts"],
  ["backfill", ["--hours", String(HOURS_OF_HISTORY)], `pulling ${HOURS_OF_HISTORY / 24} days of launches and graduations`],
  ["enrich-window", ["--hours", String(HOURS_TO_DECODE), "--end-offset-hours", "0"], `decoding the last ${HOURS_TO_DECODE} hours of launch transactions`],
];

for (const [script, args, why] of steps) {
  console.log(`\n=== ${script}: ${why} ===`);
  const r = spawnSync("npm", ["run", "--silent", script, "--", ...args], { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n${script} failed. Fix that before continuing; the next step would build on it.`);
    process.exit(r.status ?? 1);
  }
}

console.log(`
Ready. The model shipped with this repository scores what you just collected:

  npm run board     the list, at http://localhost:4663
  npm run watch     the same thing live in a terminal

Two things worth doing once it is running:

  npm run enrich-window -- --hours 168    fill in the rest of the week (about forty minutes)
  npm run train                           refit on your own data rather than the shipped model
`);
