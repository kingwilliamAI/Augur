import type { DB } from "./db.ts";

/**
 * What a wallet's trading record is worth, and why most of them are worth nothing.
 *
 * The alert this feeds says "a wallet with a record just bought the token you are holding", which is
 * only worth sending if "a record" cannot be manufactured. It can be, trivially, by anyone willing
 * to spend gas: launch a token, buy it from a second wallet, let it graduate on money you supplied,
 * and that second wallet now shows a graduation rate an order of magnitude above the base. Repeat
 * ten times and it looks like a career. The whole of this module is the answer to that.
 *
 * Four rules do the work, and each of them costs the faker something they cannot cheaply fake:
 *
 *   1. An entry on your own launch does not count. Creator and deployer are both checked, because
 *      a sixth of launches are sent through a contract and only one of the two columns is the wallet.
 *   2. An entry on a launch that waived the opening tax for you does not count. The exempt list is
 *      the creator naming their own people in the launch transaction, on chain, before any of this.
 *   3. An entry where you were more than half the buy volume does not count. A token nobody else
 *      bought is not a call you got right, it is a position you built against yourself.
 *   4. Ten entries are not a record unless they are spread across five creators, with no single
 *      creator supplying more than two in five. Two wallets taking turns launching for each other
 *      pass every rule above and fail this one.
 *
 * What is left is graded against the base rate the same way the model is: a Wilson lower bound at
 * 95%, so a wallet with three hits in four entries does not outrank one with forty in two hundred.
 * The bar for being called a trader with a record is that the lower bound clears the base rate,
 * which is a deliberately dull statement: it means "better than picking at random, and we are sure
 * of the sign".
 *
 * The honest limit, stated wherever this is printed: curves are read on demand, so this measures the
 * part of a wallet's history that has been read on this machine. It is a floor on their activity and
 * never a claim about all of it.
 */

/** The bar. Exported because a rule the reader cannot see is a rule they cannot check. */
export const BAR = {
  minEntries: 10,
  minCreators: 5,
  maxCreatorShare: 0.4,
  maxOwnVolumeShare: 0.5,
  /** 95%, two-sided. The same interval the scoreboard uses. */
  z: 1.96,
} as const;

/**
 * The lower end of a proportion's confidence interval.
 *
 * A rate on its own is unusable at these sample sizes: one graduation in two entries is 50% and
 * means nothing, forty in two hundred is 20% and means a great deal. Wilson keeps small samples
 * honest by pulling them towards the base until they have earned their distance from it.
 */
export function wilsonLower(hits: number, n: number, z = BAR.z): number {
  if (n <= 0) return 0;
  const p = hits / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

export type Entry = {
  token: string;
  symbol: string | null;
  graduated: boolean;
  creator: string;
  /** Their first buy on this curve: the one the record is measured from. */
  entryBlock: number;
  entryPrice: number;
  peakPrice: number | null;
  /** Their share of everything ever bought on this curve, in quote units. */
  ownShare: number;
};

export type Excluded = { own: number; exempt: number; ownMarket: number };

export type TraderRecord = {
  address: string;
  entries: number;
  graduated: number;
  creators: number;
  topCreatorShare: number;
  rate: number | null;
  lower: number | null;
  base: number | null;
  /** The lower bound against the base rate. Above 1 means "better than the pool it picked from". */
  lift: number | null;
  /** Median of peak-over-entry across clean entries with a curve to measure, on the curve only. */
  medianMultiple: number | null;
  excluded: Excluded;
  qualifies: boolean;
  /** Why not, in the words the bot prints. Empty when it does qualify. */
  short: string;
};

/**
 * The graduation rate among curves this machine has actually read.
 *
 * Not the global base rate, and the difference matters. Curves are read on demand, so the read set
 * is what somebody opened a card on or what a batch pass swept: it is richer in launches that got
 * attention, and it graduates at several times the rate of the chain as a whole. Scoring a trader
 * against the global 2% would hand every wallet in the read set a lift it did not earn. The fair
 * comparison is the pool they were picking from.
 */
export function readBaseRate(db: DB): { rate: number; n: number } | null {
  const row = db.prepare(`
    WITH read AS (SELECT token FROM curve_indexed UNION SELECT token FROM curve_summary)
    SELECT count(*) n, sum(CASE WHEN g.token IS NOT NULL THEN 1 ELSE 0 END) g
    FROM read r LEFT JOIN graduations g ON g.token = r.token`).get() as { n: number; g: number | null };
  if (!row || row.n < 200) return null;
  return { rate: (row.g ?? 0) / row.n, n: row.n };
}

type Row = {
  token: string; symbol: string | null; entry_block: number; entry_px: number;
  launch_block: number; sender: string | null; deployer: string; graduated: number;
  exempt: number | null; all_buy: number | null; my_buy: number | null; peak: number | null;
};

/**
 * Every token this wallet ever bought on a curve, with what is needed to judge the entry.
 *
 * One query rather than one per token: a busy wallet has hundreds of entries and the record is
 * computed while somebody waits for an alert. The window function picks their first buy per curve,
 * which is the entry the record is about; later buys into the same token are the same call.
 */
function entriesOf(db: DB, address: string): Row[] {
  return db.prepare(`
    WITH b AS (
      SELECT token, block, log_index,
             CAST(quote_wei AS REAL) / CAST(token_amt AS REAL) px,
             row_number() OVER (PARTITION BY token ORDER BY block, log_index) rn
      FROM curve_trades
      WHERE recipient = ? AND side = 'buy' AND CAST(token_amt AS REAL) > 0
    ),
    mine AS (SELECT token, block entry_block, px entry_px FROM b WHERE rn = 1)
    SELECT m.token, l.symbol, m.entry_block, m.entry_px, l.block launch_block,
           l.launch_sender sender, l.deployer, (g.token IS NOT NULL) graduated,
           (SELECT 1 FROM exemptions e WHERE e.token = m.token AND e.address = ?) exempt,
           (SELECT sum(CAST(quote_wei AS REAL)) FROM curve_trades t
             WHERE t.token = m.token AND t.side = 'buy') all_buy,
           (SELECT sum(CAST(quote_wei AS REAL)) FROM curve_trades t
             WHERE t.token = m.token AND t.side = 'buy' AND t.recipient = ?) my_buy,
           coalesce(s.peak_price,
             (SELECT max(CAST(quote_wei AS REAL) / CAST(token_amt AS REAL)) FROM curve_trades t
               WHERE t.token = m.token AND CAST(t.token_amt AS REAL) > 0)) peak
    FROM mine m
    JOIN launches l ON l.token = m.token
    LEFT JOIN graduations g ON g.token = m.token
    LEFT JOIN curve_summary s ON s.token = m.token`).all(address, address, address) as Row[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * One wallet's record, with everything the four rules threw out counted separately.
 *
 * `except` leaves out one token, and the alert path always passes the launch it is about. A record
 * shown beside an arrival has to be the history that made the arrival worth reporting; counting the
 * entry being announced would fold an outcome nobody knows yet into the number used to decide
 * whether to announce it.
 */
export function traderRecord(db: DB, address: string, base = readBaseRate(db), except?: string): TraderRecord {
  const a = address.trim().toLowerCase();
  const skip = except?.toLowerCase();
  const excluded: Excluded = { own: 0, exempt: 0, ownMarket: 0 };
  const clean: Entry[] = [];

  for (const r of entriesOf(db, a)) {
    if (skip && r.token === skip) continue;
    // Their own launch, under either of the two names a launch can carry.
    if (r.sender === a || r.deployer === a) { excluded.own++; continue; }
    // The creator waived the opening tax for this wallet, which makes it the creator's wallet in
    // every sense that matters here.
    if (r.exempt) { excluded.exempt++; continue; }
    // A buy in the launch block itself, which is where a creator's own opening buy lands.
    if (r.entry_block === r.launch_block) { excluded.own++; continue; }
    const all = r.all_buy ?? 0;
    const mine = r.my_buy ?? 0;
    if (all <= 0 || mine / all > BAR.maxOwnVolumeShare) { excluded.ownMarket++; continue; }

    clean.push({
      token: r.token, symbol: r.symbol, graduated: Boolean(r.graduated),
      creator: r.sender ?? r.deployer, entryBlock: r.entry_block, entryPrice: r.entry_px,
      peakPrice: r.peak, ownShare: mine / all,
    });
  }

  const n = clean.length;
  const hits = clean.filter((e) => e.graduated).length;
  const byCreator = new Map<string, number>();
  for (const e of clean) byCreator.set(e.creator, (byCreator.get(e.creator) ?? 0) + 1);
  const creators = byCreator.size;
  const topCreatorShare = n ? Math.max(...byCreator.values()) / n : 0;

  const rate = n ? hits / n : null;
  const lower = n ? wilsonLower(hits, n) : null;
  const lift = lower !== null && base && base.rate > 0 ? lower / base.rate : null;
  const multiples = clean
    .filter((e) => e.peakPrice !== null && e.entryPrice > 0)
    .map((e) => (e.peakPrice as number) / e.entryPrice);

  const short =
    n < BAR.minEntries ? `${n} clean ${n === 1 ? "entry" : "entries"}, and ${BAR.minEntries} is the bar`
      : creators < BAR.minCreators ? `${creators} creators, and ${BAR.minCreators} is the bar`
        : topCreatorShare > BAR.maxCreatorShare
          ? `${Math.round(100 * topCreatorShare)}% of their entries are one creator's launches`
          : lift === null ? "no base rate to measure against yet"
            : lift <= 1 ? "not above the base rate once the sample is accounted for"
              : "";

  return {
    address: a, entries: n, graduated: hits, creators, topCreatorShare,
    rate, lower, base: base?.rate ?? null, lift,
    medianMultiple: median(multiples), excluded, qualifies: short === "", short,
  };
}

/** The clean entries themselves, for a wallet worth showing in full. */
export function traderEntries(db: DB, address: string, limit = 5): Entry[] {
  const a = address.trim().toLowerCase();
  const rec = entriesOf(db, a)
    .filter((r) => r.sender !== a && r.deployer !== a && !r.exempt && r.entry_block !== r.launch_block)
    .filter((r) => (r.all_buy ?? 0) > 0 && (r.my_buy ?? 0) / (r.all_buy as number) <= BAR.maxOwnVolumeShare)
    .map((r) => ({
      token: r.token, symbol: r.symbol, graduated: Boolean(r.graduated),
      creator: r.sender ?? r.deployer, entryBlock: r.entry_block, entryPrice: r.entry_px,
      peakPrice: r.peak, ownShare: (r.my_buy ?? 0) / (r.all_buy as number),
    }));
  return rec
    .sort((x, y) => Number(y.graduated) - Number(x.graduated)
      || (y.peakPrice ?? 0) / y.entryPrice - (x.peakPrice ?? 0) / x.entryPrice)
    .slice(0, limit);
}
