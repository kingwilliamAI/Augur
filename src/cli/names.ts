import { openDb } from "../db.ts";
import { readTokenIdentity } from "../enrich.ts";
import { normaliseName } from "../features.ts";

/**
 * Fills in names for launches that never declared one.
 *
 * About half of launches are not sent through the pons router, so the creator's parameters cannot be
 * decoded from the calldata and the board shows "?" where a ticker belongs. The token contract knows
 * its own name regardless, so this asks it.
 *
 * Newest first, deliberately: a "?" on a launch from four days ago is a cosmetic gap in history, and
 * a "?" at the top of the live feed is the tool failing to say what a trader is looking at.
 *
 * augur names [--limit N] [--workers N]
 */
const argv = process.argv.slice(2);
const arg = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};

const limit = arg("limit", 100_000);
const workers = arg("workers", 8);

const db = openDb();

const pending = db.prepare(`
  SELECT token FROM launches
  WHERE enriched_at IS NOT NULL AND symbol IS NULL
  ORDER BY ts DESC LIMIT ?`).all(limit) as Array<{ token: string }>;

const total = (db.prepare(
  "SELECT count(*) c FROM launches WHERE enriched_at IS NOT NULL AND symbol IS NULL",
).get() as { c: number }).c;

console.log(`${total} launches have no name; resolving ${pending.length} of them, newest first, ${workers} workers\n`);

const save = db.prepare(
  "UPDATE launches SET name = ?, symbol = ?, symbol_key = ? WHERE token = ?",
);

const queue = [...pending];
let done = 0;
let named = 0;
let last = 0;
const started = Date.now();

await Promise.all(Array.from({ length: workers }, async () => {
  for (;;) {
    const row = queue.shift();
    if (!row) return;
    try {
      const id = await readTokenIdentity(row.token);
      if (id.name !== undefined || id.symbol !== undefined) {
        save.run(id.name ?? null, id.symbol ?? null, id.symbol ? normaliseName(id.symbol) || null : null, row.token);
        named++;
      }
    } catch { /* a token that will not answer keeps its unknown name; a later pass retries it */ }
    done++;
    if (Date.now() - last > 3000) {
      last = Date.now();
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${done}/${pending.length}  ${rate.toFixed(1)}/s  named ${named}  eta ${((pending.length - done) / Math.max(rate, 0.1) / 60).toFixed(1)}min   `,
      );
    }
  }
}));

console.log(`\n\nresolved ${named} of ${done} in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
db.close();
