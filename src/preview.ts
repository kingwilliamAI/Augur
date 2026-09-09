import { featureRow, normaliseName, type History, type LaunchRow } from "./features.ts";
import { scoreVector, type Scored } from "./score.ts";
import type { GbdtModel } from "./model/gbdt.ts";
import type { DB } from "./db.ts";

/**
 * Scoring a launch that has not happened yet.
 *
 * Every one of the model's twenty-three features is either declared by the person about to deploy or
 * read from their own past, so this is not an approximation of the model: it is the model, asked
 * about a row that does not exist. Nothing here reads a trade, a price, or an outcome, because the
 * feature builder never does either.
 *
 * Two features are worth being explicit about, because they are the ones a reader will assume are
 * guesses and they are not. The creator's record is counted by graduation time rather than launch
 * time, the same way the training matrix counts it, so a preview cannot claim credit for a launch of
 * theirs that has not reached the pool yet. And launch congestion is read from the last hour of the
 * real database, so the same parameters genuinely score differently in a quiet hour and a wave.
 *
 * What this cannot know is whether the deployer will actually send the transaction they described.
 * The score is about the parameters, and the parameters are theirs to change up to the moment they
 * deploy. That is the point of showing it first.
 */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export type PreviewInput = {
  /** The wallet that will send the launch. Its record is half the score. */
  creator: string;
  symbol: string;
  description?: string;
  /** The quote asset. Zero address, or empty, means ETH. */
  quoteToken?: string;
  /** Graduation threshold in the quote asset's own units, as a decimal string. */
  graduationThresholdWei?: string;
  /** What the creator will buy of their own launch, in the quote asset's units. Null means undeclared. */
  initialBuyWei?: string | null;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
  /** Wallets waived from the opening tax. Addresses if known, otherwise just how many. */
  exempt?: string[];
  exemptCount?: number;
  twitter?: string;
  website?: string;
  telegram?: string;
  /** Where the creator fee goes, when it is not the creator's own wallet. */
  feeRecipient?: string | null;
  /** Whether the launch will go through a contract rather than straight from the wallet. */
  viaContract?: boolean;
};

export type Preview = Omit<Scored, "token" | "ts"> & {
  creator: string;
  history: History;
  /** What the preview assumed where the caller said nothing. Printed, never hidden. */
  assumed: string[];
};

const isAddress = (a: unknown): boolean =>
  typeof a === "string" && /^0x[0-9a-f]{40}$/.test(a.toLowerCase());

/**
 * Nothing here trusts its input.
 *
 * This is reached by an unauthenticated POST of arbitrary JSON, and the first version took the body
 * at its word: `exempt` was assumed to be an array and `quoteToken` a string, so a body sending a
 * number for either one threw inside the handler, and the server has no try/catch around it. One
 * curl-sized request killed the whole board, three different ways. The board's own link endpoints
 * already show the house answer — coerce first, validate second — and this now does the same.
 */
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** A decimal string of digits, or undefined. Never a number: eighteen decimals do not survive one. */
const amount = (v: unknown): string | undefined => {
  const raw = typeof v === "number" ? String(Math.trunc(v)) : str(v).trim();
  return /^\d{1,40}$/.test(raw) ? raw : undefined;
};

/** The declared parameters, reduced to the shapes the rest of this file assumes. */
function clean(input: PreviewInput): PreviewInput {
  const exempt = Array.isArray(input.exempt)
    ? input.exempt.filter(isAddress).map((a) => String(a).toLowerCase()).slice(0, 64)
    : undefined;
  const tax = int(input.creatorTaxBps);
  const count = int(input.exemptCount);
  return {
    creator: str(input.creator).toLowerCase(),
    symbol: str(input.symbol).slice(0, 64),
    description: str(input.description).slice(0, 2000) || undefined,
    quoteToken: isAddress(input.quoteToken) ? str(input.quoteToken).toLowerCase() : undefined,
    graduationThresholdWei: amount(input.graduationThresholdWei),
    // Undefined and null mean different things here — undeclared versus declared-as-nothing — so a
    // missing key must not become a zero on its way through.
    initialBuyWei: input.initialBuyWei === undefined ? undefined : (amount(input.initialBuyWei) ?? null),
    creatorTaxBps: tax === undefined ? undefined : Math.min(10_000, Math.max(0, Math.round(tax))),
    buybackEnabled: Boolean(input.buybackEnabled),
    exempt,
    exemptCount: count === undefined ? undefined : Math.min(1000, Math.max(0, Math.round(count))),
    twitter: str(input.twitter).slice(0, 200) || undefined,
    website: str(input.website).slice(0, 200) || undefined,
    telegram: str(input.telegram).slice(0, 200) || undefined,
    feeRecipient: isAddress(input.feeRecipient) ? str(input.feeRecipient).toLowerCase() : null,
    viaContract: Boolean(input.viaContract),
  };
}

/**
 * A creator's record as of now, counted the way the training matrix counts it.
 *
 * Two things here are easy to get wrong and both would make the preview lie.
 *
 * The first is the column. The model accumulates creator history on `launches.deployer`, the address
 * the factory event names (features.ts, where the cursor keys devLaunches and devGraduations off
 * sp.deployer) — not on the launch sender the card calls the creator. The two differ on a sixth of
 * launches. Counting the human-facing one here would produce a preview that disagrees with the score
 * the same launch gets a minute later, which is worse than a preview that is merely coarse. So this
 * counts what the model counts, and the caller is told which address that is.
 *
 * The second is time. Graduations are counted by when they happened, not by when the launch that
 * produced them started: counting the other way lets a preview claim an outcome that has not
 * occurred yet, which is exactly the leak the feature builder was written to avoid.
 */
export function historyFor(db: DB, deployer: string, now: number, exempt: string[] = []): History {
  const a = deployer.toLowerCase();
  const counts = db.prepare(`
    SELECT count(*) launches,
           sum(CASE WHEN g.ts IS NOT NULL AND g.ts <= ? THEN 1 ELSE 0 END) graduations
    FROM launches l LEFT JOIN graduations g USING(token)
    WHERE l.deployer = ? AND l.ts <= ?`)
    .get(now, a, now) as { launches: number; graduations: number | null };

  // Congestion, from the real last hour. A launch into a wave is a different proposition from the
  // same launch into a quiet hour, and the model was trained on that difference.
  const recent = db.prepare("SELECT count(*) c FROM launches WHERE ts >= ? AND ts <= ?")
    .get(now - 3600, now) as { c: number };

  // How many of the wallets being waived this creator has waived before. Only answerable when the
  // caller names them; naming none is not the same as there being none, and the count feature
  // carries that separately.
  let overlap = 0;
  if (exempt.length) {
    const seen = db.prepare(`
      SELECT count(DISTINCT e.address) n FROM exemptions e
      JOIN launches l USING(token)
      WHERE l.deployer = ? AND e.address IN (${exempt.map(() => "?").join(",")})`)
      .get(a, ...exempt.map((x) => x.toLowerCase())) as { n: number };
    overlap = seen.n;
  }

  return {
    priorL: counts.launches,
    priorG: counts.graduations ?? 0,
    overlap,
    recentCount: recent.c,
  };
}

/**
 * Turns declared parameters into the row the feature builder expects.
 *
 * Undeclared is not zero. Roughly half of real launches go through a router whose calldata does not
 * decode, and the model has a feature for exactly that: absence is its own signal, and folding an
 * unanswered question into "bought nothing" would poison the column the model leans on hardest. So
 * an omitted self-buy stays null here rather than becoming a confident zero.
 */
function rowFor(input: PreviewInput, now: number): LaunchRow {
  const quote = (input.quoteToken ?? "").toLowerCase();
  const pair = isAddress(quote) ? quote : ZERO_ADDR;
  const socials: Record<string, string> = {};
  if (input.twitter) socials.twitter = input.twitter;
  if (input.website) socials.website = input.website;
  if (input.telegram) socials.telegram = input.telegram;

  return {
    token: "0xpreview",
    // Not a placeholder address. Substituting one wiped the creator's record instead of modelling a
    // routed launch, which is a different and much worse answer than the caveat below.
    deployer: input.creator.toLowerCase(),
    launch_sender: input.creator.toLowerCase(),
    pair_token: pair,
    graduation_threshold_wei: input.graduationThresholdWei ?? "0",
    block: 0,
    ts: now,
    creator_fee_recipient: input.feeRecipient ? input.feeRecipient.toLowerCase() : null,
    creator_tax_bps: input.creatorTaxBps ?? null,
    buyback_enabled: input.buybackEnabled ? 1 : 0,
    initial_buy_wei: input.initialBuyWei ?? null,
    quote_decimals: null,
    exempt_count: input.exempt?.length ?? input.exemptCount ?? null,
    symbol_len: (input.symbol ?? "").length,
    desc_len: (input.description ?? "").length,
    socials_json: Object.keys(socials).length ? JSON.stringify(socials) : null,
    grad_ts: null,
  };
}

/** What the preview filled in for itself, so a reader can see which numbers are theirs. */
function assumptions(input: PreviewInput): string[] {
  const out: string[] = [];
  if (input.initialBuyWei === undefined || input.initialBuyWei === null) {
    out.push("self-buy undeclared, which is what the model sees for launches whose calldata does not decode");
  }
  if (input.exempt === undefined && input.exemptCount === undefined) out.push("no exempt wallets");
  if (!input.quoteToken || input.quoteToken.toLowerCase() === ZERO_ADDR) out.push("quoted in ETH");
  if (input.creatorTaxBps === undefined) out.push("no creator tax");
  if (input.viaContract) {
    out.push("scored against your own record, but a routed launch puts the router in the deployer "
      + "column and the model reads the router's record instead: expect the real score to differ");
  }
  if (!input.graduationThresholdWei || input.graduationThresholdWei === "0") {
    out.push("graduation threshold unset, which reads as the smallest one");
  }
  return out;
}

/**
 * The score a launch would get, and the three reasons behind it.
 *
 * The quote asset's decimals are read from the database rather than assumed, because nearly half of
 * launches are quoted in a token and USDG uses six decimals where NVDA uses eighteen: dividing both
 * by 1e18 would make two identical self-buys differ by a factor of a trillion inside the feature the
 * model leans on third-hardest.
 */
export function preview(
  db: DB, model: GbdtModel, raw: PreviewInput, now = Math.floor(Date.now() / 1000),
): Preview | { error: string } {
  const input = clean(raw ?? {} as PreviewInput);
  if (!isAddress(input.creator)) return { error: "a creator address is needed: the record is half the score" };
  if (!input.symbol) return { error: "a ticker is needed, even a placeholder: its length is a feature" };

  const row = rowFor(input, now);
  if (row.pair_token !== ZERO_ADDR) {
    const q = db.prepare("SELECT decimals FROM quote_assets WHERE address = ?")
      .get(row.pair_token) as { decimals: number } | undefined;
    row.quote_decimals = q?.decimals ?? null;
  }

  // What goes in the deployer column is what the model reads history from. A launch sent straight
  // from the wallet puts that wallet there; one routed through a contract puts the contract there,
  // and that contract's record is not this creator's. Which one it will be is the caller's to say.
  const history = historyFor(db, row.deployer, now, input.exempt ?? []);
  const { x } = featureRow(row, history, 4 * 3600);
  return { creator: input.creator.toLowerCase(), history, assumed: assumptions(input), ...scoreVector(db, model, x) };
}

/**
 * Where a launch that already happened ranked against everything scored around it.
 *
 * Not "this hour", which is what an earlier version of this called it. The rank in the prediction
 * log is computed by scoreOne against a six-hour window (its windowHours default), so labelling it
 * as an hour was a number dressed up as a tighter claim than it is. The window is returned so the
 * caller has to say which one it means.
 *
 * The other half of the deployer's tools, and the cheap half: the watcher already wrote the claim
 * before the outcome existed, so this is a lookup rather than a computation. Answered from the
 * prediction log rather than by re-scoring, so what a creator is told matches what was recorded.
 */
export const RANK_WINDOW_HOURS = 6;

export function rankedAtLaunch(db: DB, token: string): {
  token: string; symbol: string | null; probability: number; rank: number; of: number;
  betterThanPct: number; ts: number; windowHours: number;
} | null {
  const p = db.prepare(`
    SELECT p.token, l.symbol, p.probability, p.rank, p.of, p.launch_ts ts
    FROM predictions p JOIN launches l USING(token) WHERE p.token = ?`)
    .get(token.toLowerCase()) as
    { token: string; symbol: string | null; probability: number; rank: number; of: number; ts: number } | undefined;
  if (!p) return null;
  return {
    ...p,
    betterThanPct: p.of > 1 ? 100 * (1 - (p.rank - 1) / (p.of - 1)) : 100,
    windowHours: RANK_WINDOW_HOURS,
  };
}

export { normaliseName };
