import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The prediction log is the one part of this project whose value is entirely in what it refuses to
 * do: it must not record a claim about a launch whose fate is already half-decided, and it must not
 * let a claim be improved once made. Both are silent if broken — the log would still fill up, the
 * scoreboard would still print, and the numbers would simply be too good.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-track-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const { record, grade, settled, score, pending, HORIZON_SEC, MAX_AGE_SEC } = await import("./track.ts");

const db = openDb();

/**
 * Close the database before removing its directory. Windows refuses to unlink a file that is still
 * open, so leaving the handle to the process exit fails the whole file with EPERM after every
 * assertion in it has already passed — a green suite everywhere else and a red one on the platform
 * this tool is mainly run on.
 */
process.on("exit", () => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_800_000_000;
const scored = (token: string, probability: number) => ({
  token, ts: T0, probability, rawProbability: probability, rank: 1, of: 10, percentile: 100, reasons: [],
});

function addLaunch(token: string, ts: number): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    token, "0xc", "0xd", "0x0000000000000000000000000000000000000000", 1, "1", 0.001, 1, "0xtx" + token, 0, ts, ts);
}

function addGraduation(token: string, ts: number): void {
  db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
    VALUES (?,?,?,?,?,?,?,?)`).run(token, 1, "0xg" + token, ts, "1", "1", "1", 0.001);
}

test("records a claim about a fresh launch", () => {
  addLaunch("0xfresh", T0);
  assert.equal(record(db, scored("0xfresh", 0.08), T0, "m1", T0 + 30), true);
});

test("refuses a launch already too old to make an honest claim about", () => {
  addLaunch("0xstale", T0);
  assert.equal(
    record(db, scored("0xstale", 0.9), T0, "m1", T0 + MAX_AGE_SEC + 1),
    false,
    "a launch past the age cut must not enter the log at all",
  );
  assert.equal(settled(db).length + pending(db), 1, "the stale claim was written anyway");
});

test("the first claim stands and cannot be revised", () => {
  record(db, scored("0xfresh", 0.99), T0, "m1", T0 + 40);
  const row = db.prepare("SELECT probability, scored_at FROM predictions WHERE token = ?").get("0xfresh") as
    { probability: number; scored_at: number };
  assert.equal(row.probability, 0.08, "a later score overwrote the original claim");
  assert.equal(row.scored_at, T0 + 30);
});

test("nothing settles before the horizon closes", () => {
  assert.equal(grade(db, T0 + HORIZON_SEC - 1), 0);
  assert.equal(settled(db).length, 0);
  assert.equal(pending(db), 1);
});

test("settles as graduated only when the pool was reached inside the horizon", () => {
  addLaunch("0xlate", T0);
  record(db, scored("0xlate", 0.2), T0, "m1", T0 + 10);
  addGraduation("0xlate", T0 + HORIZON_SEC + 60); // graduated, but after the window closed

  addLaunch("0xhit", T0);
  record(db, scored("0xhit", 0.3), T0, "m1", T0 + 10);
  addGraduation("0xhit", T0 + 120);

  assert.equal(grade(db, T0 + HORIZON_SEC), 3);

  const byToken = new Map(settled(db).map((r) => [r.token, r.label]));
  assert.equal(byToken.get("0xhit"), 1, "graduated inside the horizon should settle positive");
  assert.equal(byToken.get("0xlate"), 0, "graduating after the horizon is not a hit");
  assert.equal(byToken.get("0xfresh"), 0, "never graduated should settle negative");
});

test("grading is idempotent", () => {
  assert.equal(grade(db, T0 + HORIZON_SEC + 999), 0, "already-settled claims must not be regraded");
});

test("a graduation that arrives after grading corrects its claim", () => {
  // The watcher can be behind, restart, or miss a window a later pass fills in. Grading reads a
  // missing row as "it did not happen", which is a different statement from the truth.
  addLaunch("0xlatelog", T0);
  assert.equal(record(db, scored("0xlatelog", 0.4), T0, "m1", T0 + 10), true);
  grade(db, T0 + HORIZON_SEC + 1);
  assert.equal(new Map(settled(db).map((r) => [r.token, r.label])).get("0xlatelog"), 0,
    "with no graduation on record it settles negative, which is all grading can say");

  // The evidence turns up: it reached the pool five minutes in, hours before it was graded.
  addGraduation("0xlatelog", T0 + 300);
  assert.equal(grade(db, T0 + HORIZON_SEC + 2), 1, "the late graduation must correct exactly one claim");
  assert.equal(new Map(settled(db).map((r) => [r.token, r.label])).get("0xlatelog"), 1);

  assert.equal(grade(db, T0 + HORIZON_SEC + 3), 0, "and correcting it once is enough");
});

test("a claim that really did fail is never talked into a hit", () => {
  addLaunch("0xstayszero", T0);
  assert.equal(record(db, scored("0xstayszero", 0.4), T0, "m1", T0 + 10), true);
  addGraduation("0xstayszero", T0 + HORIZON_SEC + 60);
  grade(db, T0 + HORIZON_SEC + 1);
  grade(db, T0 + HORIZON_SEC + 120);
  assert.equal(new Map(settled(db).map((r) => [r.token, r.label])).get("0xstayszero"), 0,
    "a graduation outside the horizon is not evidence for a claim measured inside it");
});

test("scoring the log matches hand arithmetic", () => {
  // 100 claims, 10 positives, and the model ranked 4 of them into its top decile.
  const rows: Array<{ probability: number; label: 0 | 1 }> = [];
  for (let i = 0; i < 100; i++) rows.push({ probability: (100 - i) / 100, label: 0 });
  for (const i of [0, 3, 7, 9, 20, 35, 44, 61, 78, 92]) rows[i].label = 1;

  const s = score(rows);
  assert.ok(s);
  assert.equal(s.n, 100);
  assert.equal(s.positives, 10);
  assert.equal(s.baseRate, 0.1);
  assert.equal(s.topDecileN, 10);
  assert.equal(s.topDecileHits, 4);
  assert.equal(s.topDecilePrecision, 0.4);
  assert.equal(s.topDecileLift, 4);
});

test("too small a log reports nothing rather than a flattering number", () => {
  assert.equal(score([{ probability: 0.9, label: 1 }, { probability: 0.1, label: 0 }]), null);
});

test("a fresh database gets the raw-probability column too", () => {
  // Migrations only touch tables that already exist, so a column added to an old database has to be
  // added to the schema as well or new installs quietly lack it. The failure is not subtle once it
  // happens, but it happens on somebody else's machine rather than this one.
  const cols = (db.prepare("PRAGMA table_info(predictions)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("raw_probability"), `predictions has: ${cols.join(", ")}`);
});

test("a claim records the model's own score as well as the one shown", () => {
  addLaunch("0xboth", T0);
  const s = { ...scored("0xboth", 0.02), rawProbability: 0.05 };
  assert.equal(record(db, s, T0, "m2", T0 + 5), true);
  const row = db.prepare("SELECT probability, raw_probability FROM predictions WHERE token = ?").get("0xboth") as
    { probability: number; raw_probability: number };
  assert.equal(row.probability, 0.02, "the claim is what was shown");
  assert.equal(row.raw_probability, 0.05, "and the model's own opinion is kept beside it");
});
