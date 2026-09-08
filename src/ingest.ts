import { decodeEventLog, type Log } from "viem";
import { factoryAbi, TOPIC } from "./abi.ts";
import { ADDR } from "./config.ts";
import { getLogsChunked } from "./chain.ts";
import { BlockClock } from "./blockclock.ts";
import { toEth, type DB } from "./db.ts";

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const num = (hex: unknown): number => Number(BigInt(hex as string));

export type IngestCounts = { launched: number; graduated: number; swept: number; feeChanged: number };

/**
 * Writes one chunk of factory logs. Every statement is an upsert keyed on the natural on-chain
 * identifier, so replaying a range after a reorg or a crash corrects rows instead of duplicating.
 */
export function writeFactoryLogs(db: DB, logs: RawLog[], tsOf: Map<number, number>): IngestCounts {
  const counts: IngestCounts = { launched: 0, graduated: 0, swept: 0, feeChanged: 0 };

  const insLaunch = db.prepare(`
    INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
      graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET
      curve=excluded.curve, deployer=excluded.deployer, block=excluded.block,
      tx=excluded.tx, log_index=excluded.log_index, ts=excluded.ts`);

  const insGrad = db.prepare(`
    INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET
      block=excluded.block, tx=excluded.tx, ts=excluded.ts, position_id=excluded.position_id,
      token_amount=excluded.token_amount, pair_wei=excluded.pair_wei, pair_eth=excluded.pair_eth`);

  const insSweep = db.prepare(`
    INSERT INTO sweeps (token, block, tx, ts, quote_wei, quote_eth, token_out)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET
      block=excluded.block, tx=excluded.tx, ts=excluded.ts,
      quote_wei=excluded.quote_wei, quote_eth=excluded.quote_eth, token_out=excluded.token_out`);

  const insFeeChg = db.prepare(`
    INSERT INTO fee_recipient_changes (token, tx, log_index, prev, next, block, ts)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  // Phase is derived: a sweep or a graduation moves the launch out of the curve phase.
  const setPhase = db.prepare("UPDATE launches SET phase = ? WHERE token = ? AND phase < ?");

  db.exec("BEGIN");
  try {
    for (const log of logs) {
      const block = num(log.blockNumber);
      const ts = tsOf.get(block) ?? 0;
      const tx = log.transactionHash as string;
      const li = num(log.logIndex);
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: factoryAbi, topics: log.topics, data: log.data });
      } catch {
        continue; // an event we do not model
      }
      const a = ev.args as Record<string, unknown>;

      switch (ev.eventName) {
        case "TokenLaunched": {
          const thr = a.graduationThreshold as bigint;
          insLaunch.run(
            String(a.token).toLowerCase(), String(a.curve).toLowerCase(), String(a.deployer).toLowerCase(),
            String(a.pairToken).toLowerCase(), num(a.launchConfigId),
            thr.toString(), toEth(thr), block, tx, li, ts, Math.floor(Date.now() / 1000),
          );
          counts.launched++;
          break;
        }
        case "PoolGraduated": {
          const pair = a.pairTokenAmount as bigint;
          const token = String(a.token).toLowerCase();
          insGrad.run(token, block, tx, ts, String(a.positionId), String(a.tokenAmount), pair.toString(), toEth(pair));
          setPhase.run(2, token, 2);
          counts.graduated++;
          break;
        }
        case "LaunchSwept": {
          const q = a.quoteOut as bigint;
          const token = String(a.token).toLowerCase();
          insSweep.run(token, block, tx, ts, q.toString(), toEth(q), String(a.tokenOut));
          setPhase.run(1, token, 1);
          counts.swept++;
          break;
        }
        case "CreatorFeeRecipientUpdated": {
          insFeeChg.run(
            String(a.token).toLowerCase(), tx, li,
            String(a.previousRecipient).toLowerCase(), String(a.newRecipient).toLowerCase(), block, ts,
          );
          counts.feeChanged++;
          break;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return counts;
}

/** Streams a block range from the factory into the database, chunk by chunk. */
export async function backfillRange(
  db: DB,
  fromBlock: number,
  toBlock: number,
  onProgress?: (done: number, total: number, c: IngestCounts) => void,
): Promise<IngestCounts> {
  const clock = new BlockClock();
  await clock.seed(fromBlock, toBlock);
  const total: IngestCounts = { launched: 0, graduated: 0, swept: 0, feeChanged: 0 };

  await getLogsChunked(
    {
      address: ADDR.factory,
      topics: [[TOPIC.tokenLaunched, TOPIC.poolGraduated, TOPIC.launchSwept, TOPIC.creatorFeeRecipientUpdated]],
    },
    fromBlock,
    toBlock,
    async (logs, _from, to) => {
      const raw = logs as RawLog[];
      const tsOf = new Map<number, number>();
      for (const b of new Set(raw.map((l) => num(l.blockNumber)))) tsOf.set(b, await clock.at(b));
      const c = writeFactoryLogs(db, raw, tsOf);
      total.launched += c.launched;
      total.graduated += c.graduated;
      total.swept += c.swept;
      total.feeChanged += c.feeChanged;
      onProgress?.(to - fromBlock, toBlock - fromBlock, total);
    },
  );
  return total;
}
