import { createPublicClient, defineChain, http, webSocket, type PublicClient } from "viem";
import { ADDR, CFG } from "./config.ts";

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CFG.httpUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: ADDR.multicall3 } },
});

/**
 * The public endpoints answer 429 under load and the logs endpoint additionally times out on wide
 * ranges. Everything funnels through this gate: bounded concurrency, a minimum gap between calls,
 * and a backoff that waits out a 429 instead of hammering through it.
 */
class Gate {
  #active = 0;
  #queue: Array<() => void> = [];
  #lastStart = 0;
  #limit: number;
  #spacingMs: number;

  constructor(limit: number, spacingMs: number) {
    this.#limit = limit;
    this.#spacingMs = spacingMs;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((r) => this.#queue.push(r));
    this.#active++;
    const gap = this.#spacingMs - (Date.now() - this.#lastStart);
    if (gap > 0) await sleep(gap);
    this.#lastStart = Date.now();
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const gate = new Gate(CFG.inFlight, CFG.spacingMs);
const headers = { "user-agent": "augur/0.1 (+https://github.com/kingwilliamAI/Augur)" };

/**
 * Retries throttling and transient network errors with exponential backoff; surfaces everything else.
 *
 * A 403 counts as throttling here, which reads wrong until you notice this project sends no
 * credentials: there is nothing for the endpoint to forbid except the traffic itself. It is what the
 * public RPC answers after a long bulk read has leaned on it, and it clears on its own. Treating it
 * as fatal meant an hours-long sweep died on the first one and, worse, that every card asking for a
 * curve at that moment silently read nothing and sat on "reading" forever.
 *
 * It gets a slower backoff than a 429 because it is a cool-off rather than a blip: a few hundred
 * milliseconds is what 429 wants, and this wants seconds, growing to a minute.
 */
export async function withRetry<T>(fn: () => Promise<T>, tries = 6, base = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await gate.run(fn);
    } catch (err) {
      last = err;
      const msg = String((err as Error)?.message ?? err);
      const throttled = /Status:\s*403|\bForbidden\b/i.test(msg);
      const retryable = throttled ||
        /429|Too Many Requests|timeout|timed out|ETIMEDOUT|ECONNRESET|fetch failed|socket/i.test(msg);
      if (!retryable || i === tries - 1) throw err;
      await sleep(throttled ? Math.min(60_000, 5_000 * 2 ** i) : base * 2 ** i);
    }
  }
  throw last;
}

/** Contract reads. publicnode is quicker and more forgiving, and reads never need eth_getLogs. */
export const stateClient: PublicClient = createPublicClient({
  chain: robinhood,
  transport: http(CFG.stateUrl, { fetchOptions: { headers }, timeout: 20_000, retryCount: 0 }),
  batch: { multicall: { wait: 16 } },
});

/** eth_getLogs. The official endpoint is the only public one that serves it. */
export const logsClient: PublicClient = createPublicClient({
  chain: robinhood,
  transport: http(CFG.httpUrl, { fetchOptions: { headers }, timeout: 60_000, retryCount: 0 }),
});

/** Push detection. Null when RPC_WS_URL=off, in which case callers poll instead. */
export const wsClient: PublicClient | null =
  CFG.wsUrl && CFG.wsUrl.toLowerCase() !== "off"
    ? createPublicClient({ chain: robinhood, transport: webSocket(CFG.wsUrl, { reconnect: true, retryCount: 10 }) })
    : null;

/**
 * eth_getLogs capped at 10,000 results per response on this chain, and wide ranges time out.
 * Walks the range in chunks and halves a chunk that trips either limit rather than losing the span.
 */
export async function getLogsChunked(
  params: { address?: `0x${string}` | `0x${string}`[]; topics?: (`0x${string}` | `0x${string}`[] | null)[] },
  fromBlock: number,
  toBlock: number,
  onChunk?: (logs: unknown[], from: number, to: number) => void | Promise<void>,
  chunkSize = CFG.logsChunk,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let lo = fromBlock;
  let size = chunkSize;
  while (lo <= toBlock) {
    const hi = Math.min(lo + size - 1, toBlock);
    try {
      const logs = (await withRetry(() =>
        logsClient.request({
          method: "eth_getLogs",
          params: [{ ...params, fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${hi.toString(16)}` }],
        } as never),
      )) as unknown[];
      if (onChunk) await onChunk(logs, lo, hi);
      else out.push(...logs);
      lo = hi + 1;
      // Creep back toward the configured chunk size after a successful narrow read.
      if (size < chunkSize) size = Math.min(chunkSize, size * 2);
      await sleep(CFG.logsSpacingMs);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/exceeds limit|timed out|too many/i.test(msg) && size > 500) {
        size = Math.floor(size / 2);
        continue;
      }
      throw err;
    }
  }
  return out;
}
