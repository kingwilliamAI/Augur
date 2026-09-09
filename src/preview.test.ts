import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scoring a launch that has not happened.
 *
 * The claim this makes is strong — that a preview is the model rather than a likeness of it — so the
 * tests are about the two ways that claim could quietly become false. One is the leak: a creator's
 * graduations must be counted by when they graduated, not by when they launched, or a preview would
 * take credit for an outcome that has not happened and read higher than the score the same launch
 * gets a minute later. The other is undeclared-versus-zero: half of real launches have calldata the
 * indexer cannot decode, the model has a feature for exactly that absence, and folding "did not say"
 * into "bought nothing" would poison it.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-preview-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const { preview, historyFor, rankedAtLaunch } = await import("./preview.ts");
const { loadModel } = await import("./score.ts");

const db = openDb();
const model = loadModel();
const T0 = 1_800_000_000;
const ETH = "0x0000000000000000000000000000000000000000";
const addr = (n: number): string => "0x" + String(n).padStart(40, "0");

let seq = 0;
function launch(sender: string, ts: number, gradTs: number | null): string {
  const token = "0xp" + (seq++);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, symbol, launch_sender)
    VALUES (?,?,?,?,1,'1000000000000000000',1,?,?,0,?,?,'TEST',?)`)
    .run(token, "0xc", sender, ETH, seq, "0xtx" + seq, ts, ts, sender);
  if (gradTs !== null) {
    db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
      VALUES (?,?,?,?,'1','1','1',1)`).run(token, seq, "0xg" + seq, gradTs);
  }
  return token;
}

test("a model is loadable, or the rest of this file is meaningless", () => {
  assert.ok(model, "data/model.json must exist for a preview to be the model rather than a guess");
});

test("a preview needs a creator and a ticker, and says why", () => {
  const noCreator = preview(db, model!, { creator: "nope", symbol: "X" }, T0);
  assert.ok("error" in noCreator);
  assert.match(noCreator.error, /record is half the score/);

  const noSymbol = preview(db, model!, { creator: addr(1), symbol: "" }, T0);
  assert.ok("error" in noSymbol);
  assert.match(noSymbol.error, /length is a feature/);
});

test("a graduation that has not happened yet is not counted", () => {
  const creator = addr(10);
  // Launched before the preview, graduates after it. The launch counts; the graduation must not.
  launch(creator, T0 - 7200, T0 + 3600);
  const h = historyFor(db, creator, T0);
  assert.equal(h.priorL, 1, "the launch itself is in the past and counts");
  assert.equal(h.priorG, 0, "counting it by launch time would be a preview claiming the future");

  const later = historyFor(db, creator, T0 + 7200);
  assert.equal(later.priorG, 1, "and once it has happened, it counts");
});

test("history is read from the column the model reads, not the one the card shows", () => {
  const router = addr(15);
  const person = addr(16);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, symbol, launch_sender)
    VALUES ('0xrouted','0xc',?,?,1,'1',1,999,'0xtxr',0,?,?,'R',?)`).run(router, ETH, T0 - 100, T0 - 100, person);

  assert.equal(historyFor(db, router, T0).priorL, 1,
    "the model counts on launches.deployer, so a routed launch belongs to the router there");
  assert.equal(historyFor(db, person, T0).priorL, 0,
    "counting the human-facing address would disagree with the score the launch actually gets");
});

test("a launch after the moment being previewed is not in the record at all", () => {
  const creator = addr(11);
  launch(creator, T0 + 600, null);
  assert.equal(historyFor(db, creator, T0).priorL, 0);
});

test("congestion comes from the real last hour, not from a constant", () => {
  const before = historyFor(db, addr(12), T0).recentCount;
  for (let i = 0; i < 5; i++) launch(addr(13), T0 - 60 - i, null);
  assert.equal(historyFor(db, addr(12), T0).recentCount, before + 5,
    "the same parameters have to score differently in a wave and in a quiet hour");
});

test("exempt overlap only counts wallets this creator has waived before", () => {
  const creator = addr(14);
  const token = launch(creator, T0 - 3600, null);
  db.prepare("INSERT INTO exemptions (token, address) VALUES (?,?)").run(token, addr(77));

  assert.equal(historyFor(db, creator, T0, [addr(77)]).overlap, 1);
  assert.equal(historyFor(db, creator, T0, [addr(78)]).overlap, 0);
  assert.equal(historyFor(db, creator, T0, []).overlap, 0, "naming none is not the same as there being none");
});

test("a hostile body cannot reach the arithmetic, let alone the process", () => {
  // Every one of these killed the board before the input was cleaned: an unauthenticated POST of
  // arbitrary JSON reached a dereference with no try/catch anywhere above it.
  const hostile: Array<Record<string, unknown>> = [
    { creator: addr(20), symbol: "X", exempt: 5 },
    { creator: addr(20), symbol: "X", quoteToken: 42 },
    { creator: addr(20), symbol: "X", feeRecipient: { a: 1 } },
    { creator: addr(20), symbol: "X", initialBuyWei: ["nope"] },
    { creator: addr(20), symbol: "X", creatorTaxBps: "abc", exemptCount: -9 },
    { creator: addr(20), symbol: { toString: null }, description: 5 },
  ];
  for (const body of hostile) {
    assert.doesNotThrow(() => preview(db, model!, body as never, T0), JSON.stringify(body));
  }
});

test("a routed launch is flagged rather than scored against an invented address", () => {
  const via = preview(db, model!, { creator: addr(20), symbol: "R", viaContract: true }, T0) as
    { assumed: string[]; history: { priorL: number } };
  const direct = preview(db, model!, { creator: addr(20), symbol: "R" }, T0) as { history: { priorL: number } };
  assert.equal(via.history.priorL, direct.history.priorL,
    "substituting a placeholder deployer wiped the record instead of modelling a router");
  assert.ok(via.assumed.some((a) => /router/.test(a)), "and the caveat has to be printed");
});

test("a preview produces a probability, a rank and three reasons", () => {
  const p = preview(db, model!, {
    creator: addr(20), symbol: "AUGUR", description: "a test", initialBuyWei: "50000000000000000",
    creatorTaxBps: 150, twitter: "https://x.com/kingwilliam_",
  }, T0);
  assert.ok(!("error" in p));
  const r = p as Exclude<typeof p, { error: string }>;
  assert.ok(r.probability > 0 && r.probability < 1, "a probability, not a score out of ten");
  assert.equal(r.reasons.length, 3);
  assert.ok(r.rank >= 1);
  assert.ok(r.rank <= r.of, "a launch cannot rank below the size of the field it is being ranked in");
  assert.ok(r.of >= 1);
  assert.equal(r.creator, addr(20));
});

test("undeclared is not zero: the model has a feature for not knowing", () => {
  const base = { creator: addr(21), symbol: "SAME", creatorTaxBps: 100 };
  const undeclared = preview(db, model!, { ...base }, T0) as { probability: number };
  const declaredZero = preview(db, model!, { ...base, initialBuyWei: "0" }, T0) as { probability: number };
  assert.notEqual(undeclared.probability, declaredZero.probability,
    "folding 'did not say' into 'bought nothing' would poison the strongest feature");
});

test("a creator's own record moves their score", () => {
  const fresh = addr(30);
  const veteran = addr(31);
  for (let i = 0; i < 8; i++) launch(veteran, T0 - 86_400 * (i + 2), T0 - 86_400 * (i + 1));

  const params = { symbol: "SAME", creatorTaxBps: 100, initialBuyWei: "10000000000000000" };
  const a = preview(db, model!, { ...params, creator: fresh }, T0) as { probability: number; history: { priorG: number } };
  const b = preview(db, model!, { ...params, creator: veteran }, T0) as { probability: number; history: { priorG: number } };
  assert.equal(a.history.priorG, 0);
  assert.equal(b.history.priorG, 8);
  assert.notEqual(a.probability, b.probability, "the record is half the score, so it has to change it");
});

test("what the preview filled in for itself is printed, not hidden", () => {
  const p = preview(db, model!, { creator: addr(40), symbol: "Q" }, T0) as { assumed: string[] };
  assert.ok(p.assumed.length > 0);
  assert.ok(p.assumed.some((a) => /self-buy undeclared/.test(a)));
  assert.ok(p.assumed.some((a) => /quoted in ETH/.test(a)));

  const declared = preview(db, model!, {
    creator: addr(40), symbol: "Q", initialBuyWei: "1", exemptCount: 0,
    creatorTaxBps: 0, graduationThresholdWei: "5", quoteToken: ETH,
  }, T0) as { assumed: string[] };
  assert.equal(declared.assumed.some((a) => /self-buy/.test(a)), false, "a declared number is not an assumption");
});

test("a quote asset's own decimals are used, not eighteen for everything", () => {
  db.prepare("INSERT INTO quote_assets (address, symbol, decimals) VALUES (?,?,?)")
    .run(addr(60), "USDG", 6);
  const params = { creator: addr(41), symbol: "Q", initialBuyWei: "1000000" };
  const sixDec = preview(db, model!, { ...params, quoteToken: addr(60) }, T0) as { probability: number };
  const eighteen = preview(db, model!, { ...params, quoteToken: ETH }, T0) as { probability: number };
  assert.notEqual(sixDec.probability, eighteen.probability,
    "a million units is one dollar in USDG and a millionth of an ETH; they cannot score the same");
});

test("where a launch ranked is read back from the claim, not recomputed", () => {
  const token = launch(addr(50), T0 - 100, null);
  assert.equal(rankedAtLaunch(db, token), null, "no claim, no answer, rather than a made-up one");

  db.prepare(`INSERT INTO predictions (token, launch_ts, scored_at, age_at_score, probability,
    raw_probability, rank, of, model_id, reasons_json) VALUES (?,?,?,4,0.21,0.21,3,101,'m1','[]')`)
    .run(token, T0 - 100, T0 - 96);
  const r = rankedAtLaunch(db, token)!;
  assert.equal(r.rank, 3);
  assert.equal(r.of, 101);
  assert.equal(r.probability, 0.21);
  assert.equal(Math.round(r.betterThanPct), 98, "third of a hundred and one is the top two percent");
  assert.equal(r.windowHours, 6,
    "the claim's rank is over six hours, and calling it an hour was a number dressed as a tighter claim");
});
