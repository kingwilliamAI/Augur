import { openDb } from "../db.ts";
import { fullyEnrichedWindow } from "../model/train.ts";

const db = openDb();
const one = <T>(sql: string, ...a: unknown[]): T => db.prepare(sql).get(...a) as T;

const c = one<{ launches: number; grads: number; enriched: number; exempt: number; feechg: number }>(`
  SELECT (SELECT count(*) FROM launches) launches,
         (SELECT count(*) FROM graduations) grads,
         (SELECT count(*) FROM launches WHERE enriched_at IS NOT NULL) enriched,
         (SELECT count(*) FROM exemptions) exempt,
         (SELECT count(*) FROM fee_recipient_changes) feechg`);
const span = one<{ a: number; b: number }>("SELECT min(ts) a, max(ts) b FROM launches");

console.log("indexed");
console.log(`  launches            ${c.launches.toLocaleString()}`);
console.log(`  graduations         ${c.grads.toLocaleString()}  (${((100 * c.grads) / Math.max(1, c.launches)).toFixed(2)}%)`);
console.log(`  enriched            ${c.enriched.toLocaleString()}`);
console.log(`  tax exemptions      ${c.exempt.toLocaleString()}`);
console.log(`  fee redirects       ${c.feechg.toLocaleString()}`);
console.log(`  span                ${new Date(span.a * 1000).toISOString()} .. ${new Date(span.b * 1000).toISOString()}`);

const w = fullyEnrichedWindow(db);
console.log(`\ntrainable window     ${w ? `${new Date(w.from * 1000).toISOString()} .. ${new Date(w.to * 1000).toISOString()}` : "none. Run enrich-window"}`);

console.log("\ntime from launch to graduation");
const d = (db.prepare("SELECT g.ts - l.ts s FROM graduations g JOIN launches l USING(token) WHERE g.ts >= l.ts ORDER BY s").all() as Array<{ s: number }>).map((r) => r.s);
if (d.length) {
  const p = (q: number): number => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  for (const q of [0.5, 0.9, 0.99]) console.log(`  p${(q * 100).toFixed(0).padStart(2)}   ${(p(q) / 60).toFixed(1)} min`);
}

console.log("\nquote assets");
console.table(db.prepare(`
  SELECT q.symbol, q.decimals, count(*) launches,
         sum(CASE WHEN l.token IN (SELECT token FROM graduations) THEN 1 ELSE 0 END) graduated
  FROM quote_assets q JOIN launches l ON l.pair_token = q.address
  GROUP BY q.address ORDER BY launches DESC LIMIT 8`).all());
db.close();
