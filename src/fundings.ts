import { CFG } from "./config.ts";
import type { DB } from "./db.ts";
import type { Block, Tx } from "./blocktail.ts";

/**
 * Where a wallet's money came from, for the one line on a card that says it.
 *
 * The measured shape of this, on the live chain, is what the design is built around and what the
 * product claim had to be cut down to:
 *
 * - A native transfer is `value > 0` **and** `input === "0x"`. Counting every transaction carrying
 *   value gives 6.5 per block, twelve times as many, almost all of them router calls that happen to
 *   move ETH. With the calldata test it is 0.53 per block, about 445,000 a day.
 * - Of those, 2.7% go to a wallet that later launches a token. That is the whole signal, and it does
 *   not predict quality: one of a hundred and sixteen such launches reached a pool, against a base
 *   rate of two in a hundred. So this is a fact on a card, never an alert, and never a buy signal.
 * - The original idea — a feed of "a known creator just funded a fresh wallet" — fired zero times in
 *   an hour of chain at every threshold tried. Creators do not fund from the wallet they launch
 *   from. The comment is here so nobody rebuilds that feed from the same wrong premise.
 *
 * Only transfers whose recipient goes on to matter are kept. Keeping all 445,000 a day would be a
 * table nobody reads growing at 90 MB a day; keeping the ones that funded a launcher is a few
 * thousand rows a day and answers the only question ever asked of it.
 */

const ZERO = 0n;

/** A plain native transfer: value moved, and no calldata to explain it as something else. */
export const isNativeTransfer = (t: Tx): boolean =>
  t.to !== null && (!t.input || t.input === "0x") && BigInt(t.value) > ZERO;

export type Funding = {
  tx: string;
  block: number;
  ts: number;
  funder: string;
  wallet: string;
  wei: string;
  /** 1 when the recipient had never sent a transaction and held nothing at the parent block. */
  fresh: number | null;
};

/**
 * Records one funding transfer.
 *
 * Keyed by transaction hash rather than by (funder, wallet): the same pair can fund each other
 * repeatedly and each time is its own fact, while the same transaction read twice — on two sides of
 * a reorg, or after a restart that rewound the cursor — is the same fact and must not become two.
 */
export function saveFunding(db: DB, f: Funding): void {
  db.prepare(`INSERT INTO fundings (tx, block, ts, funder, wallet, wei, fresh)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tx) DO UPDATE SET fresh = coalesce(excluded.fresh, fundings.fresh)`)
    .run(f.tx, f.block, f.ts, f.funder, f.wallet, f.wei, f.fresh);
}

/**
 * Whether a wallet is one whose funding is worth remembering.
 *
 * A recipient matters if it has ever launched a token, or bought on a curve, or is currently linked
 * to a chat. Everything else is somebody paying somebody, which is true and uninteresting.
 *
 * Checked at write time rather than at read time because the alternative is storing everything: the
 * question "who funded this creator" is asked about a few thousand addresses and the answer has to
 * exist before it is asked, but a transfer between two wallets that never touch pons is a row that
 * will never be read.
 */
const mattersStmt = new WeakMap<DB, { launch: ReturnType<DB["prepare"]>; trade: ReturnType<DB["prepare"]> }>();

export function walletMatters(db: DB, address: string): boolean {
  const a = address.toLowerCase();
  // Prepared once per database rather than once per transfer. This runs on every native transfer in
  // every block — about 445,000 a day — and preparing a statement costs roughly four milliseconds of
  // recompilation, which at that rate is most of a core spent on nothing.
  let stmt = mattersStmt.get(db);
  if (!stmt) {
    stmt = {
      launch: db.prepare("SELECT 1 x FROM launches WHERE launch_sender = ? OR deployer = ? LIMIT 1"),
      trade: db.prepare("SELECT 1 x FROM curve_trades WHERE recipient = ? LIMIT 1"),
    };
    mattersStmt.set(db, stmt);
  }
  if (stmt.launch.get(a, a)) return true;
  // The trade check decays on purpose and cannot be relied on: compact deletes curve_trades older
  // than a couple of days, so a wallet that only ever bought is forgotten once its trades are folded
  // away. A launcher is remembered forever, which is the case this feature is actually about.
  return stmt.trade.get(a) !== undefined;
}

/**
 * Everything one block has to say about funding.
 *
 * Pure, so the interesting half of this feature can be tested without a chain: hand it a block and
 * it returns the transfers worth keeping.
 */
export function fundingsIn(db: DB, block: Block): Funding[] {
  const out: Funding[] = [];
  for (const t of block.transactions) {
    if (!isNativeTransfer(t)) continue;
    if (!walletMatters(db, t.to!)) continue;
    out.push({
      tx: t.hash, block: block.number, ts: block.timestamp,
      funder: t.from, wallet: t.to!, wei: BigInt(t.value).toString(), fresh: null,
    });
  }
  return out;
}

/**
 * Whether a recipient had never been used before this block.
 *
 * Both public endpoints refuse historical state past roughly ten minutes of blocks, answering
 * "metadata is not found". So this can only be asked while the scanner is near the head, and a
 * transfer older than the window is stored with `fresh` left null rather than with a guess. Null
 * means "not knowable", and the card says "funded" rather than "funded a fresh wallet" for it.
 */
export async function freshAt(
  rpc: (method: string, params: unknown[]) => Promise<string | null>,
  address: string, block: number, head: number,
): Promise<boolean | null> {
  if (head - block > CFG.freshWindowBlocks) return null;
  const tag = `0x${Math.max(0, block - 1).toString(16)}`;
  try {
    const [nonce, balance] = await Promise.all([
      rpc("eth_getTransactionCount", [address, tag]),
      rpc("eth_getBalance", [address, tag]),
    ]);
    if (nonce === null || balance === null) return null;
    return BigInt(nonce) === ZERO && BigInt(balance) === ZERO;
  } catch {
    return null;
  }
}

export type Origin = {
  funder: string;
  wei: string;
  ts: number;
  secondsBefore: number;
  fresh: boolean | null;
  tx: string;
  /** How many other wallets this funder has fed that went on to launch something. */
  funderFedLaunchers: number;
};

/**
 * Where one creator's wallet got its money, just before they launched.
 *
 * The last transfer before the launch rather than the first ever: a wallet that has been funded
 * eleven times over a month says nothing, and the one that arrived forty-five seconds before the
 * launch says quite a lot. Bounded by a window, so a card never claims a connection between a
 * launch and money that arrived a week earlier.
 */
export function originOf(db: DB, wallet: string, launchTs: number, windowSec = 86_400): Origin | null {
  const row = db.prepare(`
    SELECT tx, funder, wei, ts, fresh FROM fundings
    WHERE wallet = ? AND ts <= ? AND ts >= ?
    ORDER BY ts DESC LIMIT 1`)
    .get(wallet.toLowerCase(), launchTs, launchTs - windowSec) as
    { tx: string; funder: string; wei: string; ts: number; fresh: number | null } | undefined;
  if (!row) return null;

  // What the funder has done for other people. A one-off transfer between friends and an address
  // that has fed eleven wallets that all went on to launch are different facts, and the second is
  // the one worth printing.
  const fed = db.prepare(`
    SELECT count(DISTINCT f.wallet) n FROM fundings f
    WHERE f.funder = ? AND f.wallet <> ?
      AND EXISTS (SELECT 1 FROM launches l WHERE l.launch_sender = f.wallet OR l.deployer = f.wallet)`)
    .get(row.funder, wallet.toLowerCase()) as { n: number };

  return {
    funder: row.funder,
    wei: row.wei,
    ts: row.ts,
    secondsBefore: launchTs - row.ts,
    fresh: row.fresh === null ? null : row.fresh === 1,
    tx: row.tx,
    funderFedLaunchers: fed.n,
  };
}

/**
 * The fan-in case: several wallets funding one, shortly before it launches.
 *
 * Found while measuring, and the one shape in this data that looks like anything: four separate
 * addresses sent about 0.07 ETH each to one wallet, which launched a token a second later. One
 * transfer is somebody being paid; four converging inside a few minutes is a launch being staged.
 */
export function fanIn(db: DB, wallet: string, launchTs: number, windowSec = 3600): {
  funders: number; totalWei: string;
} | null {
  const r = db.prepare(`
    SELECT count(DISTINCT funder) funders, sum(CAST(wei AS REAL)) total FROM fundings
    WHERE wallet = ? AND ts <= ? AND ts >= ?`)
    .get(wallet.toLowerCase(), launchTs, launchTs - windowSec) as { funders: number; total: number | null };
  if (!r || r.funders < 2) return null;
  return { funders: r.funders, totalWei: String(BigInt(Math.round(r.total ?? 0))) };
}

/** What the board says about the scanner, for the page that reports on itself. */
export function fundingCounts(db: DB): { rows: number; wallets: number; funders: number } {
  return db.prepare(`SELECT count(*) rows, count(DISTINCT wallet) wallets, count(DISTINCT funder) funders
    FROM fundings`).get() as { rows: number; wallets: number; funders: number };
}
