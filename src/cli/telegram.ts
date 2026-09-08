import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLORER } from "../config.ts";
import { openDb, type DB } from "../db.ts";
import { loadModel, scoreRecent, type Scored } from "../score.ts";
import { claimsFor } from "../alerts.ts";
import { alertText, HELP, statusText, tokenText, topText, type LaunchMeta } from "../tgtext.ts";

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
      await send(chatId, `alerting at <b>${n}%</b> and above.`);
      return;
    }
    case "/stop":
      db.prepare("DELETE FROM tg_subs WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM tg_sent WHERE chat_id = ?").run(chatId);
      await send(chatId, "stopped, and your record here is deleted. /start begins again.");
      return;
    case "/status":
      await send(chatId, statusText(db));
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

/** Sends one chat the launches it has not been told about yet. Shared by both passes. */
async function deliver(chatId: number, items: Scored[]): Promise<number> {
  let sent = 0;
  for (const s of items) {
    if (already.get(chatId, s.token)) continue;
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
  for (const sub of subsOf()) sent += await deliver(sub.chat_id, claimsFor(db, sub.min_score / 100, since));
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
    const page = scoreRecent(db, model, WINDOW_HOURS, 25, "score", sub.min_score / 100);
    sent += await deliver(sub.chat_id, page.items);
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
    { command: "status", description: "is the watcher keeping up, how old is the model" },
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
for (;;) {
  try {
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
