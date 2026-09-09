import { CFG } from "./config.ts";
import { sleep } from "./chain.ts";

/**
 * Full block bodies, read in batches, close behind the head.
 *
 * Everything else in this project reads logs. Logs are cheap, indexed by the node, and filtered
 * server-side. This reads bodies instead, because the two things that need it are invisible in logs:
 * a native ETH transfer emits nothing at all, and a pool swap names the router that submitted it
 * rather than the wallet that wanted it. Both facts live in the transaction list and nowhere else.
 *
 * Three measured facts shape the design, and two of them contradict what the plan assumed:
 *
 * - **The state endpoint cannot serve this.** publicnode answers eth_getBlockByNumber(n, true) near
 *   the head and refuses anything deeper with "Archive requests require a personal token", so the
 *   two-endpoint split the roadmap imagined does not exist. Bodies come from the official RPC, the
 *   same endpoint the watcher's logs depend on, which is why this runs as its own process with its
 *   own pacing rather than inside the watcher.
 * - **Batching is what makes it affordable.** Ten blocks in one JSON-RPC array is ~200 ms and one
 *   request, against ten requests serially. Nothing else in this codebase batches; viem's transport
 *   can, but it schedules by time window rather than by "exactly these ten", so a plain fetch of an
 *   array is the honest fit and adds no dependency.
 * - **The wire is smaller than the parse.** Bodies decode to ~41-47 KB each and arrive gzipped at
 *   about an eighth of that. Budget CPU for 40 GB a day of JSON parsing; do not budget 40 GB of
 *   network.
 *
 * The reader owns no domain knowledge. It fetches, checks that the chain it read is actually a
 * chain, and hands blocks to whoever registered. What to keep is the consumer's business.
 */

export type Tx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
};

export type Block = {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: Tx[];
};

type RawTx = { hash: string; from: string; to: string | null; value: string; input?: string; data?: string };
type RawBlock = { number: string; hash: string; parentHash: string; timestamp: string; transactions: RawTx[] };

/** How many blocks go in one JSON-RPC array. Ten is where the round trip stops dominating. */
export const BATCH = 10;

/**
 * A batched eth_getBlockByNumber, as a plain fetch of a JSON array.
 *
 * Returns the blocks it got, in order, skipping any the node answered with null: a block that is not
 * there yet is not an error, and neither is one an endpoint declines to serve. The caller decides
 * what a gap means, because only the caller knows whether it is at the head or in the past.
 */
export async function fetchBlocks(url: string, from: number, count: number): Promise<Block[]> {
  const batch = Array.from({ length: count }, (_, i) => ({
    jsonrpc: "2.0", id: i, method: "eth_getBlockByNumber",
    params: [`0x${(from + i).toString(16)}`, true],
  }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "augur/0.1 (+https://github.com/kingwilliamAI/Augur)" },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`blocks ${from}..${from + count - 1}: HTTP ${res.status}`);
  const body = await res.json() as Array<{ id: number; result: RawBlock | null; error?: { message: string } }>;
  if (!Array.isArray(body)) throw new Error("expected a JSON-RPC array");

  const out: Block[] = [];
  for (const entry of body.sort((a, b) => a.id - b.id)) {
    const b = entry.result;
    if (!b) continue;
    out.push({
      number: Number(BigInt(b.number)),
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: Number(BigInt(b.timestamp)),
      // Some nodes name the calldata field `input` and some `data`; both appear in the wild and an
      // undefined here would silently turn every contract call into a plain transfer.
      transactions: (b.transactions ?? []).map((t) => ({
        hash: t.hash,
        from: (t.from ?? "").toLowerCase(),
        to: t.to ? t.to.toLowerCase() : null,
        value: t.value ?? "0x0",
        input: t.input ?? t.data ?? "0x",
      })),
    });
  }
  return out;
}

/**
 * Whether a run of blocks is actually a chain.
 *
 * Nothing in this project has ever checked. The database documents that Arbitrum Nitro can
 * reorganise recent blocks and provides rollbackFrom for it, and nothing calls it: the log indexers
 * survive on upsert-by-primary-key, so a replayed block overwrites rather than duplicates. A body
 * reader has no such luck — a native transfer has no natural key, so the same transfer read twice on
 * two sides of a reorg would be two rows.
 *
 * The check is free, because the body already carries both hashes.
 */
export function chainBreak(blocks: Block[], expectedParent?: string): number | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i === 0) {
      if (expectedParent && b.parentHash !== expectedParent) return b.number;
      continue;
    }
    const prev = blocks[i - 1];
    if (b.number !== prev.number + 1 || b.parentHash !== prev.hash) return b.number;
  }
  return null;
}

export type TailState = {
  /** The next block to read. */
  cursor: number;
  /** The hash of the block before the cursor, so the first batch of a run can be checked too. */
  parentHash?: string;
};

export type TailOptions = {
  /** Where the head is right now. Injected so the loop can be driven without a network in a test. */
  head: () => Promise<number>;
  /** Reads a run of blocks. Defaults to a batched fetch against the logs endpoint. */
  read?: (from: number, count: number) => Promise<Block[]>;
  /** Called with every contiguous, verified block, in order. */
  onBlock: (b: Block) => void | Promise<void>;
  /** Called when the chain read does not match what was read before, with the block it broke at. */
  onReorg?: (atBlock: number) => void | Promise<void>;
  /** Called after each batch with the new state, so the caller can checkpoint it. */
  onProgress?: (state: TailState, blocks: number) => void | Promise<void>;
  onStatus?: (msg: string) => void;
  /**
   * How far behind the head to stay.
   *
   * Not a safety margin against reorgs — the chain check handles those — but against reading a block
   * the node has only half-published. Six blocks is under a second here.
   */
  lag?: number;
  /** Stops the loop. Anything that returns true ends it after the current batch. */
  stop?: () => boolean;
};

/**
 * Follows the head, batch by batch, forever.
 *
 * Pacing is deliberate rather than maximal. The endpoint that serves bodies is the one that serves
 * the watcher's logs, and the watcher's latency is the product: half of all graduations happen
 * within two minutes of the launch, so a scanner that wins a race against it for RPC budget has
 * broken the thing it was added to support. When it falls behind, it catches up at a walk.
 */
export async function runTail(opts: TailOptions, state: TailState): Promise<void> {
  const status = opts.onStatus ?? ((m: string) => console.log(m));
  const read = opts.read ?? ((from, count) => fetchBlocks(CFG.httpUrl, from, count));
  const lag = opts.lag ?? 6;
  let parentHash = state.parentHash;
  let cursor = state.cursor;
  let idleSince = 0;

  for (;;) {
    if (opts.stop?.()) return;

    let head: number;
    try {
      head = await opts.head();
    } catch {
      await sleep(2000);
      continue;
    }

    const target = head - lag;
    if (cursor > target) {
      // Caught up. The chain makes about ten blocks a second, so a short sleep here is a full batch
      // of work later rather than an idle loop.
      if (!idleSince) idleSince = Date.now();
      await sleep(CFG.tailIdleMs);
      continue;
    }
    idleSince = 0;

    const count = Math.min(BATCH, target - cursor + 1);
    let blocks: Block[];
    try {
      blocks = await read(cursor, count);
    } catch (e) {
      status(`tail: ${(e as Error).message}`);
      await sleep(CFG.tailBackoffMs);
      continue;
    }

    if (!blocks.length) {
      // The node has nothing for a range it should have. Waiting beats spinning: at the head this is
      // a block not yet published, and behind it this is an endpoint declining to serve.
      await sleep(CFG.tailBackoffMs);
      continue;
    }

    const broke = chainBreak(blocks, parentHash);
    if (broke !== null) {
      await opts.onReorg?.(broke);
      // Rewind to the break rather than to the start of the batch: everything before it was checked
      // against a parent that still holds.
      cursor = Math.max(0, broke - 1);
      parentHash = undefined;
      status(`tail: chain broke at ${broke}, rewound`);
      continue;
    }

    for (const b of blocks) await opts.onBlock(b);

    const last = blocks[blocks.length - 1];
    cursor = last.number + 1;
    parentHash = last.hash;
    await opts.onProgress?.({ cursor, parentHash }, blocks.length);
  }
}
