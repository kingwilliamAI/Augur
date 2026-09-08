import { logsClient, stateClient, withRetry } from "./chain.ts";

/**
 * Wall-clock time for a block, without one eth_getBlockByNumber per log.
 *
 * At ~28,000 launches a day a timestamp-per-block backfill would be tens of thousands of extra
 * round trips against a rate-limited endpoint. Blocks here are sequencer-produced every ~0.1009 s,
 * so timestamps are close to linear in block number: this samples real anchors and interpolates
 * between them, refining an interval when a lookup lands in a gap wider than `maxGap`.
 *
 * Displayed times are therefore approximate to within a few seconds. Anything that must be exact
 * (feature windows, ordering, "who bought in the same block") uses block numbers, which are exact.
 */
export class BlockClock {
  #anchors = new Map<number, number>();
  #sorted: number[] = [];
  #maxGap: number;

  constructor(maxGap = 20_000) {
    this.#maxGap = maxGap;
  }

  /**
   * A block header is a state read, so it goes to the state endpoint.
   *
   * The two public endpoints do not agree on the head: publicnode runs a few blocks ahead of the
   * official RPC, which is normal and harmless until something asks the slower one for a block the
   * faster one has just reported. The live watcher does exactly that — it takes the head from the
   * state endpoint and then anchors the clock at it — and the result was a watcher that logged
   * "block N not found" on every tick and never advanced. Reading headers from the endpoint that
   * reported the head removes the disagreement rather than papering over it; the official RPC stays
   * the fallback because it is the one that must serve the logs anyway.
   */
  async #fetch(block: number): Promise<number> {
    const read = async (client: typeof stateClient): Promise<{ timestamp: `0x${string}` } | null> =>
      (await client.request({
        method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false],
      } as never)) as { timestamp: `0x${string}` } | null;

    let b: { timestamp: `0x${string}` } | null = null;
    try {
      b = await withRetry(() => read(stateClient));
    } catch {
      b = null;
    }
    if (!b) b = await withRetry(() => read(logsClient));
    if (!b) throw new Error(`block ${block} not found on either endpoint`);
    const ts = Number(BigInt(b.timestamp));
    this.#anchors.set(block, ts);
    this.#sorted = [...this.#anchors.keys()].sort((x, y) => x - y);
    return ts;
  }

  /**
   * Pre-seeds anchors across a range so a backfill interpolates instead of fetching mid-loop.
   *
   * The step is exactly `maxGap`: `at()` refuses to interpolate across a wider gap, so anchors
   * spaced further apart than that silently turn every log's timestamp back into its own round
   * trip. A fixed number of anchors looks cheaper and is the opposite: a week of blocks then
   * costs ~230,000 serial reads instead of the ~300 this does.
   */
  async seed(from: number, to: number): Promise<void> {
    const step = this.#maxGap;
    const points = new Set<number>([from, to]);
    for (let b = from; b < to; b += step) points.add(b);
    for (const b of [...points].sort((x, y) => x - y)) {
      if (!this.#anchors.has(b)) await this.#fetch(b);
    }
  }

  async at(block: number): Promise<number> {
    const exact = this.#anchors.get(block);
    if (exact !== undefined) return exact;
    if (this.#sorted.length < 2) await this.#fetch(block);

    let lo = -1;
    let hi = -1;
    for (const b of this.#sorted) {
      if (b <= block) lo = b;
      else { hi = b; break; }
    }
    if (lo === -1 || hi === -1 || hi - lo > this.#maxGap) return this.#fetch(block);

    const tLo = this.#anchors.get(lo) as number;
    const tHi = this.#anchors.get(hi) as number;
    return Math.round(tLo + ((tHi - tLo) * (block - lo)) / (hi - lo));
  }

  /** A block number for a wall-clock instant, using the same anchors in reverse. */
  approxBlockAt(ts: number, latestBlock: number, latestTs: number): number {
    return Math.max(0, Math.round(latestBlock - (latestTs - ts) / 0.1009));
  }
}
