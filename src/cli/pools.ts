import { logsClient, withRetry } from "../chain.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { indexPoolSwaps, resolvePoolsSweep } from "../pool.ts";
import { quoteFromCache } from "../quote.ts";

/**
 * Follows graduated tokens into the pool.
 *
 * Two jobs, in order. First the `Initialize` stream is swept chain-wide, keeping only pools carrying
 * the pons hook and matching each against a token we know. Then the swap stream is read the same
 * way, which covers every known pool in one pass.
 *
 * The order matters: a pool discovered after the stream has already passed its blocks would have no
 * history, so resolution runs first and the stream starts no later than the oldest pool it must
 * cover.
 *
 * augur pools [--init-chunk N] [--chunk N] [--max-blocks N] [--spacing MS]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};

const initChunk = arg("init-chunk", 40_000);
const chunk = arg("chunk", 2000);
const maxBlocks = arg("max-blocks", 60_000);
// Deliberately unhurried: this is background work, and going flat out earned a 403 that refused
// everything, including the one curve a reader was waiting on.
const spacing = arg("spacing", 250);

const db = openDb();
const head = Number(await withRetry(() => logsClient.getBlockNumber()));

/* ── 1. give every graduated token its pool ─────────────────────────────────── */

/**
 * One sweep of Initialize across the chain, not one search per token.
 *
 * The pons hook identifies our pools, and every pool on the chain is opened through the same
 * singleton, so a chunk of that stream carries whatever graduated in those blocks. Chunks here are
 * far wider than the swap pass uses: Initialize is rare where Swap is not, and 40,000 blocks
 * measured 541 events against the endpoint's 10,000-log ceiling.
 */
const oldestGrad = db.prepare(
  "SELECT min(l.block) b FROM graduations g JOIN launches l USING(token)",
).get() as { b: number | null };

if (oldestGrad.b === null) {
  console.log("no graduations on record yet; nothing to resolve");
} else {
  const savedInit = Number(getMeta(db, "pool_init_to_block") ?? 0);
  const initFrom = savedInit > 0 ? savedInit + 1 : oldestGrad.b;
  const before = (db.prepare("SELECT count(*) c FROM pools").get() as { c: number }).c;

  if (initFrom > head) {
    console.log(`${before} pools known; Initialize already swept to ${savedInit.toLocaleString()}`);
  } else {
    const span = head - initFrom + 1;
    console.log(
      `${before} pools known; sweeping Initialize over ${span.toLocaleString()} blocks ` +
      `(${initFrom.toLocaleString()}..${head.toLocaleString()}) in ${initChunk.toLocaleString()}-block chunks`,
    );
    const t = Date.now();
    const sweep = await resolvePoolsSweep(
      db, initFrom, head, initChunk,
      (pairToken) => quoteFromCache(db, pairToken).decimals,
      (upTo, found) => {
        const done = upTo - initFrom + 1;
        const pct = (100 * done / span).toFixed(1);
        process.stdout.write(`
  ${pct}%  ${found} pools found  `);
      },
    );
    setMeta(db, "pool_init_to_block", String(head));
    console.log(`
  ${sweep.found} pools found in ${sweep.chunks} reads, ${((Date.now() - t) / 1000).toFixed(1)}s${" ".repeat(20)}`);

    const still = db.prepare(`
      SELECT count(*) c FROM graduations g JOIN launches l USING(token)
      WHERE l.token NOT IN (SELECT token FROM pools)`).get() as { c: number };
    const grads = (db.prepare("SELECT count(*) c FROM graduations").get() as { c: number }).c;
    if (still.c) {
      console.log(`  ${still.c} of ${grads} graduated tokens still have no pons pool (${(100 * still.c / grads).toFixed(1)}%)`);
    }
  }
}

/* ── 2. read the swap stream ────────────────────────────────────────────────── */

const oldest = db.prepare("SELECT min(init_block) b FROM pools").get() as { b: number | null };
if (oldest.b === null) { console.log("\nno pools to follow yet"); db.close(); process.exit(0); }

/**
 * Where to resume, from the range already covered rather than from a single mark.
 *
 * The stream is contiguous, so what matters is the whole interval it has read, not just its end.
 * Clamping the start to the oldest pool on every run looked like caution and was the opposite: the
 * oldest pool never moves, so the minimum was always that block and the checkpoint could never take
 * effect. Every restart began the six-million-block sweep again from the beginning, which meant a
 * pass measured in hours had to survive in a single attempt to leave anything behind at all.
 *
 * Both ends are kept now. A pool discovered below the covered range still forces a restart from its
 * own beginning, which was the real worry; anything else continues from where reading stopped.
 */
const savedTo = Number(getMeta(db, "pool_swaps_to_block") ?? 0);
const savedFrom = Number(getMeta(db, "pool_swaps_from_block") ?? 0);

const belowCovered = savedFrom > 0
  ? (db.prepare("SELECT min(init_block) b FROM pools WHERE init_block < ?").get(savedFrom) as { b: number | null }).b
  : null;

const from = savedTo === 0 ? oldest.b
  : belowCovered !== null ? belowCovered
  : savedTo + 1;

if (belowCovered !== null) {
  console.log(`  covered range began at ${savedFrom.toLocaleString()}, but a pool opens at ${belowCovered.toLocaleString()}; restarting there`);
}
const to = Math.min(head, from + maxBlocks - 1);

console.log(`\nreading pool swaps, blocks ${from.toLocaleString()}..${to.toLocaleString()} (head ${head.toLocaleString()}, ${(head - to).toLocaleString()} behind)`);
// The covered range keeps its original start unless this run reaches below it.
setMeta(db, "pool_swaps_from_block", String(savedFrom > 0 && from > savedFrom ? savedFrom : from));
const t0 = Date.now();
// Checkpointed per chunk rather than at the end. This pass covers millions of blocks and takes over
// an hour; recording progress only on success meant an interruption at minute eighty threw away
// eighty minutes of reading, and the peaks written along the way had no record saying so.
const r = await indexPoolSwaps(db, from, to, chunk, (upTo, swaps) => {
  setMeta(db, "pool_swaps_to_block", String(upTo));
  const done = upTo - from + 1, span = to - from + 1;
  process.stdout.write(`\r  ${(100 * done / span).toFixed(1)}%  ${swaps.toLocaleString()} swaps  `);
}, spacing);
const secs = (Date.now() - t0) / 1000;

setMeta(db, "pool_swaps_to_block", String(to));
console.log(`  ${r.swaps.toLocaleString()} swaps seen, ${r.matched.toLocaleString()} in tracked pools, ${r.chunks} reads, ${secs.toFixed(1)}s`);
console.log(`  ${(db.prepare("SELECT count(*) c FROM pool_peaks").get() as { c: number }).c} pools now have a recorded peak`);
if (to < head) console.log(`\n  still ${(head - to).toLocaleString()} blocks behind; run again to continue`);

db.close();
