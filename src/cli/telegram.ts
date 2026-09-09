import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import { stateClient, withRetry } from "../chain.ts";
import { ADDR, CFG, EXPLORER } from "../config.ts";
import { openDb, type DB } from "../db.ts";
import { loadModel, scoreRecent, type Scored } from "../score.ts";
import { claimsFor } from "../alerts.ts";
import { alertText, HELP, statusText, tierText, tokenText, topText, type LaunchMeta } from "../tgtext.ts";
import {
  applyBalance, challenge, CHALLENGE_TTL_SEC, effectiveMin, gateFor, issueKey, linkOf,
  markAnnounced, ripeFor, tierOf, tiersConfigured, unannouncedLinks, unlink, verifyLink, type Tier,
} from "../tiers.ts";

/**
 * augur telegram — the board's alerts, in a chat.
 *
 * This is the one part of the project that speaks to a third party, so it is worth being plain about
 * what that costs. Everything else here reads a public RPC and writes to a file on your disk; this
 * sends launch addresses and scores to Telegram's servers. All of it is public chain data plus a
 * number this machine computed, and none of it is a key, a seed, or anything about a wallet you
 * control. Still, it leaves the machine, which nothing else does, and that is why the bot is a
 * separate command you start on purpose rather than part of the watcher.
 *
 * The promises on the Telegram page are enforced here rather than merely stated. The bot never
 * messages a chat that has not sent /start, because a chat only enters `tg_subs` by doing so. It
 * never asks for a key or a seed, because there is no command that takes one. It holds nothing and
 * signs nothing: every reply is built from the same local database the board reads.
 *
 * augur telegram [--min N] [--window-hours N] [--interval-sec N] [--once]
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const DEFAULT_MIN = arg("min", 8);
const WINDOW_HOURS = arg("window-hours", 1);
const INTERVAL_SEC = arg("interval-sec", 30);
const ONCE = has("once");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error(`no TELEGRAM_BOT_TOKEN set.

Create a bot with @BotFather in Telegram, then put the token it gives you in .env:

  TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here

.env is git-ignored, so the token stays on this machine. Do not paste it into a chat,
a commit, or an issue: anyone holding it controls the bot.`);
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

/**
 * One call to the Telegram API.
 *
 * Failures are returned rather than thrown. A bot that dies because Telegram had a bad minute is
 * worse than one that skips a message: the alert loop is the point, and it has to outlive the
 * network.
 */
async function tg<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(40_000),
    });
    const j = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!j.ok) {
      // 409 means another copy of this bot is already long-polling; that one is not survivable.
      if (j.description?.includes("terminated by other getUpdates")) {
        console.error("\nanother copy of this bot is already running; stop it first");
        process.exit(1);
      }
      return null;
    }
    return j.result ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Button = { text: string; url: string };

async function send(chatId: number, text: string, buttons?: Button[]): Promise<boolean> {
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    // One row. Telegram stacks a second row into its own line, and three links about one launch do
    // not need two lines.
    ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
  return r !== null;
}

/**
 * The mark, sent once and then referred to by id.
 *
 * Telegram answers an upload with a `file_id` standing for the copy now on their side, so the image
 * crosses the wire once for the life of the process rather than once per `/start`. The id is dropped
 * if it ever stops working, which is what a restart of their end looks like from here.
 *
 * Every failure falls through to the text. A chat that cannot be shown the picture still gets the
 * words, because the words are the part that matters and a missing file is not a reason to answer
 * nothing at all.
 */
const BANNER = join(import.meta.dirname, "..", "..", "docs", "img", "banner.png");
let bannerId: string | null = null;

async function sendBanner(chatId: number, caption: string): Promise<boolean> {
  if (bannerId) {
    const again = await tg("sendPhoto", { chat_id: chatId, photo: bannerId, caption, parse_mode: "HTML" });
    if (again) return true;
    bannerId = null;
  }
  if (!existsSync(BANNER)) return send(chatId, caption);
  try {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    form.set("photo", new Blob([readFileSync(BANNER)], { type: "image/png" }), "augur.png");
    const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    const j = await res.json() as { ok: boolean; result?: { photo?: Array<{ file_id: string }> } };
    if (!j.ok) return send(chatId, caption);
    // The largest of the sizes Telegram made, so a later send is the picture and not a thumbnail.
    const sizes = j.result?.photo ?? [];
    bannerId = sizes.length ? sizes[sizes.length - 1].file_id : null;
    return true;
  } catch {
    return send(chatId, caption);
  }
}

/**
 * The links that belong under a launch, as buttons rather than as text.
 *
 * A reader who wants to act on an alert wants one tap, not a link buried in a paragraph they have to
 * find first. Trading comes first because it is the thing being decided; the explorer and the pons
 * page are for checking, and checking happens after.
 */
const linksFor = (token: string): Button[] => [
  { text: "Buy on Axiom", url: EXPLORER.axiom(token) },
  { text: "Explorer", url: EXPLORER.token(token) },
  { text: "pons", url: EXPLORER.pons(token) },
];

const db: DB = openDb();

/**
 * Subscribes a chat, and treats everything already in the window as seen.
 *
 * Without that second half the first pass after /start delivers a burst: every launch currently
 * above the threshold is new to this chat, so up to twenty-five of them arrive at once, all of them
 * minutes old and none of them the thing the reader asked to be told about. Alerts are meant to say
 * "this just happened", so subscribing starts the clock rather than emptying the window into it.
 *
 * Lowering the threshold later does the same, and for the same reason: the launches it newly admits
 * are ones that were already there.
 */
function subscribe(chatId: number, min: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO tg_subs (chat_id, min_score, created_at, last_at) VALUES (?,?,?,0)
    ON CONFLICT(chat_id) DO UPDATE SET min_score = excluded.min_score`)
    .run(chatId, min, now);

  const model = loadModel();
  if (!model) return;
  const mark = db.prepare("INSERT INTO tg_sent (chat_id, token, sent_at) VALUES (?,?,?) ON CONFLICT DO NOTHING");
  for (const s of scoreRecent(db, model, WINDOW_HOURS, 200, "score", min / 100).items) {
    mark.run(chatId, s.token, now);
  }
}

/* ── the token, and what holding it opens ──────────────────────────────────── */

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * The balance behind a tier, read from the chain rather than remembered.
 *
 * A failed read returns null and changes nothing. The alternative, treating an unreachable endpoint
 * as a zero balance, would take the paid half away from every holder the moment the RPC had a bad
 * minute, and then make them wait out a week-long cooldown for the privilege.
 */
async function balanceOf(address: string): Promise<bigint | null> {
  if (!CFG.coinToken) return null;
  try {
    return await withRetry(() => stateClient.readContract({
      address: CFG.coinToken as `0x${string}`,
      abi: erc20,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    })) as bigint;
  } catch {
    return null;
  }
}

/** Re-reads one chat's balance and folds it into the tier. Returns the tier now in force. */
async function refreshTier(chatId: number): Promise<Tier> {
  const link = linkOf(db, chatId);
  if (!link) return tiersConfigured() ? 0 : 2;
  const bal = await balanceOf(link.address);
  if (bal === null) return tierOf(db, chatId);
  applyBalance(db, chatId, bal, Math.floor(Date.now() / 1000));
  return tierOf(db, chatId);
}

/* ── commands ──────────────────────────────────────────────────────────── */

async function handle(chatId: number, text: string): Promise<void> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const name = cmd.toLowerCase().split("@")[0];

  switch (name) {
    case "/start":
      subscribe(chatId, DEFAULT_MIN);
      // One line, because Telegram caps a photo's caption at 1024 characters and HELP is 1,184.
      // The rest follows as its own message rather than being cut to fit.
      await sendBanner(chatId, "<b>Augur</b> · every pons v2 launch, scored the second it lands.");
      await send(chatId, `${HELP}\n\nAlerts are on at <b>${DEFAULT_MIN}%</b>. Change it with /watch.`);
      return;
    case "/help":
      subscribe(chatId, DEFAULT_MIN);
      await send(chatId, `${HELP}\n\nAlerts are on at <b>${DEFAULT_MIN}%</b>. Change it with /watch.`);
      return;
    case "/watch": {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n < 0 || n > 99) {
        await send(chatId, "give a number between 0 and 99, e.g. <code>/watch 8</code>");
        return;
      }
      subscribe(chatId, n);
      const tier = tierOf(db, chatId);
      const floor = gateFor(tier).minScorePct;
      // The setting is kept as asked even when the floor overrides it, so it starts working by
      // itself the day the balance arrives rather than needing to be set a second time.
      await send(chatId, n < floor
        ? `saved <b>${n}%</b>, but free alerts stop at <b>${floor}%</b> and arrive `
          + `${gateFor(tier).delaySec}s after the score is written. Holding $AUGUR lifts both: /link`
        : `alerting at <b>${n}%</b> and above.`);
      return;
    }

    /**
     * Proving a wallet.
     *
     * The button first, because pasting a signature by hand is not something to ask of anybody: no
     * wallet has a window for signing arbitrary text, so the honest version of "sign this" is a page
     * that asks the wallet for you. The typed path stays for readers who would rather not connect a
     * wallet to a website at all, and it is the same protocol either way.
     *
     * Nothing here takes a key or a seed; there is no command that could, which is the only way that
     * promise is worth making.
     */
    case "/link": {
      const now = Math.floor(Date.now() / 1000);
      const a = (rest[0] ?? "").trim().toLowerCase();

      if (a && !/^0x[0-9a-f]{40}$/.test(a)) {
        await send(chatId, "that does not look like an address. Send <code>/link</code> on its own "
          + "to do it in the browser, or <code>/link 0x…</code> to do it by hand.");
        return;
      }

      if (!a) {
        const { token } = challenge(db, chatId, now);
        await send(chatId,
          "Open this and press <b>connect</b>, then <b>sign</b>. It costs no gas, moves nothing and "
          + "hands over no key: a signature over a sentence is not a transaction.\n\n"
          + `${CFG.siteUrl}/link?t=${token}\n\n`
          + `The link works for ${Math.floor(CHALLENGE_TTL_SEC / 60)} minutes and only for this chat. `
          + "I will say so here when it is done.\n\n"
          + "<i>Would rather not connect a wallet to a page? <code>/link 0x…</code> gives you the "
          + "sentence to sign wherever you like.</i>",
          [{ text: "Prove a wallet", url: `${CFG.siteUrl}/link?t=${token}` }]);
        return;
      }

      const { sentence } = challenge(db, chatId, now, a);
      await send(chatId,
        "Sign this exact text with that wallet. It moves nothing, approves nothing and costs no gas.\n\n"
        + `<pre>${(sentence ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>\n`
        + "Then send me <code>/verify 0x…</code> with the signature. "
        + `It stops working in ${Math.floor(CHALLENGE_TTL_SEC / 60)} minutes.`);
      return;
    }

    case "/verify": {
      const res = await verifyLink(db, chatId, rest[0] ?? "", Math.floor(Date.now() / 1000));
      if (!res.ok) {
        const why = {
          "no-challenge": "nothing to verify. Start with <code>/link</code>.",
          "no-wallet": "no wallet named yet. Open the link from <code>/link</code>, or use <code>/link 0x…</code>.",
          "expired": "that sentence has expired. Send <code>/link 0x…</code> for a fresh one.",
          "bad-signature": "that does not look like a signature. It is a long <code>0x…</code> string, 132 characters.",
          "wrong-wallet": "that signature is from a different wallet than the one you named.",
          "taken": "that wallet is already linked to another chat. Unlink it there first.",
        }[res.reason];
        await send(chatId, why);
        return;
      }
      await refreshTier(chatId);
      markAnnounced(db, chatId, Math.floor(Date.now() / 1000));
      await send(chatId, `linked <code>${res.address}</code>.\n\n${tierText(db, chatId)}`);
      return;
    }

    case "/unlink":
      await send(chatId, unlink(db, chatId)
        ? "wallet forgotten, along with the tier and any API key it had. /link starts again."
        : "no wallet is linked to this chat.");
      return;

    case "/key": {
      if (!linkOf(db, chatId)) {
        await send(chatId, "an API key belongs to a proved wallet. Start with <code>/link 0x…</code>.");
        return;
      }
      if (tierOf(db, chatId) < 1) {
        await send(chatId, `the wallet is linked but not holding. ${tierText(db, chatId)}`);
        return;
      }
      const key = issueKey(db, chatId, Math.floor(Date.now() / 1000));
      await send(chatId,
        `<code>${key}</code>\n\nSend it as <code>x-api-key</code> or <code>?key=</code>. `
        + "It replaces any key you had. Anyone holding it spends your limit, so treat it as a password; "
        + "/key again if it leaks, /unlink to revoke it entirely.");
      return;
    }
    case "/stop":
      db.prepare("DELETE FROM tg_subs WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM tg_sent WHERE chat_id = ?").run(chatId);
      await send(chatId, "stopped, and your record here is deleted. /start begins again.");
      return;
    case "/status":
      await send(chatId, `${statusText(db)}\n\n${tierText(db, chatId)}`);
      return;
    case "/top":
      await send(chatId, topText(db, WINDOW_HOURS));
      return;
    case "/token":
      if (!rest[0]) {
        await send(chatId, "give an address, e.g. <code>/token 0x…</code>");
        return;
      }
      // Buttons only once the address is one we recognise; a reply that says "not in the database"
      // has nothing to link to.
      {
        const t = rest[0].trim().toLowerCase();
        const known = /^0x[0-9a-f]{40}$/.test(t)
          && db.prepare("SELECT 1 x FROM launches WHERE token = ?").get(t) !== undefined;
        await send(chatId, tokenText(db, rest[0]), known ? linksFor(t) : undefined);
      }
      return;
    default:
      if (name.startsWith("/")) await send(chatId, HELP);
  }
}

/* ── the two loops ──────────────────────────────────────────────────────────── */

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
};

async function pollCommands(): Promise<void> {
  let offset = 0;
  for (;;) {
    const ups = await tg<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (!ups) { await sleep(3000); continue; }
    for (const u of ups) {
      offset = u.update_id + 1;
      const chat = u.message?.chat?.id;
      const text = u.message?.text;
      if (chat !== undefined && text) {
        try { await handle(chat, text); } catch { /* one bad command must not end the loop */ }
      }
    }
  }
}

const already = db.prepare("SELECT 1 x FROM tg_sent WHERE chat_id = ? AND token = ?");
const mark = db.prepare("INSERT INTO tg_sent (chat_id, token, sent_at) VALUES (?,?,?) ON CONFLICT DO NOTHING");
const metaOf = db.prepare("SELECT symbol, name, deployer FROM launches WHERE token = ?");

/**
 * Sends one chat the launches it has not been told about yet. Shared by both passes.
 *
 * The tier is passed in rather than read here because both passes already know it, and reading it
 * per launch would put a database round trip inside the send loop for a number that cannot change
 * between two messages a second apart.
 *
 * A launch held back for being too fresh is not marked as sent, so the next pass picks it up. That
 * is the difference between a delayed alert and a dropped one.
 */
async function deliver(chatId: number, items: Scored[], tier: Tier): Promise<number> {
  let sent = 0;
  const now = Math.floor(Date.now() / 1000);
  const floor = gateFor(tier).minScorePct / 100;
  for (const s of items) {
    if (already.get(chatId, s.token)) continue;
    if (s.probability < floor) continue;
    if (!ripeFor(db, s.token, tier, now)) continue;
    const m = metaOf.get(s.token) as LaunchMeta | undefined;
    if (!m) continue;
    // Marked before sending, not after: a message that fails is better skipped than repeated on
    // every pass, and Telegram gives no way to know a timeout did not arrive.
    mark.run(chatId, s.token, Math.floor(Date.now() / 1000));
    if (await send(chatId, alertText(db, s, m), linksFor(s.token))) sent++;
    // Telegram allows about one message a second to a single chat.
    await sleep(1100);
  }
  db.prepare("UPDATE tg_subs SET last_at = ? WHERE chat_id = ?").run(Math.floor(Date.now() / 1000), chatId);
  return sent;
}

const subsOf = (): Array<{ chat_id: number; min_score: number }> =>
  db.prepare("SELECT chat_id, min_score FROM tg_subs").all() as Array<{ chat_id: number; min_score: number }>;

/** The fast path: everything the watcher has claimed inside the window, per subscriber threshold. */
async function claimsPass(): Promise<number> {
  const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;
  let sent = 0;
  for (const sub of subsOf()) {
    const tier = tierOf(db, sub.chat_id);
    const min = effectiveMin(sub.min_score, tier);
    sent += await deliver(sub.chat_id, claimsFor(db, min / 100, since), tier);
  }
  return sent;
}

/**
 * The floor: the same scored page the board serves, on the old interval.
 *
 * Kept beside the fast path rather than replaced by it, because the two see different things. A
 * claim is written once, at first sight, and never revised; the board re-scores, so a launch whose
 * standing changes, or one a subscriber has only just lowered their threshold past, is picked up
 * here. `tg_sent` dedupes across both, so the fast path can only ever make an alert earlier, never
 * duplicate or miss one.
 */
async function alertPass(): Promise<number> {
  const model = loadModel();
  if (!model) return 0;
  let sent = 0;
  for (const sub of subsOf()) {
    const tier = tierOf(db, sub.chat_id);
    const page = scoreRecent(db, model, WINDOW_HOURS, 25, "score", effectiveMin(sub.min_score, tier) / 100);
    sent += await deliver(sub.chat_id, page.items, tier);
  }
  return sent;
}

/* ── run ────────────────────────────────────────────────────────────────────── */

const me = await tg<{ username: string }>("getMe");
if (!me) {
  console.error("Telegram refused the token. Check TELEGRAM_BOT_TOKEN in .env.");
  process.exit(1);
}
/**
 * The list Telegram offers when someone types "/".
 *
 * Registering it is the difference between commands that have to be read about first and commands
 * that announce themselves, with what they do beside them, at the moment a reader is looking for
 * one. Re-sent on every start so a changed description does not need remembering.
 */
await tg("setMyCommands", {
  commands: [
    { command: "watch", description: "only alert me at or above n%, e.g. /watch 8" },
    { command: "top", description: "strongest launches on the board right now" },
    { command: "token", description: "everything known about one launch: /token 0x…" },
    { command: "status", description: "is the watcher keeping up, how old is the model, what is my tier" },
    { command: "link", description: "prove a wallet — no gas, no key, nothing moved" },
    { command: "verify", description: "finish /link with the signature: /verify 0x…" },
    { command: "unlink", description: "forget the wallet, the tier and the API key" },
    { command: "key", description: "an API key for the board, once a linked wallet is holding" },
    { command: "help", description: "what the numbers mean" },
    { command: "stop", description: "no more alerts, and delete my record" },
  ],
});

console.log(`augur telegram — @${me.username}`);
console.log(`  default threshold ${DEFAULT_MIN}%, window ${WINDOW_HOURS}h`);
console.log(`  alerting on each claim as the watcher writes it, with a full pass every ${INTERVAL_SEC}s`);
console.log(`  ${(db.prepare("SELECT count(*) c FROM tg_subs").get() as { c: number }).c} chat(s) subscribed`);
console.log(`  send /start to @${me.username} to subscribe this machine's alerts to a chat\n`);

if (ONCE) {
  console.log(`sent ${await claimsPass() + await alertPass()} alert(s)`);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => { db.close(); process.exit(0); });

void pollCommands();

/**
 * Says so in the chat when a wallet was proved on the website.
 *
 * The page can prove a wallet but has no way to speak here, so this is the half that does. Run on
 * the fast tick rather than with the hourly sweep: somebody who just pressed sign is still looking
 * at their screen, and a confirmation that lands an hour later is not a confirmation.
 */
async function announceLinks(): Promise<void> {
  for (const link of unannouncedLinks(db)) {
    const now = Math.floor(Date.now() / 1000);
    // Marked before sending, like the alerts are: a message that fails is better skipped than
    // repeated on every tick from here to the end of the process.
    markAnnounced(db, link.chat_id, now);
    await refreshTier(link.chat_id);
    await send(link.chat_id, `linked <code>${link.address}</code>.\n\n${tierText(db, link.chat_id)}`);
  }
}

/**
 * Re-reads every linked wallet on a timer.
 *
 * On its own clock rather than inside the alert loop: a balance moves in hours and an alert moves in
 * seconds, and one RPC read per holder per hour must never be able to delay the thing this bot
 * exists for. Failures are skipped rather than counted as a sell, so an endpoint having a bad minute
 * cannot cost a whole cohort their tier and start them all on a week-long cooldown.
 */
async function tierSweep(): Promise<void> {
  const rows = db.prepare("SELECT chat_id FROM wallet_links").all() as Array<{ chat_id: number }>;
  let changed = 0;
  for (const r of rows) {
    const before = tierOf(db, r.chat_id);
    const after = await refreshTier(r.chat_id);
    if (before === after) continue;
    changed++;
    // Told, not silently demoted: a reader whose alerts just got slower should know why.
    await send(r.chat_id, after > before
      ? `tier ${after} is live.\n\n${tierText(db, r.chat_id)}`
      : `tier is now ${after === 0 ? "free" : after}.\n\n${tierText(db, r.chat_id)}`);
  }
  if (changed) console.log(`${new Date().toISOString().slice(11, 19)}  ${changed} tier change(s)`);
}

/** One tick between checking whether the watcher has written anything. */
const TICK_MS = 1000;
/**
 * The sentinel, chosen for being free: `count(*)` here costs 0.01ms because SQLite answers it from
 * the table header, against 7ms for `max(scored_at)`, which has no index and scans. Rows in this
 * table are only ever inserted, so the count rising means the watcher has scored a launch, and
 * nothing else does that.
 */
const claimCount = (): number =>
  (db.prepare("SELECT count(*) c FROM predictions").get() as { c: number }).c;

let seen = claimCount();
let lastFull = 0;
let lastSweep = 0;
for (;;) {
  try {
    await announceLinks();
    if (Date.now() - lastSweep >= CFG.tierRecheckSec * 1000) {
      lastSweep = Date.now();
      await tierSweep();
    }
    const n = claimCount();
    if (n !== seen) {
      seen = n;
      const sent = await claimsPass();
      if (sent) console.log(`${new Date().toISOString().slice(11, 19)}  sent ${sent} alert(s)`);
    }
    if (Date.now() - lastFull >= INTERVAL_SEC * 1000) {
      lastFull = Date.now();
      const sent = await alertPass();
      if (sent) console.log(`${new Date().toISOString().slice(11, 19)}  sent ${sent} alert(s) on the full pass`);
    }
  } catch (e) {
    console.error(`alert pass failed: ${(e as Error).message}`);
  }
  await sleep(TICK_MS);
}
