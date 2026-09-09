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
  /** True once the recipient is the splitter, which is when the arrangement stops being a promise. */
  live: boolean;
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
  const l = coin
    ? db.prepare("SELECT creator_fee_recipient FROM launches WHERE token = ?").get(coin) as
      { creator_fee_recipient: string | null } | undefined
    : undefined;
  const recipient = (l?.creator_fee_recipient ?? null)?.toLowerCase() ?? null;
  const splitter = splitConfig(db);

  const events = recipient
    ? db.prepare("SELECT kind, amount_wei, ts FROM fee_events WHERE recipient = ?").all(recipient) as
      Array<{ kind: string; amount_wei: string; ts: number }>
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
    live: Boolean(splitter && recipient && splitter.address === recipient),
    credited: { wei: creditedWei.toString(), eth: toEth(creditedWei), count: credited.length },
    claimed: { wei: claimedWei.toString(), eth: toEth(claimedWei), count: claimed.length },
    unclaimed: {
      wei: (creditedWei - claimedWei).toString(),
      eth: toEth(creditedWei > claimedWei ? creditedWei - claimedWei : 0n),
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
