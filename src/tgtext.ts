import { buildCard } from "./card.ts";
import { CFG, EXPLORER } from "./config.ts";
import { getMeta, type DB } from "./db.ts";
import { graduationCapUsd, graduationMultiple } from "./pool.ts";
import { formatUsd, startingCapUsd } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";
import { loadModel, scoreOne, scoreRecent, type Scored } from "./score.ts";
import { modelId } from "./track.ts";
import { creatorRecord, following, followLimit } from "./follow.ts";
import { rankedAtLaunch } from "./preview.ts";
import { recordOf, watchedBy, type TraderHit } from "./traders.ts";
import { linkOf, pendingRestore, streakDays, tierOf, tiersConfigured } from "./tiers.ts";

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

    // Where the money came from, when anybody was watching. Phrased so it cannot be read as a
    // signal: it is 2.7% of transfers that precede a launch, and those launches reach a pool
    // slightly less often than launches in general do.
    const O = card.origin;
    if (O) {
      rows.push(["funded", `${O.eth} ETH ${ago(O.secondsBefore)} before the launch`
        + (O.fresh === true ? ", into a wallet with no history" : "")]);
      if (O.fanIn) rows.push(["funded by", `${O.fanIn.funders} addresses, ${O.fanIn.eth} ETH in the hour before`]);
      else if (O.funderFedLaunchers > 0) {
        rows.push(["that funder", `has fed ${O.funderFedLaunchers} other wallet${O.funderFedLaunchers === 1 ? "" : "s"} that launched`]);
      }
    }
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

/**
 * The alert for a launch by somebody a chat asked to be told about.
 *
 * Deliberately not the score alert with a different header. A reader following a creator has already
 * decided this wallet is worth their attention, so what they need is what the wallet has done before,
 * not a percentage they could get from the board. The score goes in only when the watcher has
 * actually written one, and it is one line rather than the whole forecast.
 */
export function followText(
  db: DB, token: string, address: string, now = Math.floor(Date.now() / 1000),
): string {
  const meta = db.prepare("SELECT symbol, name, ts FROM launches WHERE token = ?")
    .get(token) as { symbol: string | null; name: string | null; ts: number } | undefined;
  // Excluding this launch: an alert that counts the token it is announcing is a mirror, not a record.
  const rec = creatorRecord(db, address, token);

  const out = [
    `<b>${esc(meta?.symbol ?? short(token))}</b>   just launched by a creator you follow`,
    `<code>${short(address)}</code>${meta ? ` · ${ago(Math.max(0, now - meta.ts))} ago` : ""}`,
  ];

  const rows: Row[] = [
    ["launched before", rec.launches === 0 ? "this is their first" : `${rec.launches.toLocaleString()}`],
    ["reached the pool", rec.launches === 0 ? "—" : rec.graduations === 0
      ? "none of them"
      : `${rec.graduations} of ${rec.launches}`],
  ];
  // The best peak is what a follow is really for: a creator with one launch and no history is a
  // different proposition from one whose last token did seven figures, and the number says which.
  if (rec.bestUsd !== null) {
    rows.push(["their best", `${formatUsd(rec.bestUsd)}${rec.bestSymbol ? ` · ${esc(rec.bestSymbol)}` : ""}`]);
  }

  const claim = db.prepare("SELECT probability, rank, of FROM predictions WHERE token = ?")
    .get(token) as { probability: number; rank: number; of: number } | undefined;
  if (claim) rows.push(["scored", `${(claim.probability * 100).toFixed(1)}% · #${claim.rank} of ${claim.of.toLocaleString()}`]);

  out.push("", table(rows));
  return out.join("\n");
}

/**
 * The alert a creator gets about their own launch.
 *
 * Where it ranked, rather than what it scores. A creator who just deployed knows what they built;
 * what they cannot see is the hour they landed in, and that is the whole content of this message.
 * The number comes from the claim the watcher wrote before any outcome existed, so what they are
 * told is what was recorded rather than a fresh opinion that may have drifted.
 */
export function ownLaunchText(db: DB, token: string, now = Math.floor(Date.now() / 1000)): string {
  const meta = db.prepare("SELECT symbol, ts FROM launches WHERE token = ?")
    .get(token) as { symbol: string | null; ts: number } | undefined;
  const r = rankedAtLaunch(db, token);

  const head = `<b>${esc(meta?.symbol ?? short(token))}</b>   your launch is live`;
  if (!r) {
    return [head, `<code>${short(token)}</code>`, "",
      "no score recorded yet. The watcher writes one within seconds of the block; /token will have it.",
    ].join("\n");
  }
  const rows: Row[] = [
    ["scored", `${(r.probability * 100).toFixed(1)}%`],
    ["ranked", `#${r.rank} of ${r.of.toLocaleString()} scored in the ${r.windowHours}h around it`],
    ["better than", `${r.betterThanPct.toFixed(0)}% of them`],
  ];
  return [head, `<code>${short(token)}</code> · ${ago(Math.max(0, now - (meta?.ts ?? now)))} ago`, "",
    table(rows), "",
    "<i>A rank is not a forecast of profit. The backtest in the repository says following the score does not pay.</i>",
  ].join("\n");
}

/** The list behind /following, and what it would take to add another. */
export function followingText(db: DB, chatId: number): string {
  const list = following(db, chatId);
  const limit = followLimit(tierOf(db, chatId));
  if (limit <= 0) {
    return "following a creator is part of the paid half. <code>/link</code> proves a wallet, and "
      + "holding opens it. Nothing else about the bot changes.";
  }
  if (!list.length) {
    return `not following anyone. <code>/follow 0x…</code> with a creator's address, and you hear `
      + `about their next launch seconds after the block. Room for ${limit === Infinity ? "as many as you like" : limit}.`;
  }
  const lines = list.map((a) => {
    const r = creatorRecord(db, a);
    const best = r.bestUsd !== null ? ` · best ${formatUsd(r.bestUsd)}` : "";
    return `<code>${short(a)}</code>  ${r.launches} launched, ${r.graduations} graduated${best}`;
  });
  const room = limit === Infinity ? "" : `\n\n${list.length} of ${limit} used.`;
  return [`Following ${list.length}:`, "", ...lines].join("\n") + room;
}

/**
 * A wallet with a record buying into something somebody is watching.
 *
 * Says what the record is made of rather than calling anybody good. Eight closed positions is not a
 * sample anybody should bet on, and the message carries the count so a reader can discount it. There
 * is no recommendation here and the last line says so, because a message like this is exactly the
 * kind that gets screenshotted without its caveats.
 */
export function traderText(db: DB, hit: TraderHit, now = Math.floor(Date.now() / 1000)): string {
  const meta = db.prepare("SELECT symbol FROM launches WHERE token = ?")
    .get(hit.token) as { symbol: string | null } | undefined;
  const r = hit.record;
  const rows: Row[] = [
    ["bought", `${hit.quote.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${esc(hit.quoteSymbol)}`],
    ["their record", `${r.closed} positions closed, ${(100 * r.winRate).toFixed(0)}% of them up`],
    ["realised", formatUsd(r.realisedUsd)],
    ["best single", `${r.bestMultiple.toFixed(1)}x`],
  ];
  return [
    `<b>${esc(meta?.symbol ?? short(hit.token))}</b>   a wallet with a record just bought in`,
    `<code>${short(hit.wallet)}</code> · ${ago(Math.max(0, now - hit.ts))} ago`,
    "",
    table(rows),
    "",
    "<i>A record is not a forecast. It counts only closed positions in tokens this wallet neither "
    + "created nor was waived the opening tax on, and it is still a small sample.</i>",
  ].join("\n");
}

/** The tokens a chat is watching, and what it would take to add one. */
export function holdingsText(db: DB, chatId: number): string {
  const list = watchedBy(db, chatId);
  if (!list.length) {
    return "not watching any tokens. <code>/hold 0x…</code> adds one, and you hear when a wallet with "
      + "a record buys into it.";
  }
  const nameOf = db.prepare("SELECT symbol FROM launches WHERE token = ?");
  const lines = list.map((t) => {
    const m = nameOf.get(t) as { symbol: string | null } | undefined;
    return `<code>${short(t)}</code>  ${esc(m?.symbol ?? "not indexed yet")}`;
  });
  return [`Watching ${list.length}:`, "", ...lines, "", "<code>/unhold 0x…</code> removes one."].join("\n");
}

/** One wallet's trading record, for /trader. */
export function traderRecordText(db: DB, wallet: string): string {
  const r = recordOf(db, wallet);
  if (!r) {
    return `<code>${short(wallet)}</code> has no closed positions on record in tokens it did not `
      + "create. That is not a judgement: most wallets never close enough to have one.";
  }
  return [
    `<code>${short(wallet)}</code>`,
    "",
    table([
      ["closed", `${r.closed} positions`],
      ["up", `${r.wins} of them, ${(100 * r.winRate).toFixed(0)}%`],
      ["realised", formatUsd(r.realisedUsd)],
      ["best single", `${r.bestMultiple.toFixed(1)}x`],
    ]),
    "",
    "<i>Own launches and tokens where the opening tax was waived for this wallet are excluded.</i>",
  ].join("\n");
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
