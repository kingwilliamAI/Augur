import { writeFileSync, readFileSync } from "node:fs";
import { openDb } from "../db.ts";
import { grade, score, settled } from "../track.ts";
import { EXPLORER } from "../config.ts";

/**
 * Exports the prediction log and recomputes the headline numbers from the exported file alone.
 *
 * The point is not the export. The point is that the numbers this project publishes can be checked
 * by someone who does not trust the code that produced them: every row carries a token address, the
 * time the claim was made, the claim, and the outcome, and every one of those is verifiable against
 * the chain. Recomputing from the file and printing both figures side by side shows the export is
 * complete enough to stand on its own — if the two ever disagree, the export is the honest one.
 *
 * augur verify [--out data/predictions.jsonl]
 */
const argv = process.argv.slice(2);
const i = argv.indexOf("--out");
const out = i >= 0 ? argv[i + 1] : "data/predictions.jsonl";

const db = openDb();
grade(db);
const rows = settled(db);

if (!rows.length) {
  console.log("nothing settled yet. Run the watcher for a few hours first: npm run watch");
  db.close();
  process.exit(0);
}

const lines = rows.map((r) => JSON.stringify({
  token: r.token,
  launched_at: new Date(r.launch_ts * 1000).toISOString(),
  scored_at: new Date(r.scored_at * 1000).toISOString(),
  age_at_score_sec: r.age_at_score,
  probability: r.probability,
  rank: r.rank,
  of: r.of,
  model_id: r.model_id,
  graduated_within_horizon: r.label === 1,
  explorer: EXPLORER.token(r.token),
}));
writeFileSync(out, lines.join("\n") + "\n");

const fromDb = score(rows.map((r) => ({ probability: r.probability, label: r.label as 0 | 1 })));

// Deliberately re-read from disk rather than reusing the array above: this is the file a reader
// would be handed, so it is the file the numbers must be reproducible from.
const reread = readFileSync(out, "utf8").trim().split("\n").map((l) => {
  const o = JSON.parse(l) as { probability: number; graduated_within_horizon: boolean };
  return { probability: o.probability, label: (o.graduated_within_horizon ? 1 : 0) as 0 | 1 };
});
const fromFile = score(reread);

console.log(`\nwrote ${rows.length} settled claims to ${out}\n`);

if (!fromDb || !fromFile) {
  console.log("too few settled claims to score yet (needs 20)\n");
  db.close();
  process.exit(0);
}

const line = (label: string, a: string, b: string): void =>
  console.log(`  ${label.padEnd(20)} ${a.padStart(10)}   ${b.padStart(10)}   ${a === b ? "" : "MISMATCH"}`);

console.log(`  ${"".padEnd(20)} ${"database".padStart(10)}   ${"export".padStart(10)}`);
line("settled claims", String(fromDb.n), String(fromFile.n));
line("graduated", String(fromDb.positives), String(fromFile.positives));
line("base rate", `${(100 * fromDb.baseRate).toFixed(2)}%`, `${(100 * fromFile.baseRate).toFixed(2)}%`);
line("ROC-AUC", fromDb.rocAuc.toFixed(4), fromFile.rocAuc.toFixed(4));
line("top decile", `${(100 * fromDb.topDecilePrecision).toFixed(2)}%`, `${(100 * fromFile.topDecilePrecision).toFixed(2)}%`);
line("top decile lift", `${fromDb.topDecileLift.toFixed(2)}x`, `${fromFile.topDecileLift.toFixed(2)}x`);

console.log(`
Every row names a token, the moment the score was written, and whether it reached the pool inside
the horizon. All three are checkable against the chain without this tool: open any explorer link in
the file and read the launch and graduation events for yourself.
`);
db.close();
