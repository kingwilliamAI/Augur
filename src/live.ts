import type { Log } from "viem";
import { TOPIC } from "./abi.ts";
import { ADDR, CFG } from "./config.ts";
import { logsClient, sleep, stateClient, withRetry, wsClient } from "./chain.ts";
import { BlockClock } from "./blockclock.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import { writeFactoryLogs } from "./ingest.ts";

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const FACTORY_TOPICS = [
  [TOPIC.tokenLaunched, TOPIC.poolGraduated, TOPIC.launchSwept, TOPIC.creatorFeeRecipientUpdated],
];

export type LiveEvents = {
  onLaunch?: (token: string, block: number) => void | Promise<void>;
  onGraduation?: (token: string, block: number) => void | Promise<void>;
  onStatus?: (msg: string) => void;
};

/**
 * Follows the factory in real time.
 *
 * Half of all graduations happen within two minutes of launch, so a launch seen late is a launch not
 * worth seeing. Detection uses a websocket push where one is available; the official RPC has none,
 * so publicnode carries the subscription while the official endpoint serves the log reads.
 *
 * Every path funnels through the same catch-up read rather than trusting the socket to be complete:
 * a dropped connection, a missed notification or a restart all recover by pulling the gap between
 * the last stored block and the head. Writes are upserts, so re-reading a block is harmless.
 */
export async function runLive(db: DB, ev: LiveEvents = {}): Promise<void> {
  const status = ev.onStatus ?? ((m: string) => console.log(m));
  /**
   * Head polling goes to the state endpoint. It is the more generous of the two, and the log
   * endpoint's budget is better spent on the reads only it can serve; sharing it with a heartbeat
   * is how a concurrent enrichment run starves the watcher into a 429.
   */
  const head = async (): Promise<number> => {
    try {
      return Number(await withRetry(() => stateClient.getBlockNumber()));
    } catch {
      return Number(await withRetry(() => logsClient.getBlockNumber()));
    }
  };

  const clock = new BlockClock();
  let cursor = Number(getMeta(db, "live_cursor_block") ?? 0);
  if (!cursor) cursor = Number(getMeta(db, "backfill_to_block") ?? 0) || (await head());
  let busy = false;
  let lastBeat = 0;

  /**
   * A heartbeat, separate from the cursor.
   *
   * A watcher that has fallen over and a chain that has simply produced no launches look identical
   * from the outside: the list stops changing either way. Recording the head we last saw, and when
   * we saw it, is what lets a reader tell "nothing is happening" from "we stopped looking" — the
   * difference between an honest empty screen and a screen that is quietly lying.
   *
   * Throttled because the socket fires about ten times a second and this is the only write on the
   * path that happens whether or not anything was found.
   */
  const beat = (head: number): void => {
    const now = Date.now();
    if (now - lastBeat < 5000) return;
    lastBeat = now;
    setMeta(db, "live_head_block", String(head));
    setMeta(db, "live_seen_at", String(Math.floor(now / 1000)));
  };

  /**
   * A floor on how often the log endpoint is asked anything.
   *
   * The socket reports a new head about ten times a second, and every one of those used to become an
   * eth_getLogs. Launches arrive roughly once every three seconds, so nine in ten of those requests
   * could only ever return nothing — and the endpoint answers the excess with 429, which stalls the
   * watcher completely. Waiting a second between reads costs at most a second of latency on a signal
   * whose median outcome takes 108 seconds to resolve, and keeps the watcher inside its budget.
   */
  const MIN_READ_GAP_MS = 1000;
  let lastRead = 0;

  const catchUp = async (head: number): Promise<void> => {
    beat(head);
    if (busy || head <= cursor) return;
    if (Date.now() - lastRead < MIN_READ_GAP_MS) return;
    lastRead = Date.now();
    busy = true;
    try {
      // A restart after a long pause must not ask for a million blocks in one call, and the cap has
      // to be a width the endpoint will actually serve. It was 200,000, more than three times
      // `logsChunk`, and the official RPC answers a range that wide with "Missing or invalid
      // parameters" rather than a result. So a watcher restarted after a ten-hour outage printed
      // "run backfill to fill it", asked for 200,000 blocks anyway, failed, retried, and never
      // advanced a single block: it could not recover from exactly the situation its own message
      // was about.
      //
      // The cap does not close the gap — the cursor still jumps to head below, so the older blocks
      // stay missing until backfill reads them. What it fixes is that the watcher gets back to live
      // instead of stalling forever on a request the endpoint will never answer.
      const from = Math.max(cursor + 1, head - CFG.logsChunk);
      if (from > cursor + 1) status(`  skipping ${from - cursor - 1} blocks: gap too wide, run backfill to fill it`);

      const logs = (await withRetry(() =>
        logsClient.request({
          method: "eth_getLogs",
          params: [{ address: ADDR.factory, topics: FACTORY_TOPICS, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}` }],
        } as never),
      )) as RawLog[];

      if (logs.length) {
        // Block time, not wall-clock time. Stamping every launch in a catch-up with "now" makes a
        // batch spanning an hour of chain look simultaneous, which silently breaks everything
        // downstream that reads a launch's age: the recency ordering, the age column, the six-hour
        // window, and — worst — the prediction log's rule that a launch older than five minutes is
        // never recorded. That rule is what makes the log honest, and it cannot hold on a timestamp
        // that is always the present moment.
        //
        // Anchoring at the head first gives every earlier block in the batch a bracketing pair to
        // interpolate between, so this costs one block read per catch-up rather than one per log.
        await clock.at(head);
        const tsOf = new Map<number, number>();
        for (const b of new Set(logs.map((l) => Number(BigInt(l.blockNumber as string))))) {
          tsOf.set(b, await clock.at(b));
        }
        writeFactoryLogs(db, logs, tsOf);

        for (const l of logs) {
          const token = `0x${l.topics[1].slice(26)}`.toLowerCase();
          const block = Number(BigInt(l.blockNumber as string));
          if (l.topics[0] === TOPIC.tokenLaunched) await ev.onLaunch?.(token, block);
          else if (l.topics[0] === TOPIC.poolGraduated) await ev.onGraduation?.(token, block);
        }
      }
      cursor = head;
      setMeta(db, "live_cursor_block", String(cursor));
    } catch (err) {
      status(`  catch-up failed, will retry: ${(err as Error).message.slice(0, 80)}`);
    } finally {
      busy = false;
    }
  };

  if (wsClient) {
    status(`watching ${CFG.wsUrl} (push), reading logs from ${CFG.httpUrl}`);
    wsClient.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (bn) => { void catchUp(Number(bn)); },
      onError: (e) => status(`  websocket error: ${e.message.slice(0, 80)}`),
    });
    // The socket can go quiet without erroring; this floor guarantees progress regardless.
    // A failed heartbeat is logged and slept off: the watcher is meant to run for days, so a public
    // endpoint having a bad minute must never end the process.
    for (;;) {
      await sleep(5000);
      try {
        await catchUp(await head());
      } catch (err) {
        status(`  head poll failed, retrying: ${(err as Error).message.slice(0, 80)}`);
        await sleep(5000);
      }
    }
  }

  status(`websocket disabled, polling every ${CFG.pollMs}ms`);
  for (;;) {
    try {
      await catchUp(await head());
    } catch (err) {
      status(`  head poll failed, retrying: ${(err as Error).message.slice(0, 80)}`);
      await sleep(2000);
    }
    await sleep(CFG.pollMs);
  }
}
