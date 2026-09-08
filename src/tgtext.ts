import { buildCard } from "./card.ts";
import { EXPLORER } from "./config.ts";
import { getMeta, type DB } from "./db.ts";
import { graduationCapUsd, graduationMultiple } from "./pool.ts";
import { formatUsd, startingCapUsd } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";
import { loadModel, scoreOne, scoreRecent, type Scored } from "./score.ts";
import { modelId } from "./track.ts";

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

export const ago = (sec: number): string =>
  sec < 90 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;

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
  "/status — whether the watcher is still keeping up, and how old the model is.",
  "/stop — no more alerts, and your record here is deleted.",
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
