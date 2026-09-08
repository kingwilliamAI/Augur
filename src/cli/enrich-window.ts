import { openDb } from "../db.ts";
import { fetchLaunchDetail, saveLaunchDetail } from "../enrich.ts";
import { backfillQuoteAssets } from "../quote.ts";

/**
 * Enriches every launch inside a contiguous time window.
 *
 * Training needs an unbiased sample. A "graduated launches plus every Nth other" sample is fine for
 * asking whether a feature separates the classes, but a model fitted on it is calibrated to a
 * positive rate that does not exist, so the score would read far too high.
 *
 * augur enrich-window --hours N [--end-offset-hours N] [--workers N]
 */
const argv = process.argv.slice(2);
const arg = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};

const hours = arg("hours", 10);
const endOffset = arg("end-offset-hours", 4); // stay behind the label horizon
const workers = arg("workers", 6);

const db = openDb();
const maxTs = (db.prepare("SELECT max(ts) t FROM launches").get() as { t: number }).t;
const end = maxTs - endOffset * 3600;
const start = end - hours * 3600;

const rows = db.prepare(
  "SELECT token, tx FROM launches WHERE ts >= ? AND ts < ? AND enriched_at IS NULL ORDER BY block",
).all(start, end) as Array<{ token: string; tx: string }>;

const total = (db.prepare("SELECT count(*) c FROM launches WHERE ts >= ? AND ts < ?").get(start, end) as { c: number }).c;
console.log(`window ${new Date(start * 1000).toISOString()} .. ${new Date(end * 1000).toISOString()}`);
console.log(`${total} launches in window, ${rows.length} still to enrich, ${workers} workers`);

const queue = [...rows];
let done = 0;
let failed = 0;
let last = 0;
const started = Date.now();

await Promise.all(Array.from({ length: workers }, async () => {
  for (;;) {
    const r = queue.shift();
    if (!r) return;
    try { saveLaunchDetail(db, await fetchLaunchDetail(r.token, r.tx, false)); }
    catch { failed++; }
    done++;
    if (Date.now() - last > 4000) {
      last = Date.now();
      const rate = done / ((Date.now() - started) / 1000);
      const eta = (rows.length - done) / Math.max(rate, 0.1);
      process.stdout.write(`\r  ${done}/${rows.length}  ${rate.toFixed(1)}/s  eta ${(eta / 60).toFixed(1)}min  (${failed} failed)   `);
    }
  }
}));

console.log(`\ndone: ${done} enriched, ${failed} failed, ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
db.close();
