import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "./db.ts";
import { advanceCursor, buildDataset, openCursor, FEATURES, type Row } from "./features.ts";

/**
 * The incremental build has one thing to prove: that it says exactly what the full build says.
 *
 * It exists because rebuilding is five seconds over two hundred thousand launches, and a wrong
 * answer here is the quietest failure in the project — a creator's record slightly off, a score
 * slightly wrong, ranked confidently, with nothing to notice.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-features-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const T0 = 1_800_000_000;
let seq = 0;

function addLaunch(db: DB, o: {
  token: string; deployer: string; ts: number; enriched?: boolean;
  selfBuy?: string; exempts?: string[]; taxBps?: number;
}): void {
  const block = ++seq * 10;
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at,
    enriched_at, launch_sender, creator_tax_bps, buyback_enabled, initial_buy_wei, initial_buy_eth,
    exempt_count, name, symbol, description, socials_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.token, "0xc", o.deployer, "0x0000000000000000000000000000000000000000", 1,
    "1000000000000000000", 1, block, "0xtx" + o.token, 0, o.ts, o.ts,
    o.enriched === false ? null : o.ts, o.deployer, o.taxBps ?? 100, 0,
    o.selfBuy ?? "10000000000000000", 0.01,
    (o.exempts ?? []).length, "N" + o.token, "S" + o.token, "d", "{}",
  );
  for (const a of o.exempts ?? []) {
    db.prepare("INSERT INTO exemptions(token,address) VALUES(?,?) ON CONFLICT DO NOTHING").run(o.token, a);
  }
}

function enrich(db: DB, token: string, ts: number): void {
  db.prepare("UPDATE launches SET enriched_at = ? WHERE token = ?").run(ts, token);
}

function graduate(db: DB, token: string, ts: number): void {
  db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
    VALUES (?,?,?,?,?,?,?,?)`).run(token, 1, "0xg" + token, ts, "1", "1", "1", 0.001);
}

/** Compared by token, not by position: the claim is that the rows agree, not that they were sorted. */
function assertSame(a: Row[], b: Row[], what: string): void {
  assert.equal(a.length, b.length, `${what}: ${a.length} rows against ${b.length}`);
  const byToken = new Map(b.map((r) => [r.token, r]));
  for (const row of a) {
    const other = byToken.get(row.token);
    assert.ok(other, `${what}: ${row.token} is missing from the other build`);
    assert.equal(other.label, row.label, `${what}: ${row.token} label`);
    assert.equal(other.ts, row.ts, `${what}: ${row.token} ts`);
    for (let i = 0; i < row.x.length; i++) {
      assert.equal(other.x[i], row.x[i], `${what}: ${row.token} feature ${FEATURES[i]}`);
    }
  }
}

test("an advanced cursor matches a build from scratch", () => {
  const db = openDb(join(dir, "a.db"));
  const since = T0 - 6 * 3600;

  for (let i = 0; i < 40; i++) {
    addLaunch(db, { token: `0xold${i}`, deployer: `0xdev${i % 7}`, ts: T0 - 9 * 3600 + i * 60, exempts: [`0xw${i % 5}`] });
  }
  for (let i = 0; i < 30; i++) {
    addLaunch(db, { token: `0xin${i}`, deployer: `0xdev${i % 7}`, ts: since + 60 + i * 60, exempts: [`0xw${i % 5}`] });
  }
  graduate(db, "0xold3", T0 - 8 * 3600);
  graduate(db, "0xin4", since + 400);

  const cur = openCursor(db, since);
  assertSame(cur.rows, buildDataset(db, { since }), "opening");

  // Three rounds of arrivals, advanced one at a time, exactly as the board does it.
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 6; i++) {
      addLaunch(db, { token: `0xnew${round}_${i}`, deployer: `0xdev${(round + i) % 7}`, ts: T0 + round * 300 + i * 20, exempts: [`0xw${i % 5}`] });
    }
    graduate(db, `0xin${round}`, T0 + round * 300 + 10);
    assert.equal(advanceCursor(db, cur, since), true);
    assertSame(cur.rows, buildDataset(db, { since }), `round ${round}`);
  }
  db.close();
});

test("a launch met before it was enriched still arrives, with the history of its own place", () => {
  // The failure this guards: the watcher writes a launch when it reads the log and enriches it a
  // second later, so an incremental pass meets most launches in that gap. Walking past one and
  // forgetting it drops it from the board for good, and nothing reports a fault.
  const db = openDb(join(dir, "b.db"));
  const since = T0 - 6 * 3600;

  addLaunch(db, { token: "0xa", deployer: "0xdev", ts: since + 100 });
  const cur = openCursor(db, since);
  assert.equal(cur.rows.length, 1);

  addLaunch(db, { token: "0xb", deployer: "0xdev", ts: since + 200, enriched: false });
  assert.equal(advanceCursor(db, cur, since), true);
  assert.equal(cur.rows.length, 1, "an unenriched launch has no row yet");
  assert.equal(cur.pending.size, 1, "and is not forgotten");

  // Two more land while it is still unreadable, so its place in the order is genuinely behind them.
  addLaunch(db, { token: "0xc", deployer: "0xdev", ts: since + 300 });
  assert.equal(advanceCursor(db, cur, since), true);

  enrich(db, "0xb", since + 200);
  assert.equal(advanceCursor(db, cur, since), true);
  assert.equal(cur.pending.size, 0);
  assertSame(cur.rows, buildDataset(db, { since }), "after late enrichment");

  const b = cur.rows.find((r) => r.token === "0xb");
  assert.ok(b);
  assert.equal(b.x[FEATURES.indexOf("dev_prior_launches")], 1, "0xb must see only the launch that truly preceded it");
  db.close();
});

test("a graduation arriving for an old launch counts from when it happened", () => {
  const db = openDb(join(dir, "c.db"));
  const since = T0 - 6 * 3600;
  addLaunch(db, { token: "0xp", deployer: "0xdev", ts: since + 100 });
  const cur = openCursor(db, since);

  graduate(db, "0xp", T0);                                    // the old launch graduates now
  addLaunch(db, { token: "0xq", deployer: "0xdev", ts: T0 + 60 });  // a later launch by the same creator
  assert.equal(advanceCursor(db, cur, since), true);
  assertSame(cur.rows, buildDataset(db, { since }), "late graduation");

  const q = cur.rows.find((r) => r.token === "0xq");
  assert.ok(q);
  assert.equal(q.x[FEATURES.indexOf("dev_prior_graduations")], 1, "the graduation should count for a launch that came after it");
  db.close();
});

test("refuses a window wider than it was opened on", () => {
  const db = openDb(join(dir, "d.db"));
  addLaunch(db, { token: "0xz", deployer: "0xdev", ts: T0 });
  const cur = openCursor(db, T0 - 3600);
  assert.equal(advanceCursor(db, cur, T0 - 7200), false, "it cannot invent history it discarded");
  assert.equal(advanceCursor(db, cur, T0 - 1800), true, "a narrower window is fine");
  db.close();
});

test("rows leave the window as it moves forward", () => {
  const db = openDb(join(dir, "e.db"));
  addLaunch(db, { token: "0xearly", deployer: "0xdev", ts: T0 });
  addLaunch(db, { token: "0xlate", deployer: "0xdev", ts: T0 + 7200 });
  const cur = openCursor(db, T0 - 60);
  assert.equal(cur.rows.length, 2);
  assert.equal(advanceCursor(db, cur, T0 + 3600), true);
  assert.deepEqual(cur.rows.map((r) => r.token), ["0xlate"]);
  db.close();
});
