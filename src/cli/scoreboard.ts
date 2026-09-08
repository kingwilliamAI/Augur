import { openDb } from "../db.ts";
import { grade, HORIZON_SEC, MAX_AGE_SEC, pending, score, settled } from "../track.ts";

/**
 * What the tool actually got right, from claims written before the answer existed.
 *
 * augur scoreboard [--model ID | --all]
 *
 * By default this reports each model era separately. Pooling them would describe a model that never
 * ran: a nightly retrain changes the thing being measured, and a good week under one model can hide
 * a bad week under another.
 */
const argv = process.argv.slice(2);
const pick = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const db = openDb();
const justGraded = grade(db);

const rows = settled(db, pick("model"));
const outstanding = pending(db);

console.log("\naugur scoreboard: scores recorded before the outcome was known\n");

if (!rows.length) {
  console.log(`  nothing settled yet: ${outstanding} claims still inside the ${HORIZON_SEC / 3600}h horizon.`);
  console.log("  the watcher writes a row per launch it scores; run: npm run watch\n");
  db.close();
  process.exit(0);
}

if (justGraded) console.log(`  (settled ${justGraded} claims whose horizon just closed)\n`);

const eras = pick("model") || argv.includes("--all")
  ? [pick("model") ?? "all"]
  : [...new Set(rows.map((r) => r.model_id))];

const pad = (s: string | number, w: number): string => String(s).padStart(w);

for (const era of eras) {
  const mine = era === "all" ? rows : rows.filter((r) => r.model_id === era);
  const s = score(mine.map((r) => ({ probability: r.probability, label: r.label as 0 | 1 })));

  const from = new Date(mine[0].launch_ts * 1000).toISOString().slice(5, 16).replace("T", " ");
  const to = new Date(mine[mine.length - 1].launch_ts * 1000).toISOString().slice(5, 16).replace("T", " ");
  console.log(`model ${era}   ${from} .. ${to} UTC`);

  if (!s) {
    console.log(`  ${mine.length} settled claims, too few to score; needs 20\n`);
    continue;
  }

  const ages = mine.map((r) => r.age_at_score).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)];

  console.log(`  claims settled       ${pad(s.n, 7)}`);
  console.log(`  graduated            ${pad(s.positives, 7)}   base rate ${(100 * s.baseRate).toFixed(2)}%`);
  console.log(`  scored within        ${pad(median, 7)}s of launch (median, cut at ${MAX_AGE_SEC}s)`);
  console.log(`  ROC-AUC              ${pad(s.rocAuc.toFixed(3), 7)}`);
  console.log(
    `  top decile           ${pad(`${s.topDecileHits}/${s.topDecileN}`, 7)}   ` +
    `${(100 * s.topDecilePrecision).toFixed(2)}%  =  ${s.topDecileLift.toFixed(2)}x base`,
  );

  console.log("\n  predicted vs actual, by score quintile");
  for (const c of s.calibration) {
    console.log(
      `    ${c.bucket}  n=${pad(c.n, 5)}   said ${pad((100 * c.predicted).toFixed(2), 6)}%   was ${pad((100 * c.actual).toFixed(2), 6)}%`,
    );
  }
  console.log();
}

console.log(`${outstanding} claims still inside the ${HORIZON_SEC / 3600}h horizon.`);
console.log("export and recheck the arithmetic yourself: npm run verify\n");
db.close();
