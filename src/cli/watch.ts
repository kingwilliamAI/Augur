import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { buildCard, type Card } from "../card.ts";
import { wsClient } from "../chain.ts";
import { EXPLORER } from "../config.ts";
import { getMeta, openDb } from "../db.ts";
import { fetchLaunchDetail, saveLaunchDetail } from "../enrich.ts";
import { runLive } from "../live.ts";
import { loadModel, scoreOne, scoreRecent, type Scored } from "../score.ts";
import { grade, modelId, record } from "../track.ts";

/**
 * augur watch — the live feed in a terminal.
 *
 * Two renderings of the same feed. On a real terminal it is a 120×40 screen: launches on the left,
 * the selected launch's card on the right, keys along the bottom. Anywhere else — a systemd unit, a
 * log file, a pipe, `--plain` — it is one line per launch, because a full-screen redraw written into
 * a log is a wall of escape codes and the deploy guide runs this under systemd.
 *
 * What does not change between the two: every launch is enriched, scored, and its score written to
 * the prediction log before the outcome exists. The screen is only a way of looking at that.
 */
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const PLAIN = argv.includes("--plain") || (!ONCE && (!process.stdout.isTTY || !process.stdin.isTTY));

const db = openDb();

/**
 * The model is re-read when its file changes, not pinned at startup.
 *
 * The board already reloads per request, so a watcher holding yesterday's model in memory makes the
 * two disagree from the moment the nightly retrain lands until somebody restarts the service. That
 * happened on the first night: for two hours the board showed one model's numbers while the log
 * recorded another's. A log whose whole purpose is to record what was shown cannot be the one thing
 * showing something else.
 */
const MODEL_PATH = "./data/model.json";
let model = loadModel();
let MODEL_ID = modelId();
let modelMtime = existsSync(MODEL_PATH) ? statSync(MODEL_PATH).mtimeMs : 0;

function refreshModel(): void {
  const mtime = existsSync(MODEL_PATH) ? statSync(MODEL_PATH).mtimeMs : 0;
  if (mtime === modelMtime) return;
  modelMtime = mtime;
  model = loadModel();
  const was = MODEL_ID;
  MODEL_ID = modelId();
  if (MODEL_ID !== was) console.log(`\x1b[2mmodel changed ${was} -> ${MODEL_ID}; claims from here on are logged under the new one\x1b[0m`);
}

// Claims settle four hours out, so a watcher left running grades its own backlog as it goes.
setInterval(() => { try { grade(db); } catch { /* a locked write retries on the next tick */ } }, 60_000).unref();

/* ────────────────────────── shared: enrich → score → log ────────────────────────── */

type Item = Scored & {
  sym: string; name: string; quote: string; selfBuy: string | null; exempt: number;
  graduated: boolean; gradSecs: number | null; cluster: { total: number; grad: number }; born: number; logged: boolean;
};

const items: Item[] = [];
const MAX_ITEMS = 60;

function itemFrom(s: Scored): Item {
  const m = db.prepare(`
    SELECT l.symbol, l.name, l.exempt_count, l.initial_buy_wei, l.pair_token, q.symbol qs, q.decimals qd,
           (SELECT g.ts - l.ts FROM graduations g WHERE g.token = l.token) grad_secs,
           (SELECT count(*) FROM launches x WHERE x.symbol_key = l.symbol_key) ct,
           (SELECT count(*) FROM launches x JOIN graduations g2 ON g2.token = x.token WHERE x.symbol_key = l.symbol_key) cg
    FROM launches l LEFT JOIN quote_assets q ON q.address = l.pair_token WHERE l.token = ?`).get(s.token) as Record<string, unknown> | undefined;
  const eth = m?.pair_token === "0x0000000000000000000000000000000000000000";
  const dec = eth ? 18 : Number(m?.qd ?? 18);
  const wei = m?.initial_buy_wei as string | null | undefined;
  const selfBuy = wei ? trim(Number(BigInt(wei) / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6) : null;
  return {
    ...s,
    sym: String(m?.symbol ?? "?"), name: String(m?.name ?? ""),
    quote: eth ? "ETH" : String(m?.qs ?? "?"), selfBuy, exempt: Number(m?.exempt_count ?? 0),
    graduated: m?.grad_secs !== null && m?.grad_secs !== undefined, gradSecs: (m?.grad_secs as number | null) ?? null,
    cluster: { total: Number(m?.ct ?? 0), grad: Number(m?.cg ?? 0) }, born: Date.now(), logged: false,
  };
}
const trim = (n: number): string => (n >= 100 ? Math.round(n).toString() : n >= 1 ? n.toFixed(2) : n.toFixed(4)).replace(/\.?0+$/, "");

/**
 * Launches are handled in batches, and the reason is not throughput.
 *
 * Scoring one launch needs the feature matrix, and a launch this new is by definition not in it, so
 * a per-launch score rebuilds the whole matrix — five seconds each, against roughly seventeen
 * arrivals a minute. Enriching the batch first and scoring it after means one rebuild for the whole
 * batch, and it lets onLaunch return immediately so the ingest cursor keeps advancing.
 */
const BATCH_MS = 3000;
const queue: string[] = [];
let draining = false;
let onItem: (it: Item) => void = () => {};
let onGrad: (token: string) => void = () => {};

async function drain(): Promise<void> {
  refreshModel();
  if (draining || queue.length === 0) return;
  draining = true;
  const batch = queue.splice(0, queue.length);
  try {
    const rows = batch
      .map((token) => db.prepare("SELECT token, tx, ts FROM launches WHERE token = ?").get(token) as { token: string; tx: string; ts: number } | undefined)
      .filter((r): r is { token: string; tx: string; ts: number } => r !== undefined);
    await Promise.all(rows.map(async (r) => {
      try { saveLaunchDetail(db, await fetchLaunchDetail(r.token, r.tx, false)); } catch { /* the nightly pass retries */ }
    }));
    for (const r of rows) {
      const s = model ? scoreOne(db, model, r.token) : null;
      if (!s) continue;
      // Written before the outcome exists, and only while the launch is fresh enough for the claim
      // to mean what this tool says it means. track.record decides that on age alone.
      const it = itemFrom(s);
      it.logged = record(db, s, r.ts, MODEL_ID);
      onItem(it);
    }
  } finally {
    draining = false;
  }
}
setInterval(() => { void drain(); }, BATCH_MS).unref();

/* ────────────────────────── plain mode: one line per launch ────────────────────────── */

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

if (PLAIN) {
  if (!model) console.log("no model at ./data/model.json, so launches show without a score (run: npm run train)\n");
  else console.log(dim(`model ${MODEL_ID}: every score shown is logged before its outcome exists (npm run scoreboard)\n`));
  const colour = (p: number): string => (p >= 0.06 ? "\x1b[32m" : p >= 0.03 ? "\x1b[33m" : "\x1b[2m");
  onItem = (it) => {
    console.log(`${colour(it.probability)}${(100 * it.probability).toFixed(1).padStart(5)}%\x1b[0m  #${String(it.rank).padStart(4)}/${it.of}  ${bold(it.sym.padEnd(10))} ${it.name.slice(0, 28).padEnd(28)} ${dim(EXPLORER.token(it.token))}`);
    for (const x of it.reasons) console.log(dim(`         ${x.direction === "up" ? "+" : "-"} ${x.text}`));
    if (!it.logged) console.log(dim("         (not logged: seen too late for the claim to count)"));
  };
  onGrad = (token) => {
    const m = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(token) as { symbol: string | null } | undefined;
    console.log(`\x1b[32m  GRADUATED\x1b[0m ${m?.symbol ?? token}  ${dim(EXPLORER.token(token))}`);
  };
  await runLive(db, {
    onStatus: (m) => console.log(dim(m)),
    onLaunch: (token) => { queue.push(token); },
    onGraduation: (token) => onGrad(token),
  });
}

/* ────────────────────────── screen mode ────────────────────────── */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const fg = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `${ESC}48;2;${r};${g};${b}m`;
const LIME = fg(204, 255, 0), RED = fg(255, 107, 87), AMBER = fg(232, 184, 58), GREEN = fg(126, 231, 135);
const WHITE = fg(232, 234, 223), DIM = fg(110, 112, 104), FAINT = fg(60, 62, 56), BOLD = `${ESC}1m`;
const LIME_BG = bg(204, 255, 0) + fg(17, 17, 17), SEL_BG = bg(40, 48, 8), FRESH_BG = bg(34, 36, 30), FOOT_BG = bg(22, 23, 20);

type Seg = { t: string; c: string; b?: string };

const asc = (t: string): string => t.replace(/…/g, "..").replace(/×/g, "x").replace(/·/g, ".").replace(/→/g, "->").replace(/[^\x20-\x7E]/g, "?");
const fit = (t: string, n: number): string => { t = asc(t); return t.length > n ? t.slice(0, Math.max(0, n - 2)) + ".." : t.padEnd(n); };
const rfit = (t: string, n: number): string => asc(t).slice(0, n).padStart(n);
const seg = (t: string, c = WHITE, b = ""): Seg => ({ t, c, b });
const width = (): number => Math.max(100, process.stdout.columns || 120);
const height = (): number => Math.max(24, process.stdout.rows || 40);

const state = { selIdx: 0, paused: false, fireOnly: false, copiedAt: 0, flash: "" as string };
const cards = new Map<string, Card>();
const cardFor = (token: string): Card | null => {
  if (!cards.has(token)) { const c = buildCard(db, token); if (c) cards.set(token, c); }
  return cards.get(token) ?? null;
};

function visible(): Item[] {
  return items.filter((i) => !state.fireOnly || i.percentile >= 90);
}

function launchesPerMinute(): number {
  return (db.prepare("SELECT count(*) c FROM launches WHERE ts >= ?").get(Math.floor(Date.now() / 1000) - 60) as { c: number }).c;
}

function frame(): Seg[][] {
  const W = width(), H = height();
  const RW = 44, LW = W - RW - 3;
  const body = H - 4;
  const now = Date.now();
  const list = visible();
  state.selIdx = Math.min(state.selIdx, Math.max(0, list.length - 1));
  const sel = list[state.selIdx] ?? null;

  /* status bar */
  const head = Number(getMeta(db, "live_head_block") ?? 0);
  const trained = existsSync("./data/model.json") ? new Date(statSync("./data/model.json").mtimeMs).toISOString().slice(11, 16) : "--:--";
  const status = ` augur watch | Robinhood Chain 4663 | block ${head.toLocaleString("en-US")} | model ${MODEL_ID} . ${trained} | ${launchesPerMinute()} launches/min | ${wsClient ? "ws *" : "poll"}` +
    (state.paused ? " | PAUSED" : "") + (state.fireOnly ? " | TOP DECILE ONLY" : "") + (state.flash ? ` | ${state.flash}` : "");
  const lines: Seg[][] = [[seg(fit(status, W), LIME_BG + BOLD)], [seg(" ")]];

  /* left: the table */
  // The symbol field is nine wide for an eight-character symbol, so a full-width ticker still has a
  // space after it. At eight it rendered as PADSTOCKPadstock, with the two columns touching.
  const nameW = Math.max(12, LW - 2 - 10 - 8 - 7 - 9 - 7 - 4 - 10);
  const left: Seg[][] = [];
  left.push([seg(fit(`  TIME        GRAD  RANK   SYM      ${"NAME".padEnd(nameW)}SELF   EX  CLUSTER`, LW), DIM)]);
  left.push([seg("-".repeat(LW), FAINT)]);
  const rowsAvail = body - 2;
  const start = Math.max(0, Math.min(state.selIdx - Math.floor(rowsAvail / 2), list.length - rowsAvail));
  list.slice(start, start + rowsAvail).forEach((i, k) => {
    const isSel = start + k === state.selIdx, fresh = now - i.born < 900;
    const b = isSel ? SEL_BG : fresh ? FRESH_BG : "";
    const top = i.percentile >= 90;
    const pc = i.graduated ? GREEN : top ? LIME : i.probability >= 0.03 ? AMBER : DIM;
    const w = top || i.graduated ? BOLD : "";
    left.push([
      seg(isSel ? "> " : "  ", LIME + BOLD, b),
      seg(fit(new Date(i.ts * 1000).toTimeString().slice(0, 8), 10), DIM, b),
      seg(rfit(i.graduated ? "GRAD" : (100 * i.probability).toFixed(1) + "%", 6) + "  ", pc + w, b),
      seg(rfit("#" + i.rank, 6) + " ", DIM, b),
      seg(fit(i.sym, 8) + " ", pc + w, b),
      seg(fit(i.name, nameW), WHITE, b),
      seg(rfit(i.selfBuy ?? "-", 5) + "  ", i.selfBuy === null ? FAINT : WHITE, b),
      seg(rfit(String(i.exempt), 2) + "  ", i.exempt >= 3 ? RED : WHITE, b),
      seg(fit(i.cluster.total > 1 ? `${i.cluster.total}(${i.cluster.grad})` : "-", 10), i.cluster.total > 1 ? WHITE : FAINT, b),
    ]);
  });
  while (left.length < body) left.push([seg(" ".repeat(LW))]);

  /* right: the card */
  const right: Seg[][] = [];
  const box = (segs: Seg[]): Seg[] => [seg("| ", DIM), ...segs, seg(" |", DIM)];
  const line = (label: string, val: string, vc = WHITE): Seg[] => box([seg(fit(label, 11), DIM), seg(fit(val, RW - 4 - 11), vc)]);
  const blank = (): Seg[] => box([seg(" ".repeat(RW - 4))]);
  if (sel) {
    const c = cardFor(sel.token);
    const title = ` ${sel.sym} . ${sel.name} `;
    right.push([seg("+" + fit(title, RW - 4).replace(/ +$/, (m) => "-".repeat(m.length)) + "--+", DIM)]);
    const copied = now - state.copiedAt < 1500;
    right.push(box([seg(fit(sel.token, RW - 4 - 10), WHITE), seg(copied ? " v copied " : " [c] copy ", copied ? fg(17, 17, 17) : LIME, copied ? bg(204, 255, 0) : bg(38, 46, 8))]));
    right.push(blank());
    const pc = sel.graduated ? GREEN : sel.percentile >= 90 ? LIME : sel.probability >= 0.03 ? AMBER : WHITE;
    const lift = c ? "" : "";
    right.push(box([seg(fit("GRADUATE", 12), DIM), seg(fit(sel.graduated ? `GRADUATED . ${sel.gradSecs ?? "?"} s` : (100 * sel.probability).toFixed(1) + "%", sel.graduated ? 18 : 8), pc + BOLD), seg(fit(sel.graduated ? "" : `#${sel.rank}/${sel.of} last 6h${lift}`, RW - 4 - 20 - (sel.graduated ? 10 : 0)), DIM)]));
    right.push(box([seg(fit("TICKER", 12), DIM), seg(fit(sel.cluster.total > 1 ? `${sel.cluster.total} launches` : "unique", 14), sel.cluster.total > 1 ? LIME : WHITE), seg(fit(sel.cluster.total > 1 ? `${sel.cluster.grad} reached pool` : "", RW - 4 - 26), DIM)]));
    right.push(blank());
    for (const r of sel.reasons.slice(0, 3)) right.push(box([seg((r.direction === "up" ? "+" : "-") + " ", (r.direction === "up" ? LIME : RED) + BOLD), seg(fit(r.text, RW - 6), WHITE)]));
    right.push(blank());
    if (c) {
      const H = c.creatorHistory, L = c.launch;
      right.push(line("creator", `${L.creator ? L.creator.slice(0, 10) : "?"}  ${H.priorLaunches} launch${H.priorLaunches === 1 ? "" : "es"}, ${H.priorGraduations} v`));
      right.push(line("self-buy", L.selfBuy === null ? "not declared" : `${L.selfBuy} ${L.quoteSymbol}`, L.selfBuy === null ? DIM : WHITE));
      right.push(line("exempt", c.exemptions.length === 0 ? "none" : `${c.exemptions.length} wallets`, c.exemptions.length >= 3 ? RED : WHITE));
      right.push(line("fees ->", c.fees.recipient ? (c.fees.redirected ? "third party " + c.fees.recipient.slice(0, 10) : "creator") : "?", c.fees.redirected ? RED : WHITE));
      right.push(line("tax", L.creatorTaxBps === null ? "?" : (L.creatorTaxBps / 100) + "%"));
      right.push(line("quote", L.quoteSymbol + (L.isEthQuoted ? "" : " (token)"), L.isEthQuoted ? WHITE : AMBER));
      const soc = Object.keys(c.socials).length ? Object.keys(c.socials).join(", ") : "none";
      right.push(line("socials", soc, soc === "none" ? RED : WHITE));
      if (c.trading.indexed) {
        const T = c.trading;
        right.push(line("buyers", `${T.buyersTotal} total, ${T.buyersFirstMinute} first min`));
        right.push(line("snipers", T.snipers.length ? `${new Set(T.snipers.map((x) => x.address)).size} paid ${T.snipeTaxTotal}` : "none", T.snipers.length ? AMBER : WHITE));
      }
      right.push(blank());
      right.push(box([seg(fit("EARLIER LAUNCHES", RW - 4), DIM)]));
      if (H.recent.length) {
        for (const p of H.recent.slice(0, 3)) {
          const agoS = Math.floor(now / 1000 - p.ts);
          const when = agoS < 3600 ? `${Math.round(agoS / 60)} m ago` : agoS < 86400 ? `${Math.round(agoS / 3600)} h ago` : `${Math.round(agoS / 86400)} d ago`;
          right.push(box([seg(fit(p.symbol ?? p.token.slice(0, 8), 10), WHITE + BOLD), seg(fit(when, 12), DIM), seg(fit(p.graduated ? "reached pool" : "did not", RW - 4 - 22), p.graduated ? GREEN : DIM)]));
        }
      } else {
        right.push(box([seg(fit(H.priorLaunches === 0 ? "first launch from this wallet" : "no earlier launches on record", RW - 4), DIM)]));
      }
      right.push(blank());
    }
    right.push(box([seg(fit(EXPLORER.token(sel.token).replace("https://", ""), RW - 4), DIM)]));
    right.push([seg("+" + "-".repeat(RW - 2) + "+", DIM)]);
  }
  while (right.length < body) right.push([seg(" ".repeat(RW))]);

  for (let i = 0; i < body; i++) lines.push([...(left[i] ?? [seg(" ".repeat(LW))]), seg(" | ", FAINT), ...(right[i] ?? [])]);
  lines.push([seg(" ")]);
  lines.push([seg(fit(" up/down select   c copy contract   f top decile only   p pause   enter open explorer   q quit", W), fg(160, 162, 154) + FOOT_BG)]);
  return lines;
}

/**
 * The screen as bytes, colour included.
 *
 * Shared with the single-frame path rather than written twice: that path exists to be looked at, and
 * a frame that drops every colour is not what the screen looks like. The status bar's lime, the red
 * on a launch the creator is selling into, the dim on everything you skim past — those carry as much
 * as the text does.
 */
const serialize = (rows: Seg[][]): string =>
  rows.map((segs) => segs.map((s) => `${s.b ?? ""}${s.c}${s.t}${RESET}`).join("")).join("\n");

function paint(): void {
  process.stdout.write(`${ESC}H${serialize(frame())}${ESC}J`);
}

function copyToClipboard(text: string): void {
  const cmd = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  try { const p = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] }); p.on("error", () => {}); p.stdin.end(text); } catch { /* no clipboard here */ }
}
function openUrl(url: string): void {
  const [c, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(c, a, { stdio: "ignore", detached: true }).unref(); } catch { /* no browser here */ }
}

function seed(): void {
  if (!model) return;
  // The screen should not open empty: start from the newest launches already scored on the board.
  for (const s of scoreRecent(db, model, 6, 24, "new").items) { const it = itemFrom(s); it.born = 0; items.push(it); }
}

if (!PLAIN) {
  seed();
  if (ONCE) {
    // One frame, no terminal: what the screen looks like right now, for a screenshot or a test.
    process.stdout.write(`${serialize(frame())}\n`);
    process.exit(0);
  }
  if (!model) { console.log("no model at ./data/model.json. Run: npm run train"); process.exit(1); }

  onItem = (it) => {
    items.unshift(it);
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    if (state.selIdx > 0) state.selIdx = Math.min(state.selIdx + 1, visible().length - 1); // keep the selection on the same launch
    paint();
  };
  onGrad = (token) => {
    const it = items.find((i) => i.token === token);
    if (it) { it.graduated = true; it.gradSecs = Math.floor(Date.now() / 1000 - it.ts); cards.delete(token); }
    state.flash = `GRADUATED ${it?.sym ?? token.slice(0, 10)}`;
    setTimeout(() => { state.flash = ""; paint(); }, 4000);
    paint();
  };

  process.stdout.write(`${ESC}?25l${ESC}2J`);
  const restore = (): void => { process.stdout.write(`${ESC}?25h${RESET}\n`); };
  process.on("exit", restore);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    const list = visible();
    const sel = list[state.selIdx] ?? null;
    if (key === "q" || key === "") { restore(); process.exit(0); }
    else if (key === `${ESC}B` || key === "j") state.selIdx = Math.min(state.selIdx + 1, Math.max(0, list.length - 1));
    else if (key === `${ESC}A` || key === "k") state.selIdx = Math.max(state.selIdx - 1, 0);
    else if (key === "p") state.paused = !state.paused;
    else if (key === "f") { state.fireOnly = !state.fireOnly; state.selIdx = 0; }
    else if (key === "c" && sel) { copyToClipboard(sel.token); state.copiedAt = Date.now(); setTimeout(paint, 1600); }
    else if ((key === "\r" || key === "\n") && sel) openUrl(EXPLORER.token(sel.token));
    paint();
  });
  process.stdout.on("resize", paint);
  setInterval(paint, 1000).unref();
  paint();

  await runLive(db, {
    onStatus: (m) => { state.flash = m.trim().slice(0, 40); paint(); },
    onLaunch: (token) => { if (!state.paused) queue.push(token); },
    onGraduation: (token) => onGrad(token),
  });
}
