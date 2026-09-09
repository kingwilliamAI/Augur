import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

/**
 * The deployer tools, against the real board.
 *
 * The preview is free on purpose, and the test says so: a tool for somebody deciding whether to
 * spend money on a deploy is worth nothing if it is behind the thing they have not bought yet.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-preview-api-"));
const DB = join(dir, "test.db");
const PORT = 4773;
const BASE = `http://127.0.0.1:${PORT}`;
const T0 = Math.floor(Date.now() / 1000);
const ETH = "0x0000000000000000000000000000000000000000";
const CREATOR = "0x" + "5".repeat(40);

let board: ChildProcess;

function seed(): void {
  const db = openDb(DB);
  const add = db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, symbol, launch_sender)
    VALUES (?,?,?,?,1,'1000000000000000000',1,?,?,0,?,?,'SEED',?)`);
  for (let i = 0; i < 6; i++) add.run("0xs" + i, "0xc", CREATOR, ETH, i, "0xt" + i, T0 - 600 - i, T0 - 600 - i, CREATOR);
  db.prepare(`INSERT INTO predictions (token, launch_ts, scored_at, age_at_score, probability,
    raw_probability, rank, of, model_id, reasons_json) VALUES ('0xs0',?,?,4,0.4,0.4,2,50,'m1','[]')`)
    .run(T0 - 600, T0 - 596);
  db.close();
}

before(async () => {
  seed();
  board = spawn(process.execPath, ["--no-warnings", "src/board.ts"], {
    env: { ...process.env, BOARD_PORT: String(PORT), BOARD_HOST: "127.0.0.1", DB_PATH: DB, TRUST_PROXY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  board.stderr?.on("data", (b: Buffer) => { stderr += String(b); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (board.exitCode !== null) throw new Error(`board exited with ${board.exitCode}:\n${stderr}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`board never answered:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (board && board.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      board?.once("exit", done); board?.kill(); setTimeout(done, 5_000).unref();
    });
  }
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

const post = (body: unknown): Promise<Response> =>
  fetch(`${BASE}/api/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

test("the preview is free: no key, no wallet, no tier", async () => {
  const r = await post({ creator: CREATOR, symbol: "AUGUR", creatorTaxBps: 150 });
  assert.equal(r.status, 200, "a tool for deciding whether to deploy cannot be behind the paid half");
  const b = await r.json() as { probability: number; reasons: unknown[]; history: { priorL: number } };
  assert.ok(b.probability > 0 && b.probability < 1);
  assert.equal(b.reasons.length, 3);
  assert.equal(b.history.priorL, 6, "the creator's own record is read from the database, not sent by the caller");
});

test("it refuses what it cannot score, and says which field", async () => {
  assert.equal((await post({ creator: "0xnope", symbol: "X" })).status, 400);
  assert.equal((await post({ creator: CREATOR, symbol: "" })).status, 400);
  assert.equal((await fetch(`${BASE}/api/preview`)).status, 405, "GET must not score anything");
});

test("what it assumed comes back with the answer", async () => {
  const b = await (await post({ creator: CREATOR, symbol: "Q" })).json() as { assumed: string[] };
  assert.ok(b.assumed.some((a) => /self-buy undeclared/.test(a)));
});

test("where a launch ranked is served from the claim", async () => {
  const r = await fetch(`${BASE}/api/ranked/0xs0`);
  assert.equal(r.status, 404, "a token id is an address; a seed row is not one");

  const missing = await fetch(`${BASE}/api/ranked/0x${"9".repeat(40)}`);
  assert.equal(missing.status, 404, "no claim, no answer, rather than a made-up one");
});
