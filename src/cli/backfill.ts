import { logsClient } from "../chain.ts";
import { BLOCKS_PER_DAY } from "../config.ts";
import { openDb, setMeta } from "../db.ts";
import { backfillRange } from "../ingest.ts";

/** augur backfill [--hours N | --blocks N | --from BLOCK] */
const argv = process.argv.slice(2);
const arg = (name: string): number | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};

const latest = Number(await logsClient.getBlockNumber());
const hours = arg("hours");
const blocks = arg("blocks");
const from = arg("from") ?? latest - (blocks ?? Math.round((hours ?? 24) * (BLOCKS_PER_DAY / 24)));
const to = arg("to") ?? latest;

console.log(`backfilling blocks ${from}..${to}  (${(to - from).toLocaleString()} blocks, ~${((to - from) / BLOCKS_PER_DAY * 24).toFixed(1)}h)`);

const db = openDb();
const started = Date.now();
let lastLog = 0;

const totals = await backfillRange(db, from, to, (done, total, c) => {
  const now = Date.now();
  if (now - lastLog < 2000) return;
  lastLog = now;
  const pct = ((done / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${pct.padStart(5)}%  launched=${c.launched} graduated=${c.graduated} swept=${c.swept}   `);
});

setMeta(db, "backfill_to_block", String(to));
if (!Number.isFinite(Number(arg("from")))) setMeta(db, "backfill_from_block", String(from));

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n\ndone in ${secs}s`);
console.log(`  launched   ${totals.launched}`);
console.log(`  swept      ${totals.swept}`);
console.log(`  graduated  ${totals.graduated}`);
console.log(`  fee redirects ${totals.feeChanged}`);
if (totals.launched > 0) {
  console.log(`  graduation rate in window: ${((100 * totals.graduated) / totals.launched).toFixed(2)}%`);
}
db.close();
