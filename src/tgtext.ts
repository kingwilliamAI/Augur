import { buildCard } from "./card.ts";
import { CFG, EXPLORER } from "./config.ts";
import { getMeta, type DB } from "./db.ts";
import { curvePrices } from "./curve.ts";
import { baseGradRate, followsOf, walletRecord, type RecentLaunch, type WalletRecord } from "./follows.ts";
import { graduationCapUsd, graduationMultiple } from "./pool.ts";
import { formatUsd, marketCapUsd, startingCapUsd } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";
import { tracksOf, type Buyer } from "./tracks.ts";
import { traderEntries, traderRecord, type TraderRecord } from "./traders.ts";
import { loadModel, scoreOne, scoreRecent, type Scored } from "./score.ts";
import { modelId } from "./track.ts";
import { linkOf, pendingRestore, streakDays, tiersConfigured } from "./tiers.ts";

/**
 * What the bot says, kept apart from how it says it.
 *
 * Every function here is a pure read of the local database returning a string, which is the whole
 * reason they are not in the command loop: a message that misreads a card or crashes on a token with
 * no history is a bug you want to find without a bot token and without messaging anybody. The loop
 * owns the network; this owns the words.
 */

/** Telegram renders a small HTML subset; these three characters are what breaks it. */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * A duration at the coarsest unit that still says something.
 *
 * Days were added when the tier cooldown started printing "168.0h", which is a true statement of a
 * week that nobody reads as one. Anything past two days is written in days for the same reason the
 * rest of this reads in minutes and hours: the number is there to be understood at a glance.
 */
export const ago = (sec: number): string =>
  sec < 90 ? `${Math.round(sec)}s`
    : sec < 5400 ? `${Math.round(sec / 60)}m`
      : sec < 172_800 ? `${(sec / 3600).toFixed(1)}h`
        : `${(sec / 86400).toFixed(1)}d`;

export const HELP = [
  "<b>Augur</b> watches every launch on pons v2 and scores it on this machine.",
  "",
  "<b>What the numbers mean</b>",
  "The percentage is the chance a launch reaches the pool. Most never do: the base rate is about 2%, "
  + "so 8% is four times typical, not a promise.",
  "<i>peak market cap</i> is where the model thinks it tops out, against the roughly $4K a launch "
  + "opens at and the roughly $50K it takes to graduate. A + or a − next to a fact is the model "
  + "saying that fact pushed the score up or down.",
  "",
  "<b>Commands</b>",
  "/watch <i>n</i> — only alert me at or above n%. <code>/watch 15</code> is quiet, "
  + "<code>/watch 5</code> is busy. Setting it starts the clock: you get what launches next, not a "
  + "backlog.",
  "/top — the strongest launches on the board right now, whatever your threshold.",
  "/token <i>0x…</i> — everything known about one launch: both peaks, the creator's record, the tax.",
  "/follow <i>0x…</i> — a creator's address off any card. Their next launch reaches you the second it "
  + "lands, whatever it scores. /following lists them, /unfollow stops one.",
  "/track <i>0x…</i> — a launch you are holding. You get a message when a wallet with a record buys "
  + "into it: who, how much, at what cap. /tracking lists them, /untrack stops one.",
  "/trader <i>0x…</i> — what a wallet's record is, and what had to be thrown out to get it.",
  "/status — whether the watcher is still keeping up, how old the model is, what your tier is.",
  "/link <i>0x…</i> — prove a wallet by signing a sentence. No gas, no key, nothing moved.",
  "/verify <i>0x…</i> — the signature that finishes /link. /unlink forgets the wallet again.",
  "/key — an API key for the board, once a linked wallet is holding.",
  "/stop — no more alerts, and your record here is deleted.",
  "",
  "<b>What holding $AUGUR changes</b>",
  "Free alerts arrive a minute after the score is written and stop below a floor. A holder gets them "
  + "the second the score exists, at any threshold, plus an API key and history exports. Selling drops "
  + "the tier at once; buying back returns it a week later, so it cannot be borrowed for a minute.",
  "",
  "<i>This bot never asks for a key, a seed or an approval, holds no funds and signs nothing. "
  + "No command here takes a private key: anything claiming to be this bot and asking for one is not.</i>",
].join("\n");

/**
 * Label and value in aligned columns.
 *
 * Telegram renders `pre` in a monospace face, which is the only way to get a column out of a chat
 * message. It earns its keep: a reader comparing two alerts is comparing numbers in the same place
 * on the screen rather than reading two paragraphs and holding both in their head.
 */
export type Row = [label: string, value: string, mark?: "up" | "down"];

function table(rows: Row[]): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  // A sign gutter only when something in this table has a sign, so tables without one keep their
  // left edge flush instead of sitting two spaces in for no reason.
  const gutter = rows.some((r) => r[2]);
  return `<pre>${rows.map(([k, v, mark]) => {
    const g = !gutter ? "" : mark === "up" ? "+ " : mark === "down" ? "− " : "  ";
    return esc(`${g}${k.padEnd(w)}  ${v}`);
  }).join("\n")}</pre>`;
}

/**
 * The forecast, written so it can be read without knowing how the model works.
 *
 * A range on its own says nothing. "$21K to $32.1K" only means something once the reader knows a
 * launch opens near $4.4K and that graduating takes about $51.9K, at which point the same three
 * numbers say something plain. Both anchors are measured from this database rather than asserted,
 * and both are taken per quote asset: the global median graduation cap is $41K, but an ETH-quoted
 * launch graduates at $51.9K and a TTWO-quoted one at $28.0K, and being roughly right about the
 * anchor is what makes a reader stop trusting the exact numbers standing next to it.
 *
 * Where the quote asset has no dollar price the same forecast is given as a multiple, with a
 * price-free anchor: graduation sits at a median of x10.9 of the opening price across 174 graduated
 * tokens. That is a protocol constant, not a market one.
 *
 * The band carries the share of unseen launches it actually caught, not the share it was built for.
 * Those differ right now, and a range printed bare would claim a confidence the model has not earned.
 */
function forecastRows(db: DB, card: NonNullable<ReturnType<typeof buildCard>>): string {
  const a = card.ath;
  if (!a.available || a.multiple === null) return "";

  const L = card.launch;
  const dollars = a.pointUsd !== null && a.loUsd !== null && a.hiUsd !== null;
  const times = (v: number | null): string => (v === null ? "—" : `×${v < 10 ? v.toFixed(1) : Math.round(v)}`);

  const point = dollars ? (a.pointUsd as string) : `${times(a.multiple)} of the open`;
  const lo = dollars ? (a.loUsd as string) : times(a.loMultiple);
  const hi = dollars ? (a.hiUsd as string) : times(a.hiMultiple);

  const rows: Row[] = [
    ["expected", `~${point}`],
    ["range", `${lo} – ${hi}${a.coverage !== null ? `   right ${(100 * a.coverage).toFixed(0)}% of the time` : ""}`],
  ];
  if (a.tailChance !== null) {
    rows.push(["×10 or more", `${(100 * a.tailChance).toFixed(0)}%`
      + (a.tailBase !== null && a.tailBase > 0 ? `   typical ${(100 * a.tailBase).toFixed(0)}%` : "")]);
  }

  if (dollars) {
    const opens = startingCapUsd(db, L.quoteSymbol, L.quoteDecimals);
    const grad = graduationCapUsd(
      db, (pt) => quoteFromCache(db, pt).decimals, (pt) => quoteFromCache(db, pt).symbol, L.quoteSymbol,
    );
    if (opens !== null) rows.push(["opens at", formatUsd(opens)]);
    if (grad !== null) rows.push(["graduates at", formatUsd(grad)]);
  } else {
    const gm = graduationMultiple(db);
    if (gm !== null) rows.push(["graduates at", `${times(gm)} of the open`]);
  }

  const note = dollars ? "" : `\n<i>no dollar price for ${esc(L.quoteSymbol)}, so these are multiples</i>`;
  return `<b>peak market cap</b>\n${table(rows)}${note}`;
}

export type LaunchMeta = { symbol: string | null; name: string | null; deployer: string };

/**
 * One launch, as an alert.
 *
 * Built from the full card rather than the score alone. An alert that says only "31.1%" makes the
 * reader open something else to decide anything, which defeats the point of pushing it: the numbers
 * that answer "is this worth a look" are the forecast peak, what the creator has done before, and
 * whether they put their own money in. Those are all a card read, and a card is a local query.
 *
 * Laid out in blocks with blank lines between, because these arrive in a stream. A wall of labelled
 * values is unreadable at the third one; four short stanzas can be skimmed.
 */
export function alertText(db: DB, s: Scored, m: LaunchMeta, now = Math.floor(Date.now() / 1000)): string {
  const pct = (s.probability * 100).toFixed(1);
  const card = buildCard(db, s.token);
  const out: string[] = [];

  out.push(
    `<b>${esc(m.symbol ?? short(s.token))}</b>   <b>${pct}%</b> to reach the pool`,
    `<i>#${s.rank} of ${s.of.toLocaleString()} · ${ago(now - s.ts)} old${card ? ` · ${esc(card.launch.quoteSymbol)}` : ""}</i>`,
  );

  // A forecast only while the answer is still open; printing one beside a known outcome reads as the
  // tool arguing with itself. A launch can graduate inside the alert window, though, and one that
  // did is the most interesting thing on the board, so it gets the fact instead of the guess.
  if (card && !card.outcome.graduated) {
    const f = forecastRows(db, card);
    if (f) out.push("", f);
  } else if (card?.outcome.graduated) {
    const p = card.pool;
    const took = card.outcome.secondsToGraduate;
    out.push("", `<b>reached the pool</b>${took !== null ? ` after ${ago(took)}` : ""}`
      + (p?.tracked && p.peakUsd ? `\npeak ${esc(p.peakUsd)}${p.lastUsd ? ` · ${esc(p.lastUsd)} now` : ""}` : ""));
  }

  if (card) {
    const H = card.creatorHistory;
    const L = card.launch;
    const rows: Row[] = [];

    rows.push(["creator", H.priorLaunches === 0
      ? "first launch"
      : `${H.priorLaunches} before, ${H.priorGraduations} graduated`]);
    if (H.bestPeak) {
      rows.push(["their best", `${H.bestPeak.usd ?? `×${H.bestPeak.multiple.toFixed(1)}`}${H.bestPeak.symbol ? ` (${H.bestPeak.symbol})` : ""}`]);
    }
    if (L.selfBuy) rows.push(["self-buy", `${L.selfBuy} ${L.quoteSymbol}`]);
    if (L.creatorTaxBps !== null) rows.push(["tax", `${(L.creatorTaxBps / 100).toFixed(2)}%`]);
    if (card.exemptions.length) rows.push(["tax-exempt", `${card.exemptions.length} wallet${card.exemptions.length === 1 ? "" : "s"}`]);
    if (card.trading.indexed && card.trading.buyersFirstMinute) {
      rows.push(["first minute", `${card.trading.buyersFirstMinute} buyer${card.trading.buyersFirstMinute === 1 ? "" : "s"}`]);
    }
    // A ticker dozens of launches share is the loudest signal on a fresh launch, so it gets a row of
    // its own rather than being left to the reasons.
    if (card.cluster.total > 1) {
      rows.push(["ticker", `${card.cluster.total} launches, ${card.cluster.graduated} graduated`]);
    }

    /**
     * Reasons, minus whatever the table already said.
     *
     * The two overlapped badly: a launch with a 2% tax and three exempt wallets printed both facts
     * in the table and then again as "+ tax 2.00%" and "+ 3 tax-exempt", so a third of the message
     * was a second copy of another third. What a reason adds over a fact is the direction, so the
     * ones that survive are those naming something the table does not carry.
     */
    const covered: Record<string, string> = {
      creator_tax_bps: "tax",
      exempt_count: "tax-exempt",
      exempt_is_zero: "tax-exempt",
      log_initial_buy: "self-buy",
      initial_buy_is_zero: "self-buy",
      dev_prior_launches: "creator",
      dev_prior_graduations: "creator",
      dev_prior_grad_rate: "creator",
      dev_is_first_launch: "creator",
    };
    // A reason naming a fact already in the table marks that row rather than repeating it. What a
    // reason adds over a fact is its direction, and a value with a sign beside it carries both on
    // one line; printing "tax 3.00%" and then "+ tax 3.00%" spent a third of the message twice.
    const mark = new Map<string, "up" | "down">();
    const spare: string[] = [];
    for (const r of s.reasons) {
      const label = covered[r.feature as string];
      if (label && rows.some(([k]) => k === label)) mark.set(label, r.direction);
      else spare.push(`${r.direction === "up" ? "+" : "−"} ${esc(r.short)}`);
    }
    for (const row of rows) {
      const d = mark.get(row[0]);
      if (d) row[2] = d;
    }

    out.push("", table(rows));
    if (spare.length) out.push("", spare.slice(0, 3).join("\n"));
  }

  // The links live on buttons under the message, so the text ends at the address.
  out.push("", `<code>${s.token}</code>`);
  return out.join("\n");
}

export function statusText(db: DB, now = Math.floor(Date.now() / 1000)): string {
  const seen = Number(getMeta(db, "live_seen_at") ?? 0);
  const head = Number(getMeta(db, "live_head_block") ?? 0);
  const done = (db.prepare("SELECT coalesce(max(block),0) b FROM launches").get() as { b: number }).b;
  const total = (db.prepare("SELECT count(*) c FROM launches").get() as { c: number }).c;

  return [
    `<b>watcher</b> ${seen ? `last spoke ${ago(now - seen)} ago` : "never reported in"}`,
    `<b>behind</b> ${head && done ? `${Math.max(0, head - done).toLocaleString()} blocks` : "unknown"}`,
    `<b>launches</b> ${total.toLocaleString()} on record`,
    `<b>model</b> ${loadModel() ? modelId() : "none. Run: npm run train"}`,
  ].join("\n");
}

/**
 * What this chat's tier is, and what it would take to change it.
 *
 * Written to be readable by someone who has not decided whether to hold anything: it says what the
 * free bot does rather than only what it does not, because a reader who is being sold to deserves
 * to know what they already have.
 */
export function tierText(db: DB, chatId: number, now = Math.floor(Date.now() / 1000)): string {
  if (!tiersConfigured()) {
    return "<b>tier</b> everything is open: the thresholds are not set yet, so every reader gets the "
      + "instant alerts. When they are set they will be printed here and on the roadmap first.";
  }
  const link = linkOf(db, chatId);
  if (!link) {
    return [
      "<b>tier</b> free",
      `alerts arrive ${CFG.freeDelaySec}s after the score is written, at ${CFG.freeMinScore}% and above`,
      "<code>/link 0x…</code> proves a wallet and lifts both, no gas and no key",
    ].join("\n");
  }
  const lines = [
    `<b>tier</b> ${link.tier === 0 ? "free" : link.tier}`,
    `<b>wallet</b> <code>${short(link.address)}</code>`,
    `<b>balance</b> ${(Number(BigInt(link.balance) / (10n ** 15n)) / 1000).toLocaleString()} $AUGUR`
      + (link.checked_at ? `, read ${ago(now - link.checked_at)} ago` : ", not read yet"),
  ];
  const streak = streakDays(link, now);
  if (streak > 0) lines.push(`<b>streak</b> ${streak} day${streak === 1 ? "" : "s"} holding`);
  const pending = pendingRestore(link, now);
  if (pending) {
    lines.push(`<b>tier ${pending.tier}</b> comes back in ${ago(pending.atSec - now)}: `
      + "the balance is there, the week since the sell is not");
  } else if (link.tier === 0) {
    lines.push(`${CFG.tier1Tokens.toLocaleString()} $AUGUR opens instant alerts at any threshold`);
  } else if (link.tier === 1 && CFG.tier2Tokens > 0) {
    lines.push(`${CFG.tier2Tokens.toLocaleString()} $AUGUR takes the history export from 7 days to 30`);
  }
  return lines.join("\n");
}

export function topText(db: DB, windowHours: number, limit = 5): string {
  const model = loadModel();
  if (!model) return "no model yet. Run: npm run train";
  const page = scoreRecent(db, model, windowHours, limit, "score", 0);
  if (!page.items.length) return `nothing scored in the last ${windowHours}h`;

  const nameOf = db.prepare("SELECT symbol FROM launches WHERE token = ?");
  const lines = page.items.map((s) => {
    const m = nameOf.get(s.token) as { symbol: string | null } | undefined;
    return `<b>${(s.probability * 100).toFixed(1)}%</b>  ${esc(m?.symbol ?? short(s.token))}  <code>${short(s.token)}</code>`;
  });
  return [`Top ${lines.length} of ${page.total.toLocaleString()} in the last ${windowHours}h`, "", ...lines].join("\n");
}

/** One launch, in full, for a direct question. */
export function tokenText(db: DB, raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return "that does not look like a token address";
  const card = buildCard(db, t);
  if (!card) return "not in the database. It may predate the backfill, or not be a pons launch.";

  const model = loadModel();
  const s = model ? scoreOne(db, model, t) : null;
  const H = card.creatorHistory;

  const L = card.launch;
  const blocks: string[][] = [[
    `<b>${esc(card.symbol ?? short(t))}</b>${card.name && card.name !== card.symbol ? ` · ${esc(card.name)}` : ""}`,
    s ? `<b>${(s.probability * 100).toFixed(1)}%</b> to reach the pool · rank #${s.rank} of ${s.of.toLocaleString()}`
      : "not scored, it is outside the model's window",
    `${ago(Math.floor(Date.now() / 1000) - L.ts)} old · ${esc(L.quoteSymbol)} · ${card.outcome.graduated ? "reached the pool" : ["on the curve", "swept", "in the pool", "rescued"][card.outcome.phase] ?? "?"}`,
  ]];

  // What it has actually done, in two acts. The curve stops at the graduation bar by construction,
  // so for a graduated token the pool line is the one carrying information.
  const done = [`<b>peak on the curve</b> ${card.trading.peakUsd ?? "—"}`];
  if (card.pool) {
    const p = card.pool;
    done.push(`<b>peak in the pool</b> ${p.tracked ? (p.peakUsd ?? "—") : "still reading"}${p.lastUsd ? ` · ${p.lastUsd} now` : ""}`);
  }
  blocks.push(done);

  if (!card.outcome.graduated) {
    const f = forecastRows(db, card);
    if (f) blocks.push([f]);
  }

  const facts: string[] = [];
  if (L.selfBuy) facts.push(`self-buy ${esc(L.selfBuy)} ${esc(L.quoteSymbol)}`);
  if (L.creatorTaxBps !== null) facts.push(`tax ${(L.creatorTaxBps / 100).toFixed(2)}%`);
  if (card.exemptions.length) facts.push(`${card.exemptions.length} tax-exempt`);
  const detail: string[] = [];
  if (facts.length) detail.push(facts.join(" · "));
  if (card.trading.indexed) {
    detail.push(`${card.trading.buyersTotal} buyer${card.trading.buyersTotal === 1 ? "" : "s"} total, ${card.trading.buyersFirstMinute} in the first minute`);
  }
  if (card.cluster.total > 1) {
    detail.push(`ticker shared by ${card.cluster.total} launches, ${card.cluster.graduated} graduated`);
  }
  if (detail.length) blocks.push(detail);

  const who = [`<b>creator</b> ${H.priorLaunches} earlier launch${H.priorLaunches === 1 ? "" : "es"}, ${H.priorGraduations} graduated`];
  if (H.bestPeak) {
    who.push(`their best ever: ${H.bestPeak.usd ?? `×${H.bestPeak.multiple.toFixed(1)}`}${H.bestPeak.symbol ? ` (${esc(H.bestPeak.symbol)})` : ""}`);
  }
  for (const p of (H.topPeaks ?? []).slice(1, 3)) {
    who.push(`then ${p.usd ?? `×${p.multiple.toFixed(1)}`}${p.symbol ? ` (${esc(p.symbol)})` : ""}`);
  }
  blocks.push(who);

  blocks.push([`<code>${t}</code>`]);
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

/* ── following a wallet ─────────────────────────────────────────────────────── */

/**
 * A wallet's record, as the rows both the alert and the list print.
 *
 * The base rate stands beside the wallet's own rate rather than being left to the reader, because
 * without it the number is unreadable: two graduations in thirty-one launches sounds thin and is
 * three times typical. Where this machine has not read enough history to have a base rate, the
 * comparison is dropped rather than guessed.
 */
export function recordRows(db: DB, rec: WalletRecord, now = Math.floor(Date.now() / 1000)): Row[] {
  const base = baseGradRate(db, now);
  const rows: Row[] = [["launches", rec.launches.toLocaleString()]];
  if (rec.launches > 0) {
    const pct = `${(100 * (rec.gradRate ?? 0)).toFixed(1)}%`;
    const against = base ? `, typical ${(100 * base).toFixed(1)}%` : "";
    rows.push(["graduated", `${rec.graduations}   ${pct}${against}`]);
  }
  if (rec.best) {
    rows.push(["their best", `${rec.best.usd ?? `×${rec.best.multiple.toFixed(1)}`}`
      + `${rec.best.symbol ? ` (${rec.best.symbol})` : ""}`]);
  }
  if (rec.lastTs) rows.push(["last launch", `${ago(now - rec.lastTs)} ago`]);
  return rows;
}

/**
 * One followed wallet's launch, the moment it lands.
 *
 * Written to answer a different question than a scored alert does. There the question is "is this
 * worth a look", and the score leads. Here the reader has already decided that this wallet is worth
 * a look, so what leads is which wallet it was and what that wallet has done before — and the score,
 * when there is one yet, comes after as a second opinion rather than as the point.
 *
 * There may be no score at all. The claim is written a few seconds after the launch and this fires
 * as soon as the launch is seen, which is the whole promise of the feature, so the message has to
 * read properly without one.
 */
export function followAlert(db: DB, row: RecentLaunch, who: string, now = Math.floor(Date.now() / 1000)): string {
  const card = buildCard(db, row.token);
  const out: string[] = [];
  const sym = row.symbol ?? card?.symbol ?? null;

  out.push(
    `<b>${esc(sym ?? short(row.token))}</b>   <i>a wallet you follow just launched</i>`,
    `<i>${ago(Math.max(0, now - row.ts))} old${card ? ` · ${esc(card.launch.quoteSymbol)}` : ""}`
    + `${row.name && row.name !== sym ? ` · ${esc(row.name)}` : ""}</i>`,
  );

  const claim = db.prepare("SELECT probability, rank, of FROM predictions WHERE token = ?")
    .get(row.token) as { probability: number; rank: number; of: number } | undefined;
  out.push("", claim
    ? `<b>${(100 * claim.probability).toFixed(1)}%</b> to reach the pool · #${claim.rank} of ${claim.of.toLocaleString()}`
    : "<i>not scored yet: this went out on the wallet, not on the number</i>");

  out.push("", `<b>the wallet</b> <code>${short(who)}</code>`,
    table(recordRows(db, walletRecord(db, who, row.token), now)));

  if (card) {
    const L = card.launch;
    const facts: string[] = [];
    if (L.selfBuy) facts.push(`self-buy ${esc(L.selfBuy)} ${esc(L.quoteSymbol)}`);
    if (L.creatorTaxBps !== null) facts.push(`tax ${(L.creatorTaxBps / 100).toFixed(2)}%`);
    if (card.exemptions.length) facts.push(`${card.exemptions.length} tax-exempt`);
    if (facts.length) out.push(facts.join(" · "));
  }

  out.push("", `<code>${row.token}</code>`);
  return out.join("\n");
}

/** The reply to /follow: what was added, and what that wallet has done. */
export function followedText(db: DB, address: string, count: number, cap: number, now = Math.floor(Date.now() / 1000)): string {
  const rec = walletRecord(db, address);
  const head = rec.launches === 0
    ? "following <code>" + short(address) + "</code>. Nothing launched from it has been read here yet, "
      + "so this is a bet on what it does next rather than on what it has done."
    : `following <code>${short(address)}</code>.`;
  const lines = [head];
  if (rec.launches > 0) lines.push("", table(recordRows(db, rec, now)));
  if (rec.unread > 0) {
    lines.push(rec.best
      ? `<i>${rec.unread} of their curves have not been read on this machine, so the best above is a `
        + "floor rather than their record.</i>"
      : `<i>None of their ${rec.unread} curves has been read here yet, so there is no peak to show. `
        + "Opening one of their launches on the board reads it.</i>");
  }
  lines.push("", `${count} of ${cap} wallets followed. Their next launch reaches you the second it lands, `
    + "whatever it scores. /unfollow stops it.");
  return lines.join("\n");
}

/** The list, with each wallet's record beside it. */
export function followingText(db: DB, chatId: number, cap: number, now = Math.floor(Date.now() / 1000)): string {
  const rows = followsOf(db, chatId);
  if (!rows.length) {
    return "not following anybody yet.\n\n<code>/follow 0x…</code> takes the creator address off any "
      + "card and tells you the second that wallet launches again, whatever the launch scores.";
  }
  const blocks = rows.map((f) => {
    const rec = walletRecord(db, f.address);
    const grad = rec.launches === 0 ? "nothing read yet"
      : `${rec.launches} launch${rec.launches === 1 ? "" : "es"}, ${rec.graduations} graduated`;
    const best = rec.best ? ` · best ${rec.best.usd ?? `×${rec.best.multiple.toFixed(1)}`}` : "";
    return `<code>${f.address}</code>\n${grad}${best}`;
  });
  return [`<b>following ${rows.length} of ${cap}</b>`, ...blocks].join("\n\n");
}

/* ── watching a launch for arrivals ──────────────────────────────────────────── */

/** Whole quote units from raw ones, at the precision the number deserves. */
const amount = (raw: number, decimals: number): string => {
  const v = raw / 10 ** decimals;
  return v >= 100 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, "");
};

/** Market cap at a raw curve price, or a multiple of the open where the quote has no dollar price. */
function capAt(db: DB, token: string, px: number, quoteSymbol: string, quoteDecimals: number): string {
  const usd = marketCapUsd(px * (1e18 / 10 ** quoteDecimals), quoteSymbol);
  if (usd !== null) return formatUsd(usd);
  const p = curvePrices(db, token);
  return p && p.first > 0 ? `×${(px / p.first).toFixed(1)} of the open` : "—";
}

/**
 * The rule, in the words that go under every record.
 *
 * Printed with the number rather than kept in a document, because the number is only worth anything
 * to a reader who can see what was thrown out to get it. Somebody who knows that entries on your own
 * launches do not count can go and check that they do not.
 */
export const TRADER_RULE =
  "<i>A record counts a wallet's first buy on each curve read here, minus three kinds of entry that "
  + "can be arranged: launches they created, launches that waived the opening tax for them, and ones "
  + "where they were more than half the buy volume. Ten of those across five creators is the bar, and "
  + "the rate is the lower end of a 95% interval, so a lucky handful does not outrank a long record.</i>";

/**
 * Somebody with a record buying into a launch a reader is holding.
 *
 * Three facts lead, in the order a holder asks for them: who, how much, and at what price relative
 * to where the launch is now. The record follows, because it is the reason the message was sent at
 * all, and the rule follows that, because a record without its rule is a number to be trusted rather
 * than checked.
 */
export function traderAlert(db: DB, token: string, buyer: Buyer, rec: TraderRecord): string {
  const l = db.prepare("SELECT symbol, pair_token FROM launches WHERE token = ?").get(token) as
    { symbol: string | null; pair_token: string } | undefined;
  const q = quoteFromCache(db, l?.pair_token ?? "");
  const out: string[] = [];

  out.push(
    `<b>${esc(l?.symbol ?? short(token))}</b>   <i>a wallet with a record just bought in</i>`,
    "",
    `<b>${amount(buyer.quote, q.decimals)} ${esc(q.symbol)}</b> at `
    + `${esc(capAt(db, token, buyer.entryPrice, q.symbol, q.decimals))}`,
  );

  const rows: Row[] = [
    ["entries", `${rec.entries} clean, ${rec.creators} creator${rec.creators === 1 ? "" : "s"}`],
    ["graduated", `${rec.graduated}   ${((rec.rate ?? 0) * 100).toFixed(0)}%`
      + (rec.base !== null ? `, base ${(rec.base * 100).toFixed(1)}%` : "")],
  ];
  if (rec.lower !== null && rec.lift !== null) {
    rows.push(["at worst", `${(rec.lower * 100).toFixed(0)}%   ×${rec.lift.toFixed(1)} the base`]);
  }
  if (rec.medianMultiple !== null) rows.push(["median run", `×${rec.medianMultiple.toFixed(1)} to the curve high`]);
  out.push("", `<b>the wallet</b> <code>${short(buyer.address)}</code>`, table(rows));

  out.push("", TRADER_RULE, "", `<code>${buyer.address}</code>`);
  return out.join("\n");
}

/** One wallet's record in full, whether or not it clears the bar. */
export function traderText(db: DB, address: string): string {
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return "that does not look like a wallet address";
  const rec = traderRecord(db, a);
  if (rec.entries === 0 && rec.excluded.own + rec.excluded.exempt + rec.excluded.ownMarket === 0) {
    return `<code>${short(a)}</code> has not bought on any curve read on this machine.\n\n`
      + "Curves are read when somebody opens a card, so this is a statement about what has been "
      + "looked at here, not about the wallet.";
  }

  const rows: Row[] = [
    ["entries", `${rec.entries} clean, ${rec.creators} creator${rec.creators === 1 ? "" : "s"}`],
    ["graduated", `${rec.graduated}   ${((rec.rate ?? 0) * 100).toFixed(0)}%`
      + (rec.base !== null ? `, base ${(rec.base * 100).toFixed(1)}%` : "")],
  ];
  if (rec.lower !== null) {
    rows.push(["at worst", `${(rec.lower * 100).toFixed(0)}%`
      + (rec.lift !== null ? `   ×${rec.lift.toFixed(1)} the base` : "")]);
  }
  if (rec.medianMultiple !== null) rows.push(["median run", `×${rec.medianMultiple.toFixed(1)} to the curve high`]);
  const thrown = rec.excluded.own + rec.excluded.exempt + rec.excluded.ownMarket;
  if (thrown > 0) {
    rows.push(["not counted", `${thrown}: ${rec.excluded.own} their own, `
      + `${rec.excluded.exempt} tax-exempt, ${rec.excluded.ownMarket} their own volume`]);
  }

  const verdict = rec.qualifies
    ? "<b>clears the bar.</b> An alert goes out when this wallet buys a launch you are watching."
    : `<b>does not clear the bar</b>: ${esc(rec.short)}.`;

  const top = traderEntries(db, a, 3).map((e) => {
    const mult = e.peakPrice !== null && e.entryPrice > 0 ? `×${(e.peakPrice / e.entryPrice).toFixed(1)}` : "—";
    return `${esc(e.symbol ?? short(e.token))}  ${mult}${e.graduated ? "  reached the pool" : ""}`;
  });

  return [
    `<b>${short(a)}</b>`, table(rows), verdict,
    ...(top.length ? ["", "<b>their best entries</b>", top.join("\n")] : []),
    "", TRADER_RULE, "", `<code>${a}</code>`,
  ].join("\n");
}

/** The reply to /track. */
export function trackedText(db: DB, token: string, count: number, cap: number): string {
  const l = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(token.toLowerCase()) as
    { symbol: string | null } | undefined;
  return [
    `watching <b>${esc(l?.symbol ?? short(token))}</b> from this block on.`,
    "",
    "You get a message when a wallet with a record buys in: who, how much, and at what market cap. "
    + "Wallets that were already in before now are history, not news, so they are not counted.",
    "",
    `${count} of ${cap} launches watched. /untrack stops one.`,
  ].join("\n");
}

/** The list of watched launches, with how much of each curve has been read. */
export function trackingText(db: DB, chatId: number, cap: number): string {
  const rows = tracksOf(db, chatId);
  if (!rows.length) {
    return "not watching anything yet.\n\n<code>/track 0x…</code> takes a launch you are holding and "
      + "tells you when a wallet with a record buys into it. /trader 0x… is what a record means.";
  }
  const lines = rows.map((r) => {
    const l = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(r.token) as
      { symbol: string | null } | undefined;
    const told = (db.prepare("SELECT count(*) c FROM tg_trader_sent WHERE chat_id = ? AND token = ?")
      .get(chatId, r.token) as { c: number }).c;
    return `<code>${r.token}</code>\n${esc(l?.symbol ?? "?")} · ${told} named so far`;
  });
  return [`<b>watching ${rows.length} of ${cap}</b>`, ...lines].join("\n\n");
}
