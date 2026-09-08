import { openDb } from "../db.ts";
import { grade, modelId, settled } from "../track.ts";
import { fitLive, applyLive, liveFor, saveLive, MIN_CLAIMS } from "../calibration.ts";

/**
 * Refits the printed probability against what the log says actually happened.
 *
 * augur recalibrate [--write]
 *
 * Reports by default. Nothing about the ranking changes either way — the correction is monotone in
 * log-odds — so this only ever moves the number a card prints, never its place in the list.
 */
const WRITE = process.argv.includes("--write");

const db = openDb();
grade(db);

const id = modelId();

// Fitted against the model's own opinion, never against a number a previous correction already
// moved. Older rows predate the column and were never corrected, so their shown value is the raw one.
const claims = settled(db, id);
const rows = claims.map((r) => ({ probability: r.raw_probability ?? r.probability, label: r.label as 0 | 1 }));
const shownRows = claims.map((r) => ({ probability: r.probability, label: r.label as 0 | 1 }));

console.log(`\nmodel ${id}: ${rows.length} settled claims scored by it\n`);

if (rows.length < MIN_CLAIMS) {
  console.log(`  too few to fit against, needs ${MIN_CLAIMS}. Nothing written.`);
  console.log(`  a model gathers about a thousand claims an hour and they settle after four,`);
  console.log(`  so a model this fresh is simply not old enough yet. Nothing is wrong.\n`);
  db.close();
  process.exit(0);
}

const raw = rows.reduce((s, r) => s + r.probability, 0) / rows.length;
const said = shownRows.reduce((s, r) => s + r.probability, 0) / shownRows.length;
const was = rows.reduce((s, r) => s + r.label, 0) / rows.length;
const fit = fitLive(rows);

console.log(`  the model thought  ${(100 * raw).toFixed(2)}%`);
if (Math.abs(said - raw) > 1e-9) console.log(`  the board showed   ${(100 * said).toFixed(2)}%   (a correction was already in force)`);
console.log(`  it was             ${(100 * was).toFixed(2)}%`);

if (!fit) {
  console.log("\n  the correction came out beyond what a two-parameter nudge should carry.");
  console.log("  that is a signal to look at the model, not to rescale it. Nothing written.\n");
  db.close();
  process.exit(0);
}

const after = rows.reduce((s, r) => s + applyLive(fit, r.probability), 0) / rows.length;
console.log(`  would show         ${(100 * after).toFixed(2)}%   (slope ${fit.a.toFixed(3)}, shift ${fit.b.toFixed(3)})`);

const existing = liveFor(id);
if (existing) console.log(`\n  replacing a correction fitted ${Math.round((Date.now() / 1000 - existing.fittedAt) / 60)} min ago on ${existing.n} claims`);

if (!WRITE) {
  console.log("\n  pass --write to apply it.\n");
  db.close();
  process.exit(0);
}

saveLive({ modelId: id, a: fit.a, b: fit.b, n: rows.length, fittedAt: Math.floor(Date.now() / 1000), saidBefore: raw, wasBefore: was });
console.log("\n  written to data/calibration.json; the board picks it up on its next request.\n");
db.close();
