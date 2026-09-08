import { openDb } from "../db.ts";
import { enrichPending } from "../enrich.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--limit");
const limit = i >= 0 ? Number(argv[i + 1]) : 500;
const shallow = argv.includes("--shallow");

const db = openDb();
const pending = (db.prepare("SELECT count(*) c FROM launches WHERE enriched_at IS NULL").get() as { c: number }).c;
console.log(`enriching ${Math.min(limit, pending)} of ${pending} pending launches${shallow ? " (shallow)" : ""}`);

const started = Date.now();
let last = 0;
const n = await enrichPending(db, limit, !shallow, (done, total) => {
  const now = Date.now();
  if (now - last < 1500) return;
  last = now;
  process.stdout.write(`\r  ${done}/${total}  `);
});
console.log(`\ndone: ${n} launches in ${((Date.now() - started) / 1000).toFixed(1)}s`);
db.close();
