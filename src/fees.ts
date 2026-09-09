import { decodeEventLog, type Log } from "viem";
import { escrowAbi, splitterAbi, TOPIC } from "./abi.ts";
import { BlockClock } from "./blockclock.ts";
import { logsClient, stateClient, withRetry } from "./chain.ts";
import { ADDR, CFG, EXPLORER } from "./config.ts";
import { getMeta, setMeta, toEth, type DB } from "./db.ts";
import { usdOf } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";

/**
 * Where the fee goes, read off the chain instead of described on a page.
 *
 * Every trade on a pons curve pays a fee, and the launch names one address to receive it. That
 * money is the only revenue this project has, so what happens to it is the one claim on the site a
 * reader has no independent way to check — unless the split is a contract and the payouts are
 * events, which is what this reads.
 *
 * Two halves, and both are worth having on their own. The escrow half is what the fee *is*: the
 * pons fee escrow credits a recipient as trades happen and emits a claim when they take it, so the
 * ledger works from the first day, before any splitter exists, and it works for anybody's launch
 * rather than only ours. The splitter half is what happens *after*: one row per release, carrying
 * the three amounts and the transaction they left in.
 *
 * Nothing here signs anything or moves anything. It reads logs.
 */

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const num = (h: unknown): number => Number(BigInt(h as string));

/** An address as a 32-byte log topic, for filtering by an indexed argument. */
export const asTopic = (address: string): `0x${string}` =>
  `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;

export type FeeRecipient = { address: string; fromBlock: number };

/**
 * Every address the launch has paid, oldest first, each with the block it took over at.
 *
 * The launch row holds the recipient declared in the launch calldata, and re-enriching reads the same
 * calldata again, so that column never learns that the creator moved the fee. The factory logs the
 * move as `CreatorFeeRecipientUpdated` and the watcher keeps those rows; this is the one place that
 * puts the two together, so the ledger follows the money rather than the launch's first intention.
 */
export function feeRecipients(db: DB, token: string): FeeRecipient[] {
  const l = db.prepare("SELECT block, creator_fee_recipient FROM launches WHERE token = ?").get(token) as
    { block: number; creator_fee_recipient: string | null } | undefined;
  if (!l) return [];
  const changes = db.prepare(
    "SELECT prev, next, block FROM fee_recipient_changes WHERE token = ? ORDER BY block, log_index",
  ).all(token) as Array<{ prev: string; next: string; block: number }>;

  const out: FeeRecipient[] = [];
  const add = (address: string | null, fromBlock: number): void => {
    const a = address?.toLowerCase();
    if (a && !out.some((r) => r.address === a)) out.push({ address: a, fromBlock });
  };
  add(l.creator_fee_recipient ?? changes[0]?.prev ?? null, l.block);
  for (const c of changes) add(c.next, c.block);
  return out;
}

/**
 * The address the launch pays today, or null when nothing is on record yet.
 *
 * Read from the latest move rather than from the end of the list above, which drops repeats: a fee
 * moved away and back again is paid to the first wallet, and the list would name the second.
 */
export function currentFeeRecipient(db: DB, token: string): string | null {
  const last = db.prepare(
    "SELECT next FROM fee_recipient_changes WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 1",
  ).get(token) as { next: string } | undefined;
  if (last?.next) return last.next.toLowerCase();
  return feeRecipients(db, token).at(-1)?.address ?? null;
}

export type EscrowCounts = { credited: number; claimed: number };

/**
 * Credits and claims for one recipient, from the pons fee escrow.
 *
 * Filtered on the recipient topic rather than read wholesale: the escrow serves every launch on the
 * chain, and the ledger only ever asks about one address at a time.
 */
export async function indexEscrow(
  db: DB, recipient: string, fromBlock: number, toBlock: number,
): Promise<EscrowCounts> {
  const logs = (await withRetry(() =>
    logsClient.request({
      method: "eth_getLogs",
      params: [{
        address: ADDR.escrow,
        topics: [[TOPIC.credited, TOPIC.claimed], asTopic(recipient)],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      }],
    } as never),
  )) as RawLog[];

  const out: EscrowCounts = { credited: 0, claimed: 0 };
  if (!logs.length) return out;

  const clock = new BlockClock();
  const tsOf = new Map<number, number>();
  for (const b of new Set(logs.map((l) => num(l.blockNumber)))) tsOf.set(b, await clock.at(b));

  const ins = db.prepare(`
    INSERT INTO fee_events (tx, log_index, kind, recipient, depositor, amount_wei, amount_eth, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  db.exec("BEGIN");
  try {
    for (const l of logs) {
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: escrowAbi, topics: l.topics, data: l.data });
      } catch {
        continue;
      }
      const a = ev.args as Record<string, unknown>;
      const amount = a.amount as bigint;
      const block = num(l.blockNumber);
      ins.run(
        l.transactionHash as string, num(l.logIndex), ev.eventName === "Credited" ? "credited" : "claimed",
        String(a.recipient).toLowerCase(), a.depositor ? String(a.depositor).toLowerCase() : null,
        amount.toString(), toEth(amount), block, tsOf.get(block) ?? 0,
      );
      if (ev.eventName === "Credited") out.credited++;
      else out.claimed++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return out;
}

/** Releases from the splitter: one row per payout, with the three amounts it left in. */
export async function indexSplits(db: DB, splitter: string, fromBlock: number, toBlock: number): Promise<number> {
  const logs = (await withRetry(() =>
    logsClient.request({
      method: "eth_getLogs",
      params: [{
        address: splitter,
        topics: [[TOPIC.split]],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      }],
    } as never),
  )) as RawLog[];
  if (!logs.length) return 0;

  const clock = new BlockClock();
  const tsOf = new Map<number, number>();
  for (const b of new Set(logs.map((l) => num(l.blockNumber)))) tsOf.set(b, await clock.at(b));

  const ins = db.prepare(`
    INSERT INTO fee_splits (tx, log_index, asset, total_wei, server_wei, holders_wei, buyback_wei, total_eth, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  let n = 0;
  db.exec("BEGIN");
  try {
    for (const l of logs) {
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: splitterAbi, topics: l.topics, data: l.data });
      } catch {
        continue;
      }
      if (ev.eventName !== "Split") continue;
      const a = ev.args as Record<string, unknown>;
      const block = num(l.blockNumber);
      const total = a.total as bigint;
      ins.run(
        l.transactionHash as string, num(l.logIndex), String(a.asset).toLowerCase(),
        total.toString(), (a.toServer as bigint).toString(), (a.toHolders as bigint).toString(),
        (a.toBuyback as bigint).toString(), toEth(total), block, tsOf.get(block) ?? 0,
      );
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export type SplitConfig = {
  address: string;
  server: string; holders: string; buyback: string;
  serverBps: number; holdersBps: number; buybackBps: number;
};

/**
 * The splitter's own terms, read from the contract and kept.
 *
 * Read rather than configured, because a share written in a config file is a claim about a contract
 * and this is the contract itself answering. Stored so the page can show it without an RPC call on
 * every request; the values are immutable, so a cached copy cannot go stale.
 */
export async function readSplitConfig(db: DB, splitter: string): Promise<SplitConfig> {
  const call = async (fn: string): Promise<unknown> =>
    withRetry(() => stateClient.readContract({
      address: splitter as `0x${string}`, abi: splitterAbi, functionName: fn as never,
    }));

  const cfg: SplitConfig = {
    address: splitter.toLowerCase(),
    server: String(await call("server")).toLowerCase(),
    holders: String(await call("holders")).toLowerCase(),
    buyback: String(await call("buyback")).toLowerCase(),
    serverBps: Number(await call("serverBps")),
    holdersBps: Number(await call("holdersBps")),
    buybackBps: Number(await call("buybackBps")),
  };
  setMeta(db, "fee_split_config", JSON.stringify(cfg));
  return cfg;
}

export function splitConfig(db: DB): SplitConfig | null {
  const raw = getMeta(db, "fee_split_config");
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as SplitConfig;
    // A config left over from a splitter that is no longer the configured one would describe an
    // arrangement nobody is using any more, which is worse than showing nothing.
    return CFG.feeSplitter && cfg.address !== CFG.feeSplitter ? null : cfg;
  } catch {
    return null;
  }
}

export type FeeLedger = {
  /** The address the launch pays, whether that is a wallet or the splitter. */
  recipient: string | null;
  recipientUrl: string | null;
  splitter: SplitConfig | null;
  /**
   * How the fee is actually being divided right now.
   *
   * "contract" once the launch pays the splitter, which is the version nobody has to trust;
   * "wallet" when the operator's own command has been splitting it, which is a habit with a ledger
   * behind it; "none" when neither has happened yet. The page prints the difference rather than
   * flattening it, because the difference is the only thing a reader is being asked to weigh.
   */
  mode: "contract" | "wallet" | "none";
  credited: { wei: string; eth: number; count: number };
  claimed: { wei: string; eth: number; count: number };
  unclaimed: { wei: string; eth: number };
  /**
   * What the launch has earned, from both places a creator fee can come from.
   *
   * While a token is on the curve the fee accrues in the pons escrow; after it graduates the same
   * fee is charged by the hook in the pool and arrives in sweeps. $AUGUR is past the curve, so the
   * second is the live number and the first is history. A page that showed only one of them would
   * be understating the answer by whichever half it left out.
   */
  income: { curveEth: number; poolQuote: number; poolUsd: number | null; sweeps: number; quoteSymbol: string | null };
  /**
   * What the buyback share was actually spent on.
   *
   * The payout can only prove that the money reached the buyback wallet; this is the half that shows
   * it was used. Each row carries the floor the swap was allowed to settle at as well as what came
   * back, because a fill that landed on its floor is what being front-run looks like and a ledger
   * that stored only the outcome could not say so.
   */
  buybacks: {
    count: number; spentEth: number; tokens: number; lastTs: number | null;
    recent: Array<{ tx: string; url: string; ts: number; spentEth: number; tokens: number; onFloor: boolean }>;
  };
  /**
   * What the wallet itself paid out, when the split is run in software rather than by a contract.
   *
   * Kept apart from `splits` rather than merged into it, because the difference is the whole point:
   * a contract cannot send the money anywhere else and a wallet can. A page that blended the two
   * would be claiming a guarantee for lines that only ever had a habit behind them.
   */
  payouts: {
    count: number;
    nodesEth: number; buybackEth: number; teamEth: number;
    recent: Array<{
      tx: string; url: string; ts: number; kind: string; address: string;
      addressUrl: string; asset: string; amountEth: number; bps: number;
    }>;
    lastTs: number | null;
  };
  splits: {
    count: number; totalEth: number; serverEth: number; holdersEth: number; buybackEth: number;
    recent: Array<{
      tx: string; url: string; ts: number; asset: string;
      totalEth: number; serverEth: number; holdersEth: number; buybackEth: number;
    }>;
  };
  firstSeenTs: number | null;
  lastReadBlock: number | null;
};

const sumWei = (rows: Array<{ amount_wei: string }>): bigint =>
  rows.reduce((acc, r) => acc + BigInt(r.amount_wei), 0n);

/**
 * The ledger, as the page and the API read it.
 *
 * Deliberately readable before anything has been deployed: with no splitter configured this is the
 * fee arriving at whatever address the launch names, which is a true and checkable statement about
 * where the money goes today. The page says which of the two states it is in rather than implying
 * the finished one.
 */
export function feeLedger(db: DB, limit = 25): FeeLedger {
  const coin = CFG.coinToken;
  // Every wallet the launch has paid, so a move of the fee does not erase what came before it.
  const recipients = coin ? feeRecipients(db, coin) : [];
  const recipient = coin ? currentFeeRecipient(db, coin) : null;
  const splitter = splitConfig(db);

  const events = recipients.length
    ? db.prepare(
      `SELECT kind, amount_wei, ts FROM fee_events WHERE recipient IN (${recipients.map(() => "?").join(",")})`,
    ).all(...recipients.map((r) => r.address)) as Array<{ kind: string; amount_wei: string; ts: number }>
    : [];
  const credited = events.filter((e) => e.kind === "credited");
  const claimed = events.filter((e) => e.kind === "claimed");
  const creditedWei = sumWei(credited);
  const claimedWei = sumWei(claimed);

  const splits = db.prepare(`
    SELECT tx, ts, asset, total_wei, server_wei, holders_wei, buyback_wei
    FROM fee_splits ORDER BY block DESC, log_index DESC LIMIT ?`).all(limit) as
    Array<{ tx: string; ts: number; asset: string; total_wei: string; server_wei: string;
            holders_wei: string; buyback_wei: string }>;
  const totals = db.prepare(`
    SELECT count(*) c, coalesce(sum(total_eth),0) t,
           coalesce(sum(CAST(server_wei AS REAL)),0) s,
           coalesce(sum(CAST(holders_wei AS REAL)),0) h,
           coalesce(sum(CAST(buyback_wei AS REAL)),0) b
    FROM fee_splits`).get() as { c: number; t: number; s: number; h: number; b: number };

  const paid = db.prepare(`
    SELECT tx, ts, kind, asset, address, amount_wei, bps FROM payouts
    ORDER BY ts DESC, rowid DESC LIMIT ?`).all(limit) as
    Array<{ tx: string; ts: number; kind: string; asset: string; address: string; amount_wei: string; bps: number }>;
  const paidTotals = db.prepare(`
    SELECT count(*) c, max(ts) last,
           coalesce(sum(CASE WHEN kind = 'nodes'   THEN CAST(amount_wei AS REAL) END), 0) nodes,
           coalesce(sum(CASE WHEN kind = 'buyback' THEN CAST(amount_wei AS REAL) END), 0) buyback,
           coalesce(sum(CASE WHEN kind = 'team'    THEN CAST(amount_wei AS REAL) END), 0) team
    FROM payouts`).get() as { c: number; last: number | null; nodes: number; buyback: number; team: number };

  const bought = db.prepare(`
    SELECT tx, ts, spent_wei, received, min_out FROM buybacks ORDER BY ts DESC LIMIT ?`).all(limit) as
    Array<{ tx: string; ts: number; spent_wei: string; received: string; min_out: string }>;
  const boughtTotals = db.prepare(`
    SELECT count(*) c, max(ts) last, coalesce(sum(spent_eth),0) spent,
           coalesce(sum(CAST(received AS REAL)),0) tokens FROM buybacks`)
    .get() as { c: number; last: number | null; spent: number; tokens: number };

  const seen = events.map((e) => e.ts).filter((t) => t > 0);

  // The pool half of the same fee, already indexed for the coin page.
  const pool = coin
    ? db.prepare("SELECT pool_id FROM pools WHERE token = ?").get(coin) as { pool_id: string } | undefined
    : undefined;
  const swept = pool
    ? db.prepare("SELECT count(*) n, coalesce(sum(CAST(fee_quote AS REAL)),0) s FROM coin_sweeps WHERE pool_id = ?")
      .get(pool.pool_id) as { n: number; s: number }
    : { n: 0, s: 0 };
  const q = coin
    ? quoteFromCache(db, String((db.prepare("SELECT pair_token FROM launches WHERE token = ?").get(coin) as
      { pair_token: string } | undefined)?.pair_token ?? ""))
    : null;
  const poolQuote = q ? swept.s / 10 ** q.decimals : 0;
  const usdPer = q ? usdOf(q.symbol) : null;

  return {
    recipient,
    recipientUrl: recipient ? EXPLORER.address(recipient) : null,
    splitter,
    mode: splitter && recipient && splitter.address === recipient
      ? "contract"
      : paidTotals.c > 0 ? "wallet" : "none",
    credited: { wei: creditedWei.toString(), eth: toEth(creditedWei), count: credited.length },
    claimed: { wei: claimedWei.toString(), eth: toEth(claimedWei), count: claimed.length },
    unclaimed: {
      wei: (creditedWei - claimedWei).toString(),
      eth: toEth(creditedWei > claimedWei ? creditedWei - claimedWei : 0n),
    },
    payouts: {
      count: paidTotals.c,
      nodesEth: paidTotals.nodes / 1e18,
      buybackEth: paidTotals.buyback / 1e18,
      teamEth: paidTotals.team / 1e18,
      lastTs: paidTotals.last,
      recent: paid.map((p) => ({
        tx: p.tx, url: EXPLORER.tx(p.tx), ts: p.ts, kind: p.kind, address: p.address,
        addressUrl: EXPLORER.address(p.address), asset: p.asset,
        amountEth: Number(BigInt(p.amount_wei)) / 1e18, bps: p.bps,
      })),
    },
    buybacks: {
      count: boughtTotals.c,
      spentEth: boughtTotals.spent,
      tokens: boughtTotals.tokens / 1e18,
      lastTs: boughtTotals.last,
      recent: bought.map((b) => ({
        tx: b.tx, url: EXPLORER.tx(b.tx), ts: b.ts,
        spentEth: Number(BigInt(b.spent_wei)) / 1e18,
        tokens: Number(BigInt(b.received)) / 1e18,
        onFloor: BigInt(b.received) > 0n && BigInt(b.received) <= BigInt(b.min_out),
      })),
    },
    income: {
      curveEth: toEth(creditedWei),
      poolQuote,
      poolUsd: usdPer === null ? null : poolQuote * usdPer,
      sweeps: swept.n,
      quoteSymbol: q?.symbol ?? null,
    },
    splits: {
      count: totals.c,
      totalEth: totals.t,
      serverEth: totals.s / 1e18,
      holdersEth: totals.h / 1e18,
      buybackEth: totals.b / 1e18,
      recent: splits.map((s) => ({
        tx: s.tx, url: EXPLORER.tx(s.tx), ts: s.ts, asset: s.asset,
        totalEth: Number(BigInt(s.total_wei)) / 1e18,
        serverEth: Number(BigInt(s.server_wei)) / 1e18,
        holdersEth: Number(BigInt(s.holders_wei)) / 1e18,
        buybackEth: Number(BigInt(s.buyback_wei)) / 1e18,
      })),
    },
    firstSeenTs: seen.length ? Math.min(...seen) : null,
    lastReadBlock: Number(getMeta(db, "fees_to_block") ?? 0) || null,
  };
}
