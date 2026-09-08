import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The alert reads the claim the watcher wrote rather than scoring afresh, which is what makes it
 * fast. The risk that buys is that the alert and the log could drift apart in shape: a row that
 * cannot be turned back into something renderable would not throw on a test machine with no
 * subscribers, it would throw in the one place nobody is watching, in the middle of the night, on
 * the launch somebody wanted to be told about.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-alerts-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const { claimsFor } = await import("./alerts.ts");

const db = openDb();
const T0 = 1_700_000_000;

function claim(token: string, p: number, rank: number, of: number, ts = T0, reasons = '[{"short":"first launch","direction":"down"}]'): void {
  db.prepare(`INSERT INTO predictions
    (token, launch_ts, scored_at, age_at_score, probability, raw_probability, rank, of, model_id, reasons_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(token, ts, ts + 4, 4, p, p, rank, of, "m1", reasons);
}

test("a claim comes back as something the alert can render", () => {
  claim("0xaaa", 0.31, 1, 500);
  const [s] = claimsFor(db, 0.08, T0 - 3600);
  assert.equal(s.token, "0xaaa");
  assert.equal(s.probability, 0.31);
  assert.equal(s.rank, 1);
  assert.equal(s.of, 500);
  assert.equal(s.ts, T0, "the launch time, not the time it was scored: the alert prints an age");
  assert.deepEqual(s.reasons, [{ short: "first launch", direction: "down" }]);
  assert.ok(s.percentile > 0.99, "rank 1 of 500 is the top of the list");
});

test("a threshold keeps out what it is meant to keep out", () => {
  claim("0xbbb", 0.02, 400, 500);
  const tokens = claimsFor(db, 0.08, T0 - 3600).map((s) => s.token);
  assert.ok(!tokens.includes("0xbbb"), "below the subscriber's floor");
  assert.ok(tokens.includes("0xaaa"));
});

test("the window keeps out launches older than it", () => {
  claim("0xold", 0.9, 1, 500, T0 - 7200);
  const tokens = claimsFor(db, 0.08, T0 - 3600).map((s) => s.token);
  assert.ok(!tokens.includes("0xold"), "outside the window however high it scored");
});

test("the highest claim is offered first", () => {
  claim("0xccc", 0.5, 1, 500);
  assert.equal(claimsFor(db, 0.08, T0 - 3600)[0].token, "0xccc",
    "a chat is rate limited to a message a second, so the order is what arrives soonest");
});

test("a single-launch window does not divide by zero", () => {
  claim("0xlone", 0.4, 1, 1, T0 + 10);
  const s = claimsFor(db, 0.08, T0 - 3600).find((r) => r.token === "0xlone");
  assert.ok(s);
  assert.equal(s.percentile, 1, "NaN here would reach a card");
});

test("teardown", () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
