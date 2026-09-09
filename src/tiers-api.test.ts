import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { openDb } from "./db.ts";

/**
 * The paid half of the API, against the real board rather than against its functions.
 *
 * The rules live in tiers.ts and are tested there without a network. What this file covers is the
 * wiring, which is where a tier gate is actually lost: an endpoint that forgets to ask, a key read
 * from the wrong place, a limit counted against the wrong bucket. None of that shows up in a unit
 * test of the rules, and all of it shows up as a paid feature quietly being free.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-tiers-api-"));
const DB = join(dir, "test.db");
const PORT = 4772;
const BASE = `http://127.0.0.1:${PORT}`;
const T0 = Math.floor(Date.now() / 1000);

const KEY_FREE = "augur_" + "a".repeat(32);
const KEY_HOLDER = "augur_" + "b".repeat(32);
const KEY_TWO = "augur_" + "c".repeat(32);
const KEY_ORPHAN = "augur_" + "d".repeat(32);
const LINK_TOKEN = "e".repeat(32);

let board: ChildProcess;

/** A launch, a claim about it, and three chats standing in different places. */
function seed(): void {
  const db = openDb(DB);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at,
    symbol, name)
    VALUES ('0xtok','0xcur','0xdep','0x0000000000000000000000000000000000000000',1,'1',1,1,'0xtx',0,?,?,'TEST','Test')`)
    .run(T0 - 3600, T0 - 3600);
  db.prepare(`INSERT INTO predictions (token, launch_ts, scored_at, age_at_score, probability,
    raw_probability, rank, of, model_id, reasons_json)
    VALUES ('0xtok',?,?,4,0.31,0.31,1,10,'m1','[]')`).run(T0 - 3600, T0 - 3596);

  const link = db.prepare(`INSERT INTO wallet_links (chat_id, address, linked_at, balance, checked_at, tier, raw_tier, raw_since)
    VALUES (?,?,?,?,?,?,?,?)`);
  link.run(1, "0x" + "1".repeat(40), T0, "0", T0, 0, 0, T0);
  link.run(2, "0x" + "2".repeat(40), T0, String(2000n * 10n ** 18n), T0, 1, 1, T0);
  link.run(3, "0x" + "3".repeat(40), T0, String(20_000n * 10n ** 18n), T0, 2, 2, T0);

  db.prepare("INSERT INTO link_challenges (chat_id, token, address, nonce, issued_at) VALUES (?,?,?,?,?)")
    .run(77, LINK_TOKEN, null, "abcdef0123456789", T0);

  const key = db.prepare("INSERT INTO api_keys (key, chat_id, address, created_at) VALUES (?,?,?,?)");
  key.run(KEY_FREE, 1, "0x" + "1".repeat(40), T0);
  key.run(KEY_HOLDER, 2, "0x" + "2".repeat(40), T0);
  key.run(KEY_TWO, 3, "0x" + "3".repeat(40), T0);
  // A key whose wallet has since been unlinked. It must read as unknown, not as a free reader.
  key.run(KEY_ORPHAN, 9, "0x" + "9".repeat(40), T0);
  db.close();
}

before(async () => {
  seed();
  board = spawn(process.execPath, ["--no-warnings", "src/board.ts"], {
    env: {
      ...process.env,
      BOARD_PORT: String(PORT),
      BOARD_HOST: "127.0.0.1",
      DB_PATH: DB,
      TRUST_PROXY: "0",
      TIER1_TOKENS: "1000",
      TIER2_TOKENS: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  board.stderr?.on("data", (b: Buffer) => { stderr += String(b); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (board.exitCode !== null) throw new Error(`board exited with ${board.exitCode}:\n${stderr}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`board never answered:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (board && board.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      board?.once("exit", done);
      board?.kill();
      setTimeout(done, 5_000).unref();
    });
  }
  for (let i = 0; ; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

test("the export refuses a caller with no key, and says where one comes from", async () => {
  const r = await fetch(`${BASE}/api/export`);
  assert.equal(r.status, 401);
  const body = await r.json() as { how: string };
  assert.match(body.how, /AugurRHbot/, "a 401 that does not say how to fix it is a dead end");
});

test("a linked wallet that is not holding gets a 403, not the data", async () => {
  const r = await fetch(`${BASE}/api/export`, { headers: { "x-api-key": KEY_FREE } });
  assert.equal(r.status, 403);
  assert.equal((await r.json() as { tier: number }).tier, 0);
});

test("a key whose wallet was unlinked is unknown, not merely downgraded", async () => {
  const r = await fetch(`${BASE}/api/export`, { headers: { "x-api-key": KEY_ORPHAN } });
  assert.equal(r.status, 401, "revoking a link must revoke everything it granted");
});

test("a holder gets the claims, which are the part that cannot be rebuilt from the chain", async () => {
  const r = await fetch(`${BASE}/api/export`, { headers: { "x-api-key": KEY_HOLDER } });
  assert.equal(r.status, 200);
  const body = await r.json() as { tier: number; days: number; count: number; claims: Array<Record<string, unknown>> };
  assert.equal(body.tier, 1);
  assert.equal(body.days, 7);
  assert.equal(body.count, 1);
  assert.equal(body.claims[0].token, "0xtok");
  assert.equal(body.claims[0].symbol, "TEST", "a claim without its ticker is not much of an export");
  assert.equal(body.claims[0].probability, 0.31);
});

test("the window is capped by the tier, and asking for more does not raise it", async () => {
  const one = await (await fetch(`${BASE}/api/export?key=${KEY_HOLDER}&days=90`)).json() as { days: number };
  assert.equal(one.days, 7, "tier 1 is a week however the request is written");
  const two = await (await fetch(`${BASE}/api/export?key=${KEY_TWO}&days=90`)).json() as { days: number };
  assert.equal(two.days, 30);
  const short = await (await fetch(`${BASE}/api/export?key=${KEY_TWO}&days=2`)).json() as { days: number };
  assert.equal(short.days, 2, "asking for less than the cap is allowed");
  const silly = await (await fetch(`${BASE}/api/export?key=${KEY_TWO}&days=notanumber`)).json() as { days: number };
  assert.equal(silly.days, 30, "nonsense falls back to the cap rather than to zero days");
});

test("the key works from the query string as well as the header", async () => {
  const r = await fetch(`${BASE}/api/export?key=${KEY_HOLDER}`);
  assert.equal(r.status, 200, "a browser address bar cannot set a header");
});

test("a made-up key is not a key", async () => {
  for (const bad of ["augur_zzz", "nothing", "augur_" + "f".repeat(32)]) {
    const r = await fetch(`${BASE}/api/export`, { headers: { "x-api-key": bad } });
    assert.equal(r.status, 401, `${bad} must not open the export`);
  }
});

test("the board reports on the paid half", async () => {
  const s = await (await fetch(`${BASE}/api/stats`)).json() as {
    tiers: { configured: boolean; linked: number; tier1: number; tier2: number; keys: number };
  };
  assert.equal(s.tiers.configured, true);
  assert.equal(s.tiers.linked, 3);
  assert.equal(s.tiers.tier1, 1);
  assert.equal(s.tiers.tier2, 1);
  assert.equal(s.tiers.keys, 4);
});

test("the free routes stay free", async () => {
  for (const path of ["/api/health", "/api/stats", "/api/feed?hours=6"]) {
    const r = await fetch(`${BASE}${path}`);
    assert.equal(r.status, 200, `${path} must not have become paid`);
  }
});

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

test("the link page is served on its own path, not behind a hash", async () => {
  const r = await fetch(`${BASE}/link?t=${LINK_TOKEN}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /id="page-link"/, "a link tapped in a chat has to land on something");
});

test("a wallet connecting gets back the sentence that names it", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const r = await postJson("/api/link/claim", { token: LINK_TOKEN, address: account.address });
  assert.equal(r.status, 200);
  const body = await r.json() as { sentence: string; address: string };
  assert.equal(body.address, account.address.toLowerCase());
  assert.match(body.sentence, new RegExp(account.address.toLowerCase()), "the reader sees which wallet they are vouching for");
  assert.match(body.sentence, /costs no gas/);
  // The chat is named on purpose: it is what stops a sentence signed here from being replayed into
  // somebody else's conversation. It is not a secret from the person who opened their own link.
  assert.match(body.sentence, /chat: 77/);
});

test("the signature closes the loop, and the chat is left something to announce", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const claim = await (await postJson("/api/link/claim", { token: LINK_TOKEN, address: account.address })).json() as { sentence: string };
  const signature = await account.signMessage({ message: claim.sentence });

  const r = await postJson("/api/link/verify", { token: LINK_TOKEN, signature });
  assert.equal(r.status, 200);
  assert.equal((await r.json() as { address: string }).address, account.address.toLowerCase());

  const db = openDb(DB);
  const row = db.prepare("SELECT chat_id, address, announced_at FROM wallet_links WHERE chat_id = 77")
    .get() as { address: string; announced_at: number | null };
  db.close();
  assert.equal(row.address, account.address.toLowerCase());
  assert.equal(row.announced_at, null, "the bot has not said so yet, and must be able to tell");
});

test("a token nobody was given proves nothing", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const r = await postJson("/api/link/claim", { token: "0".repeat(32), address: account.address });
  assert.equal(r.status, 400);
  assert.equal((await r.json() as { error: string }).error, "no-challenge");
});

test("the link endpoints refuse anything that is not a small POST of JSON", async () => {
  assert.equal((await fetch(`${BASE}/api/link/claim`)).status, 405, "GET must not start a link");
  assert.equal((await postJson("/api/link/claim", { token: "nonsense", address: "0x1" })).status, 400);

  const huge = await fetch(`${BASE}/api/link/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: LINK_TOKEN, signature: "0x" + "a".repeat(20000) }),
  });
  assert.equal(huge.status, 400, "an unbounded reader on a public server is a way to be handed a gigabyte");
});
