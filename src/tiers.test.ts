import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

/**
 * The tier rules, driven without a network, a wallet or a token that exists.
 *
 * Two things here are worth more than the rest. One is that a tier cannot be borrowed: instant
 * alerts are worth the most in the minute a launch is live, so a tier that came back the moment the
 * balance did could be rented for exactly that minute. The other is that a link is a proof rather
 * than a claim, and the first version of it was not: recovery returns an address for any well-formed
 * signature, so signing anything at all used to link whatever address fell out. Three tests here
 * exist because of that, and they fail against that version.
 *
 * The thresholds have to be set before the module is imported: config reads the environment once.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-tiers-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.TIER1_TOKENS = "1000";
process.env.TIER2_TOKENS = "10000";
process.env.TIER_COOLDOWN_SEC = String(7 * 86400);
process.env.FREE_DELAY_SEC = "60";
process.env.FREE_MIN_SCORE = "10";

const { openDb } = await import("./db.ts");
const T = await import("./tiers.ts");

const db = openDb();
const T0 = 1_800_000_000;
const WEEK = 7 * 86400;
const tokens = (n: number): bigint => BigInt(n) * T.UNIT;

/** Links a fresh wallet to a chat the way the bot does: challenge, sign, verify. */
async function linkWallet(chatId: number, now = T0): Promise<{ address: string; sign: (m: string) => Promise<string> }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const { sentence } = T.challenge(db, chatId, now, account.address);
  const signature = await account.signMessage({ message: sentence });
  const res = await T.verifyLink(db, chatId, signature, now);
  assert.equal(res.ok, true, "a wallet signing the sentence it was given must link");
  return { address: account.address.toLowerCase(), sign: (m) => account.signMessage({ message: m }) };
}

test("a balance buys the tier it reaches, and nothing above it", () => {
  assert.equal(T.tierFor(0n), 0);
  assert.equal(T.tierFor(tokens(999)), 0);
  assert.equal(T.tierFor(tokens(1000)), 1, "exactly at the line counts as holding it");
  assert.equal(T.tierFor(tokens(9999)), 1);
  assert.equal(T.tierFor(tokens(10_000)), 2);
});

test("the free tier is delayed and floored; a holder is neither", () => {
  assert.deepEqual(T.gateFor(0), { delaySec: 60, minScorePct: 10 });
  assert.deepEqual(T.gateFor(1), { delaySec: 0, minScorePct: 0 });
  assert.deepEqual(T.gateFor(2), { delaySec: 0, minScorePct: 0 });
});

test("a signature over the sentence links the wallet it was made by", async () => {
  const { address } = await linkWallet(1);
  const link = T.linkOf(db, 1);
  assert.equal(link?.address, address, "the wallet that signed is the wallet that got linked");
  assert.equal(T.tierOf(db, 1), 0, "linking proves the wallet; the balance decides the tier");
});

test("a signature over anything else does not link", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  T.challenge(db, 2, T0, account.address);
  // Recovery would hand back an address for this too. It just would not be the one named.
  const wrong = await account.signMessage({ message: "Augur wallet link\nchat: 2\nnonce: deadbeef" });
  const res = await T.verifyLink(db, 2, wrong, T0);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.reason, "wrong-wallet");
  assert.equal(T.linkOf(db, 2), null);
});

test("one wallet cannot be signed for by another", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const impostor = privateKeyToAccount(generatePrivateKey());
  const { sentence } = T.challenge(db, 5, T0, owner.address);
  const res = await T.verifyLink(db, 5, await impostor.signMessage({ message: sentence }), T0);
  assert.equal(res.ok === false && res.reason, "wrong-wallet");
  assert.equal(T.linkOf(db, 5), null);
});

test("a malformed signature is refused before anything is recovered", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  T.challenge(db, 6, T0, account.address);
  for (const junk of ["", "0x", "not a signature", "0x" + "ab".repeat(64)]) {
    const res = await T.verifyLink(db, 6, junk, T0);
    assert.equal(res.ok, false, `${junk.slice(0, 12)} must not link`);
  }
  assert.equal(T.linkOf(db, 6), null);
});

test("a sentence stops working, and a chat that was never given one cannot link", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { sentence } = T.challenge(db, 3, T0, account.address);
  const sig = await account.signMessage({ message: sentence });
  const late = await T.verifyLink(db, 3, sig, T0 + T.CHALLENGE_TTL_SEC + 1);
  assert.equal(late.ok === false && late.reason, "expired");

  const none = await T.verifyLink(db, 99, sig, T0);
  assert.equal(none.ok === false && none.reason, "no-challenge");
});

test("one wallet cannot open the paid half in two chats", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const a = T.challenge(db, 10, T0, account.address);
  await T.verifyLink(db, 10, await account.signMessage({ message: a.sentence }), T0);
  const b = T.challenge(db, 11, T0, account.address);
  const second = await T.verifyLink(db, 11, await account.signMessage({ message: b.sentence }), T0);
  assert.equal(second.ok === false && second.reason, "taken");
  assert.equal(T.linkOf(db, 11), null, "the second chat gets nothing, and the first keeps what it had");
  assert.notEqual(T.linkOf(db, 10), null);
});

test("the website path: a token names the wallet when one connects, then takes the signature", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { token, sentence } = T.challenge(db, 60, T0);
  assert.equal(sentence, null, "no wallet is named until one connects, so there is nothing to sign yet");

  const claimed = T.claimChallenge(db, token, account.address, T0);
  assert.equal(claimed.ok, true);
  const sig = await account.signMessage({ message: claimed.ok ? claimed.sentence : "" });
  const done = await T.verifyByToken(db, token, sig, T0);
  assert.equal(done.ok, true);
  assert.equal(done.ok && done.chatId, 60, "the page never learns the chat; the token carries it");
  assert.equal(T.linkOf(db, 60)?.address, account.address.toLowerCase());
});

test("switching accounts before signing renames the wallet rather than failing", async () => {
  const first = privateKeyToAccount(generatePrivateKey());
  const second = privateKeyToAccount(generatePrivateKey());
  const { token } = T.challenge(db, 61, T0);
  T.claimChallenge(db, token, first.address, T0);
  const claimed = T.claimChallenge(db, token, second.address, T0);
  assert.equal(claimed.ok, true, "nothing was proved by the first one, so there is nothing to protect");

  const sig = await second.signMessage({ message: claimed.ok ? claimed.sentence : "" });
  assert.equal((await T.verifyByToken(db, token, sig, T0)).ok, true);
  assert.equal(T.linkOf(db, 61)?.address, second.address.toLowerCase());
});

test("a made-up or expired token proves nothing", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  assert.equal(T.claimChallenge(db, "0".repeat(32), account.address, T0).ok, false);

  const { token } = T.challenge(db, 62, T0);
  const claimed = T.claimChallenge(db, token, account.address, T0);
  const sig = await account.signMessage({ message: claimed.ok ? claimed.sentence : "" });
  const late = await T.verifyByToken(db, token, sig, T0 + T.CHALLENGE_TTL_SEC + 1);
  assert.equal(late.ok === false && late.reason, "expired");
  assert.equal(T.claimChallenge(db, token, account.address, T0 + T.CHALLENGE_TTL_SEC + 1).ok, false);
});

test("a signature cannot be sent before a wallet is named", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { token } = T.challenge(db, 63, T0);
  const sig = await account.signMessage({ message: "anything" });
  const res = await T.verifyByToken(db, token, sig, T0);
  assert.equal(res.ok === false && res.reason, "no-wallet");
});

test("a link made on the website is announced once and then left alone", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { token } = T.challenge(db, 64, T0);
  const claimed = T.claimChallenge(db, token, account.address, T0);
  await T.verifyByToken(db, token, await account.signMessage({ message: claimed.ok ? claimed.sentence : "" }), T0);

  assert.ok(T.unannouncedLinks(db).some((l) => l.chat_id === 64), "the bot has something to say");
  T.markAnnounced(db, 64, T0);
  assert.equal(T.unannouncedLinks(db).some((l) => l.chat_id === 64), false, "and does not say it twice");
});

test("the first grant is immediate: the week is a penalty for selling, not a queue for arriving", async () => {
  await linkWallet(20);
  const row = T.applyBalance(db, 20, tokens(10_000), T0);
  assert.equal(row?.tier, 2);
  assert.equal(row?.dropped_at, null);
});

test("selling costs the tier on the next reading, and buying back does not return it for a week", async () => {
  await linkWallet(21);
  T.applyBalance(db, 21, tokens(10_000), T0);

  const sold = T.applyBalance(db, 21, tokens(1000), T0 + 3600);
  assert.equal(sold?.tier, 1, "the drop is immediate");
  assert.equal(sold?.dropped_at, T0 + 3600);

  const back = T.applyBalance(db, 21, tokens(10_000), T0 + 7200);
  assert.equal(back?.tier, 1, "the balance is back; the tier is not");
  assert.equal(back?.raw_tier, 2);

  const pending = T.pendingRestore(back!, T0 + 7200);
  assert.equal(pending?.tier, 2);
  assert.equal(pending?.atSec, T0 + 7200 + WEEK);

  const early = T.applyBalance(db, 21, tokens(10_000), T0 + 7200 + WEEK - 1);
  assert.equal(early?.tier, 1, "a second short of the week is still short of the week");

  const served = T.applyBalance(db, 21, tokens(10_000), T0 + 7200 + WEEK);
  assert.equal(served?.tier, 2, "and then it comes back");
  assert.equal(T.pendingRestore(served!, T0 + 7200 + WEEK), null);
});

test("a tier cannot be rented: a round trip inside the window restarts the week", async () => {
  await linkWallet(22);
  T.applyBalance(db, 22, tokens(10_000), T0);
  T.applyBalance(db, 22, tokens(0), T0 + 3600);              // sold out
  T.applyBalance(db, 22, tokens(10_000), T0 + 7200);         // bought back
  T.applyBalance(db, 22, tokens(0), T0 + 10_800);            // sold again
  const back = T.applyBalance(db, 22, tokens(10_000), T0 + 14_400);
  assert.equal(back?.tier, 0, "still nothing");
  const later = T.applyBalance(db, 22, tokens(10_000), T0 + 14_400 + WEEK);
  assert.equal(later?.tier, 2, "the week runs from the last time the balance arrived, not the first");
});

test("dropping only one step leaves the step below intact", async () => {
  await linkWallet(23);
  T.applyBalance(db, 23, tokens(10_000), T0);
  const row = T.applyBalance(db, 23, tokens(1000), T0 + 60);
  assert.equal(row?.tier, 1, "a holder who sold down to tier 1 is a tier 1 holder, not a free reader");
});

test("the streak counts holding, and a cooldown does not break it", async () => {
  await linkWallet(24);
  T.applyBalance(db, 24, tokens(10_000), T0);
  const week = T.applyBalance(db, 24, tokens(10_000), T0 + WEEK);
  assert.equal(T.streakDays(week!, T0 + WEEK), 7);

  const sold = T.applyBalance(db, 24, tokens(1000), T0 + WEEK + 60);
  assert.equal(T.streakDays(sold!, T0 + WEEK + 60), 7, "selling down to tier 1 is still holding");

  const out = T.applyBalance(db, 24, 0n, T0 + WEEK + 120);
  assert.equal(T.streakDays(out!, T0 + WEEK + 120), 0, "leaving does break it");
});

test("a free reader keeps the threshold they asked for, but reads it against the floor", () => {
  assert.equal(T.effectiveMin(3, 0), 10, "below the floor, the floor wins");
  assert.equal(T.effectiveMin(3, 1), 3, "and the day they hold, their own number is live");
  assert.equal(T.effectiveMin(25, 0), 25, "a quieter setting than the floor is still theirs");
});

test("a free alert waits out the delay; a holder's does not", () => {
  db.prepare(`INSERT INTO predictions (token, launch_ts, scored_at, age_at_score, probability,
    raw_probability, rank, of, model_id, reasons_json)
    VALUES ('0xripe',?,?,4,0.3,0.3,1,10,'m1','[]')`).run(T0, T0);

  assert.equal(T.ripeFor(db, "0xripe", 0, T0 + 59), false, "a second short of the minute is short of it");
  assert.equal(T.ripeFor(db, "0xripe", 0, T0 + 60), true);
  assert.equal(T.ripeFor(db, "0xripe", 1, T0), true, "a holder gets it the second the claim exists");
  assert.equal(T.ripeFor(db, "0xnoclaim", 0, T0), true,
    "a launch with no claim came off the slow pass; holding it back again would only delay it twice");
});

test("an unlinked chat is the free bot, not a broken one", () => {
  assert.equal(T.tierOf(db, 12345), 0);
  assert.deepEqual(T.gateFor(T.tierOf(db, 12345)), { delaySec: 60, minScorePct: 10 });
});

test("what the bot says about a tier is true, including the part that is a countdown", async () => {
  const { tierText, ago } = await import("./tgtext.ts");
  assert.equal(ago(7 * 86400), "7.0d", "a week printed as 168.0h is a true number nobody reads as a week");

  const free = tierText(db, 98765, T0);
  assert.match(free, /free/);
  assert.match(free, /60s/, "the free reader is told what the delay is, not just that there is one");
  assert.match(free, /10%/);

  await linkWallet(50);
  T.applyBalance(db, 50, tokens(10_000), T0);
  assert.match(tierText(db, 50, T0), /tier<\/b> 2/);

  T.applyBalance(db, 50, tokens(1000), T0 + 60);
  T.applyBalance(db, 50, tokens(10_000), T0 + 120);
  const waiting = tierText(db, 50, T0 + 120);
  assert.match(waiting, /comes back in 7\.0d/, "and the countdown is in days");
  assert.doesNotMatch(waiting, /clone alerts|nightly snapshot/,
    "tier 2 must not advertise the two things it does not do yet");
});

test("a key carries the tier of its link, and unlinking revokes it", async () => {
  await linkWallet(30);
  T.applyBalance(db, 30, tokens(10_000), T0);
  const key = T.issueKey(db, 30, T0);
  assert.ok(key?.startsWith("augur_"));
  assert.equal(T.keyHolder(db, key!, T0)?.tier, 2);

  T.applyBalance(db, 30, 0n, T0 + 60);
  assert.equal(T.keyHolder(db, key!, T0 + 60)?.tier, 0, "a sell reaches the API on the same reading it reaches the bot");

  assert.equal(T.unlink(db, 30), true);
  assert.equal(T.keyHolder(db, key!, T0 + 120), null, "the key dies with the link");
  assert.equal(T.keyOf(db, 30), null);
});

test("a key cannot be issued for a chat that has proved nothing", () => {
  assert.equal(T.issueKey(db, 4242, T0), null);
});

test("re-issuing a key retires the old one", async () => {
  await linkWallet(31);
  const first = T.issueKey(db, 31, T0)!;
  const second = T.issueKey(db, 31, T0 + 1)!;
  assert.notEqual(first, second);
  assert.equal(T.keyHolder(db, first, T0 + 2), null);
  assert.notEqual(T.keyHolder(db, second, T0 + 2), null);
});

test("the board can report on the paid half", async () => {
  const before = T.tierCounts(db);
  await linkWallet(40);
  T.applyBalance(db, 40, tokens(10_000), T0);
  const after = T.tierCounts(db);
  assert.equal(after.linked, before.linked + 1);
  assert.equal(after.tier2, before.tier2 + 1);
});
