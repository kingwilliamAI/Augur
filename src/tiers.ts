import { randomBytes } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { CFG } from "./config.ts";
import type { DB } from "./db.ts";

/**
 * Holder tiers: what holding $AUGUR opens, and how a chat proves it holds any.
 *
 * Kept apart from the bot and the board because both of them ask the same questions and neither is
 * testable. The bot is a long-poll loop against Telegram and the board is an HTTP server; the rules
 * about who gets what are neither, and they are the part that has to be right. Everything here is a
 * pure function of the database and the clock, so the whole tier machine can be driven from a test
 * without a network, a wallet, or a token that exists.
 *
 * What is deliberately not here: any path that takes a key, a seed, or an approval. A tier is proved
 * by a signature over a sentence, which every wallet can produce for free and which moves nothing.
 * The bot holds no funds and signs nothing, and that promise is kept by there being no code that
 * could break it.
 */

export type Tier = 0 | 1 | 2;

/** Whole tokens to wei. $AUGUR is an 18-decimal pons launch, like every other token on this curve. */
export const UNIT = 10n ** 18n;

/** How long a sentence stays signable. */
export const CHALLENGE_TTL_SEC = 600;

/**
 * Whether the paid half is switched on at all.
 *
 * Both thresholds at zero means it is not, and then every reader is treated as a holder. That is how
 * this ships before a supply is known: the machinery runs against real chats, real signatures and
 * real balances, while the one number nobody can justify yet stays unset rather than being invented
 * and printed on the site as though it had been decided.
 */
export const tiersConfigured = (): boolean => CFG.tier1Tokens > 0 || CFG.tier2Tokens > 0;

/** What a balance is worth, before any penalty for having sold. */
export function tierFor(balanceWei: bigint): Tier {
  if (!tiersConfigured()) return 2;
  if (CFG.tier2Tokens > 0 && balanceWei >= BigInt(CFG.tier2Tokens) * UNIT) return 2;
  if (CFG.tier1Tokens > 0 && balanceWei >= BigInt(CFG.tier1Tokens) * UNIT) return 1;
  return 0;
}

/**
 * What a tier changes about an alert.
 *
 * The delay is the whole product. Half of all graduations happen within two minutes of the launch
 * and a quarter within thirty seconds, so a minute is long enough to be the difference between
 * acting and reading, and short enough that the free bot is still worth having rather than being a
 * teaser. The floor exists because without it `/watch 0` turns the free bot into the paid one.
 */
export function gateFor(tier: Tier): { delaySec: number; minScorePct: number } {
  return tier >= 1
    ? { delaySec: 0, minScorePct: 0 }
    : { delaySec: CFG.freeDelaySec, minScorePct: CFG.freeMinScore };
}

/**
 * The floor a chat's own threshold is read against: what it asked for, or the free floor if higher.
 *
 * The asked-for number is kept rather than clamped on the way in, so a reader who set /watch 3 while
 * free starts getting 3% the day their balance arrives, instead of having to remember to set it
 * again. What they asked for is theirs; what it does today depends on what they hold.
 */
export const effectiveMin = (askedPct: number, tier: Tier): number =>
  Math.max(askedPct, gateFor(tier).minScorePct);

const ripeStmt = new WeakMap<DB, ReturnType<DB["prepare"]>>();

/**
 * Whether an alert is old enough for this tier to be told about it.
 *
 * Measured from when the claim was written rather than from the launch. The claim is the thing being
 * sold early, and a launch the watcher was slow to reach should not spend a free reader's minute
 * before the delay even starts.
 *
 * A launch with no claim row came off the slower full pass rather than from the watcher, and then
 * there is no clock to hold it against; it is let through. That can only ever make a free alert
 * earlier than the rule promises, never later, and the full pass is already a minute-scale path.
 */
export function ripeFor(db: DB, token: string, tier: Tier, now: number): boolean {
  const delay = gateFor(tier).delaySec;
  if (delay <= 0) return true;
  let stmt = ripeStmt.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT scored_at FROM predictions WHERE token = ?");
    ripeStmt.set(db, stmt);
  }
  const row = stmt.get(token) as { scored_at: number } | undefined;
  return row ? now - row.scored_at >= delay : true;
}

export type LinkRow = {
  chat_id: number;
  address: string;
  linked_at: number;
  announced_at: number | null;
  balance: string;
  checked_at: number;
  tier: Tier;
  raw_tier: Tier;
  raw_since: number;
  dropped_at: number | null;
  streak_from: number | null;
};

export const linkOf = (db: DB, chatId: number): LinkRow | null =>
  (db.prepare("SELECT * FROM wallet_links WHERE chat_id = ?").get(chatId) as LinkRow | undefined) ?? null;

export const linkByAddress = (db: DB, address: string): LinkRow | null =>
  (db.prepare("SELECT * FROM wallet_links WHERE address = ?").get(address.toLowerCase()) as LinkRow | undefined) ?? null;

/**
 * The tier a chat actually gets right now.
 *
 * An unlinked chat is tier 0, which is the free bot, not a broken one: everything that worked before
 * tiers existed still works, a minute later and above the floor.
 */
export function tierOf(db: DB, chatId: number): Tier {
  if (!tiersConfigured()) return 2;
  return linkOf(db, chatId)?.tier ?? 0;
}

/* ── proving a wallet ───────────────────────────────────────────────────────── */

/**
 * The sentence a chat is asked to sign.
 *
 * Written to be read, not parsed: someone about to sign it should be able to tell from the words
 * alone that it is not a transaction. It names the wallet being proved, so the reader can see which
 * one they are about to vouch for, and the chat it belongs to, so a sentence lifted from one
 * conversation cannot be replayed in another. The nonce and the time make it stop working.
 *
 * Rebuilt from the stored nonce at verification rather than stored whole, which means the sentence
 * that was signed and the sentence that is checked can never disagree.
 */
export function sentenceFor(chatId: number, address: string, nonce: string, issuedAt: number): string {
  return [
    "Augur wallet link",
    `wallet: ${address}`,
    `chat: ${chatId}`,
    `nonce: ${nonce}`,
    `issued: ${new Date(issuedAt * 1000).toISOString()}`,
    "",
    "Signing this proves the wallet is mine.",
    "It moves no funds, approves nothing, and costs no gas.",
  ].join("\n");
}

/**
 * Issues a fresh challenge for a chat, replacing any it is already sitting on.
 *
 * Two ways in. The website gets a token in a URL and names the wallet later, when one connects; the
 * bot's manual path names it up front. Either way the wallet is named before anything is signed, and
 * the sentence names it back.
 *
 * That ordering is not a convenience. Recovery hands back an address for any well-formed signature:
 * sign something else and it yields a different address, one nobody controls, which an
 * implementation that trusted recovery alone would happily link. Naming the wallet first turns that
 * into a mismatch that fails loudly.
 */
export function challenge(
  db: DB, chatId: number, now: number, address?: string,
): { token: string; nonce: string; sentence: string | null } {
  const nonce = randomBytes(8).toString("hex");
  const token = randomBytes(16).toString("hex");
  const a = address ? address.toLowerCase() : null;
  db.prepare(`INSERT INTO link_challenges (chat_id, token, address, nonce, issued_at) VALUES (?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET token = excluded.token, address = excluded.address,
      nonce = excluded.nonce, issued_at = excluded.issued_at`)
    .run(chatId, token, a, nonce, now);
  return { token, nonce, sentence: a ? sentenceFor(chatId, a, nonce, now) : null };
}

type ChallengeRow = { chat_id: number; token: string; address: string | null; nonce: string; issued_at: number };

const challengeBy = (db: DB, column: "token" | "chat_id", value: string | number): ChallengeRow | null =>
  (db.prepare(`SELECT * FROM link_challenges WHERE ${column} = ?`).get(value) as ChallengeRow | undefined) ?? null;

/**
 * Names the wallet on a challenge the website is holding, and hands back the sentence to sign.
 *
 * Called when a wallet connects on the link page. A second call with a different wallet simply
 * renames it, because somebody switching accounts in their extension before signing is a person
 * changing their mind, not an attack: nothing has been proved yet either way.
 */
export function claimChallenge(
  db: DB, token: string, address: string, now: number,
): { ok: true; sentence: string; address: string } | { ok: false; reason: "no-challenge" | "expired" | "bad-address" } {
  const ch = challengeBy(db, "token", token);
  if (!ch) return { ok: false, reason: "no-challenge" };
  if (now - ch.issued_at > CHALLENGE_TTL_SEC) return { ok: false, reason: "expired" };
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, reason: "bad-address" };
  db.prepare("UPDATE link_challenges SET address = ? WHERE token = ?").run(a, token);
  return { ok: true, sentence: sentenceFor(ch.chat_id, a, ch.nonce, ch.issued_at), address: a };
}

export type LinkResult =
  | { ok: true; address: string; chatId: number }
  | { ok: false; reason: "no-challenge" | "no-wallet" | "expired" | "bad-signature" | "wrong-wallet" | "taken" };

/**
 * Checks a signature against the sentence a challenge names, and links the wallet if it matches.
 *
 * Recovery alone proves nothing. It returns an address for any well-formed signature, so a reader
 * who signs a different message hands back a signature that recovers to some address they do not
 * control, and an implementation that stopped there would link it. What makes this a proof is that
 * the recovered address has to equal the one the sentence names.
 *
 * A wallet already linked to another chat is refused rather than moved: moving it silently would
 * take the paid half away from whoever had it without telling them.
 */
async function verifyChallenge(
  db: DB, ch: ChallengeRow | null, signature: string, now: number,
): Promise<LinkResult> {
  if (!ch) return { ok: false, reason: "no-challenge" };
  if (ch.address === null) return { ok: false, reason: "no-wallet" };
  if (now - ch.issued_at > CHALLENGE_TTL_SEC) {
    db.prepare("DELETE FROM link_challenges WHERE chat_id = ?").run(ch.chat_id);
    return { ok: false, reason: "expired" };
  }

  const message = sentenceFor(ch.chat_id, ch.address, ch.nonce, ch.issued_at);
  const sig = signature.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: "bad-signature" };

  let recovered: string;
  try {
    recovered = (await recoverMessageAddress({ message, signature: sig as `0x${string}` })).toLowerCase();
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  // A contract wallet signs by answering a call rather than by making a curve point, so it cannot
  // pass this and is refused. Every wallet that can hold a pons launch can sign a message.
  if (recovered !== ch.address) return { ok: false, reason: "wrong-wallet" };

  const taken = linkByAddress(db, recovered);
  if (taken && taken.chat_id !== ch.chat_id) return { ok: false, reason: "taken" };

  db.prepare(`INSERT INTO wallet_links (chat_id, address, linked_at) VALUES (?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at,
      balance = '0', checked_at = 0, tier = 0, raw_tier = 0, raw_since = 0, dropped_at = NULL,
      streak_from = NULL, announced_at = NULL`)
    .run(ch.chat_id, recovered, now);
  db.prepare("DELETE FROM link_challenges WHERE chat_id = ?").run(ch.chat_id);
  return { ok: true, address: recovered, chatId: ch.chat_id };
}

/** The manual path: a signature pasted back into the chat that asked for it. */
export const verifyLink = (db: DB, chatId: number, signature: string, now: number): Promise<LinkResult> =>
  verifyChallenge(db, challengeBy(db, "chat_id", chatId), signature, now);

/** The website path: the page posts the signature under the token it was opened with. */
export const verifyByToken = (db: DB, token: string, signature: string, now: number): Promise<LinkResult> =>
  verifyChallenge(db, challengeBy(db, "token", token), signature, now);

/**
 * Links made on the website, which the bot has not mentioned yet.
 *
 * The page can prove a wallet, but it cannot speak in the chat, so the confirmation has to come from
 * the side that can. Reading a flag beats the page trying to call the bot: one writer, one reader,
 * and nothing to get out of step if either restarts mid-flow.
 */
export const unannouncedLinks = (db: DB): LinkRow[] =>
  db.prepare("SELECT * FROM wallet_links WHERE announced_at IS NULL").all() as LinkRow[];

export const markAnnounced = (db: DB, chatId: number, now: number): void => {
  db.prepare("UPDATE wallet_links SET announced_at = ? WHERE chat_id = ?").run(now, chatId);
};

/** Forgets the wallet, the tier and the key. The same act that granted them takes them back. */
export function unlink(db: DB, chatId: number): boolean {
  const had = linkOf(db, chatId) !== null;
  db.prepare("DELETE FROM wallet_links WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM link_challenges WHERE chat_id = ?").run(chatId);
  db.prepare("DELETE FROM api_keys WHERE chat_id = ?").run(chatId);
  return had;
}

/* ── what a balance does to a tier ──────────────────────────────────────────── */

/**
 * Folds one balance reading into a chat's standing.
 *
 * A sell costs the tier at once and buying back does not return it for a week. That asymmetry is the
 * only thing standing between a tier and being borrowed: instant alerts are worth the most in the
 * minute a launch is live, and a tier that could be dropped and reclaimed inside a block could be
 * rented for exactly that minute by anyone willing to round-trip the balance.
 *
 * A first grant is immediate, because the week is a penalty for having sold rather than a queue for
 * arriving. `dropped_at` is what tells the two apart, and it is never cleared.
 *
 * What this cannot see is a dip that heals between two readings. Balances are read on a timer, so a
 * wallet that sells and buys back inside the hour keeps its tier. Closing that would mean watching
 * every transfer of the token in real time, which is a great deal of machinery to catch a trade that
 * costs its maker two lots of fees and slippage to save one hour of one tier.
 */
export function applyBalance(db: DB, chatId: number, balanceWei: bigint, now: number): LinkRow | null {
  const row = linkOf(db, chatId);
  if (!row) return null;

  const raw = tierFor(balanceWei);
  const rawSince = raw === row.raw_tier && row.raw_since > 0 ? row.raw_since : now;

  let tier: Tier = row.tier;
  let droppedAt = row.dropped_at;
  if (raw < tier) {
    tier = raw;
    droppedAt = now;
  } else if (raw > tier) {
    const served = droppedAt === null || now - rawSince >= CFG.tierCooldownSec;
    if (served) tier = raw;
  }

  // The streak is continuous holding at tier 1 or above, by the balance rather than by the tier:
  // a wallet serving out a cooldown has not stopped holding, and saying it has would read as a
  // second punishment for the same sell.
  let streakFrom = row.streak_from;
  if (raw >= 1) streakFrom = streakFrom ?? now;
  else streakFrom = null;

  db.prepare(`UPDATE wallet_links SET balance = ?, checked_at = ?, tier = ?, raw_tier = ?,
      raw_since = ?, dropped_at = ?, streak_from = ? WHERE chat_id = ?`)
    .run(balanceWei.toString(), now, tier, raw, rawSince, droppedAt, streakFrom, chatId);
  return linkOf(db, chatId);
}

/** Whole days a wallet has held at tier 1 or above without interruption. */
export const streakDays = (row: LinkRow, now: number): number =>
  row.streak_from === null ? 0 : Math.floor((now - row.streak_from) / 86400);

/** When a tier being served out comes back, or null when nothing is pending. */
export function pendingRestore(row: LinkRow, now: number): { tier: Tier; atSec: number } | null {
  if (row.raw_tier <= row.tier || row.dropped_at === null) return null;
  const at = row.raw_since + CFG.tierCooldownSec;
  return at > now ? { tier: row.raw_tier, atSec: at } : null;
}

/* ── API keys ───────────────────────────────────────────────────────────────── */

/** Issues a key for a linked chat, replacing whatever it had. Unlinking revokes it. */
export function issueKey(db: DB, chatId: number, now: number): string | null {
  const link = linkOf(db, chatId);
  if (!link) return null;
  const key = "augur_" + randomBytes(16).toString("hex");
  db.prepare("DELETE FROM api_keys WHERE chat_id = ?").run(chatId);
  db.prepare("INSERT INTO api_keys (key, chat_id, address, created_at) VALUES (?,?,?,?)")
    .run(key, chatId, link.address, now);
  return key;
}

export const keyOf = (db: DB, chatId: number): string | null =>
  (db.prepare("SELECT key FROM api_keys WHERE chat_id = ?").get(chatId) as { key: string } | undefined)?.key ?? null;

/**
 * The tier behind an API key, or null when the key is unknown.
 *
 * The tier is read through the link rather than copied onto the key, so a sell reaches the API on
 * the same reading it reaches the bot. A key whose link has gone is unknown, not merely downgraded.
 */
export function keyHolder(db: DB, key: string, now: number): { chatId: number; address: string; tier: Tier } | null {
  const row = db.prepare("SELECT chat_id, address FROM api_keys WHERE key = ?")
    .get(key) as { chat_id: number; address: string } | undefined;
  if (!row) return null;
  const link = linkOf(db, row.chat_id);
  if (!link) return null;
  db.prepare("UPDATE api_keys SET last_at = ?, calls = calls + 1 WHERE key = ?").run(now, key);
  return { chatId: row.chat_id, address: row.address, tier: tiersConfigured() ? link.tier : 2 };
}

/** What the board says about the paid half, for the page that reports on itself. */
export function tierCounts(db: DB): { linked: number; tier1: number; tier2: number; keys: number } {
  const r = db.prepare(`SELECT count(*) linked,
      sum(tier = 1) tier1, sum(tier = 2) tier2,
      (SELECT count(*) FROM api_keys) keys FROM wallet_links`)
    .get() as { linked: number; tier1: number | null; tier2: number | null; keys: number };
  return { linked: r.linked, tier1: r.tier1 ?? 0, tier2: r.tier2 ?? 0, keys: r.keys };
}
