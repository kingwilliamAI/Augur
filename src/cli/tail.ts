import { logsClient, withRetry } from "../chain.ts";
import { CFG } from "../config.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { runTail, type Block } from "../blocktail.ts";
import { freshAt, fundingsIn, saveFunding } from "../fundings.ts";

/**
 * augur tail — full block bodies, close behind the head.
 *
 * A third long-running process beside the watcher and the board, and it is separate on purpose. It
 * reads from the same endpoint the watcher's eth_getLogs depends on, and the watcher's latency is
 * the product: half of all graduations happen within two minutes of the launch. Sharing a process
 * would mean sharing the module-level request gate and a single-threaded event loop with the one
 * path in this project that must never wait, so this pays for its own pacing instead.
 *
 * It is forward-only, and that is a limit rather than a choice. Whether a wallet was brand new when
 * it was funded is a question about state at a past block, and neither public endpoint answers that
 * more than about ten minutes back. A history sweep could read the transfers and could never tell
 * which of them were to fresh wallets, so there is no backfill: it knows what it has watched.
 *
 * augur tail [--from N] [--once] [--quiet]
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const ONCE = argv.includes("--once");
const QUIET = argv.includes("--quiet");

const db = openDb();

const CURSOR_KEY = "tail_cursor_block";
const PARENT_KEY = "tail_parent_hash";

const head = async (): Promise<number> => Number(await withRetry(() => logsClient.getBlockNumber()));

/** One JSON-RPC call for the freshness check, against the endpoint that answers recent state. */
const rpc = async (method: string, params: unknown[]): Promise<string | null> => {
  const r = await withRetry(() => logsClient.request({ method, params } as never)) as string | null;
  return r ?? null;
};

const startAt = arg("from", 0);
let cursor = startAt || Number(getMeta(db, CURSOR_KEY) ?? 0);
if (!cursor) {
  cursor = await head();
  if (!QUIET) console.log(`no cursor yet, starting at the head: ${cursor.toLocaleString()}`);
}

let seen = 0;
let kept = 0;
let lastBeat = 0;
let lastLog = 0;

console.log("augur tail — native transfers into wallets that matter");
console.log(`  bodies from ${CFG.httpUrl}`);
console.log(`  freshness is only knowable within ${CFG.freshWindowBlocks.toLocaleString()} blocks of the head`);
console.log(`  starting at ${cursor.toLocaleString()}\n`);

let headNow = cursor;

async function onBlock(b: Block): Promise<void> {
  seen++;
  for (const f of fundingsIn(db, b)) {
    // Asked only for the transfers being kept, which is a few thousand a day rather than the
    // 445,000 that pass through: two extra reads per kept row, and none at all for the rest.
    f.fresh = await freshAt(rpc, f.wallet, f.block, headNow).then((v) => (v === null ? null : v ? 1 : 0));
    saveFunding(db, f);
    kept++;
    if (!QUIET) {
      const eth = Number(BigInt(f.wei)) / 1e18;
      console.log(`  ${new Date(f.ts * 1000).toISOString().slice(11, 19)}  ${f.funder.slice(0, 10)}…`
        + ` → ${f.wallet.slice(0, 10)}…  ${eth.toFixed(4)} ETH${f.fresh === 1 ? "  fresh" : ""}`);
    }
  }
}

process.on("SIGINT", () => {
  setMeta(db, CURSOR_KEY, String(cursor));
  db.close();
  process.exit(0);
});

await runTail({
  head: async () => {
    headNow = await head();
    const now = Date.now();
    // A heartbeat on its own clock, named to match the watcher's so the board and the watchdog can
    // read it without being taught a second vocabulary.
    if (now - lastBeat > 5000) {
      lastBeat = now;
      setMeta(db, "tail_head_block", String(headNow));
      setMeta(db, "tail_seen_at", String(Math.floor(now / 1000)));
    }
    return headNow;
  },
  onBlock,
  onReorg: (at) => {
    // A body reader cannot shrug a reorg off the way the log indexers do: a native transfer has no
    // natural key beyond its transaction, and a transaction that was reorganised out never happened.
    const gone = db.prepare("DELETE FROM fundings WHERE block >= ?").run(at);
    console.log(`  reorg at ${at.toLocaleString()}: dropped ${gone.changes} funding row(s)`);
  },
  onProgress: (state) => {
    cursor = state.cursor;
    // Checkpointed every batch rather than at the end of a run: a pass measured in hours that saves
    // only on success throws away everything when it is interrupted at minute eighty.
    setMeta(db, CURSOR_KEY, String(state.cursor));
    if (state.parentHash) setMeta(db, PARENT_KEY, state.parentHash);
    if (!QUIET && Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const behind = Math.max(0, headNow - state.cursor);
      console.log(`  ${state.cursor.toLocaleString()} · ${behind} behind · ${seen.toLocaleString()} blocks read · ${kept.toLocaleString()} kept`);
    }
    if (ONCE && seen >= 100) throw new Error("--once: stop after a hundred blocks");
  },
  onStatus: (m) => { if (!QUIET) console.log(`  ${m}`); },
  stop: () => ONCE && seen >= 100,
}, { cursor, parentHash: getMeta(db, PARENT_KEY) ?? undefined });

setMeta(db, CURSOR_KEY, String(cursor));
console.log(`\nread ${seen.toLocaleString()} blocks, kept ${kept.toLocaleString()} funding row(s)`);
db.close();
