import { logsClient, withRetry } from "../chain.ts";
import { CFG } from "../config.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { currentFeeRecipient, feeLedger, feeRecipients, indexEscrow, indexSplits, readSplitConfig } from "../fees.ts";

/**
 * augur fees — reads where the curve fee went.
 *
 * Two reads, both of public logs. The escrow says what the launch earned and what was taken out of
 * it; the splitter, once one is deployed and named in .env, says how each payout was divided. Run it
 * on a timer beside the nightly, or by hand before looking at the page.
 *
 * The cursor is kept in `meta` so a second run reads only what is new. Passing --from replays a
 * range: writes are keyed on the transaction and log index, so replaying corrects rather than
 * duplicates.
 *
 * augur fees [--from BLOCK] [--chunk BLOCKS]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};

const db = openDb();
const eth = (n: number): string => `${n.toFixed(4)} ETH`;

const coin = CFG.coinToken;
if (!coin) {
  console.error("no COIN_TOKEN set, so there is no launch whose fees to read.");
  db.close();
  process.exit(1);
}

const launch = db.prepare("SELECT block, creator_fee_recipient FROM launches WHERE token = ?").get(coin) as
  { block: number; creator_fee_recipient: string | null } | undefined;
if (!launch) {
  console.error(`${coin} is not in this database yet. Run: npm run setup`);
  db.close();
  process.exit(1);
}
const recipients = feeRecipients(db, coin);
if (!recipients.length) {
  console.error("the launch has no fee recipient on record. Run: npm run enrich-window");
  db.close();
  process.exit(1);
}

const recipient = currentFeeRecipient(db, coin)!;
const head = Number(await withRetry(() => logsClient.getBlockNumber()));
const stored = Number(getMeta(db, "fees_to_block") ?? 0);
const from = arg("from", stored > 0 ? stored + 1 : launch.block);
const chunk = arg("chunk", CFG.logsChunk);

console.log(`fee recipient  ${recipient}`);
for (const r of recipients.filter((r) => r.address !== recipient)) {
  console.log(`before that    ${r.address}   (from block ${r.fromBlock.toLocaleString()}, still read)`);
}
console.log(`splitter       ${CFG.feeSplitter || "not deployed yet (the fee lands on the wallet above)"}`);
console.log(`blocks         ${from.toLocaleString()} to ${head.toLocaleString()}\n`);

if (CFG.feeSplitter) {
  try {
    const cfg = await readSplitConfig(db, CFG.feeSplitter);
    const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;
    console.log(`split          server ${pct(cfg.serverBps)} · holders ${pct(cfg.holdersBps)} · buyback ${pct(cfg.buybackBps)}`);
    console.log(`               read from the contract, where it is immutable\n`);
  } catch (e) {
    console.log(`could not read the splitter's terms: ${(e as Error).message.slice(0, 80)}\n`);
  }
}

let credited = 0, claimed = 0, splits = 0;
/**
 * A chunk that will not read stops the run rather than ending it with a stack trace.
 *
 * One endpoint on this chain serves eth_getLogs and it answers a long sweep with 429s. The cursor is
 * written after every chunk that lands, so stopping is not losing anything: running the command
 * again carries on from the last block actually read. A ledger that gives up politely and resumes
 * beats one that dies loudly and starts over.
 *
 * Each recipient keeps its own cursor. A wallet that took the fee over last week must be read from
 * the block it took over, not from wherever the previous wallet's sweep had got to, and the shared
 * cursor below stays the one the page reports and the splitter reads by.
 */
const stopped = (start: number, err: unknown): void => {
  const why = (err as Error).message.includes("Too Many Requests")
    ? "the log endpoint is rate limiting"
    : (err as Error).message.slice(0, 100);
  console.log(`\n\nstopped at block ${start.toLocaleString()}: ${why}.`);
  console.log("nothing is lost: the cursor is saved, so running this again carries on from here.");
};
const progress = (to: number): void => {
  process.stdout.write(`\r  ${to.toLocaleString()} / ${head.toLocaleString()}  ${credited} credits, ${claimed} claims, ${splits} splits   `);
};

let complete = true;
for (const r of recipients) {
  const cursor = `fees_to_block:${r.address}`;
  const own = Number(getMeta(db, cursor) ?? 0);
  const begin = argv.includes("--from") ? from : own > 0 ? own + 1 : r.fromBlock;
  for (let start = begin; start <= head; start += chunk) {
    const to = Math.min(head, start + chunk - 1);
    try {
      const c = await indexEscrow(db, r.address, start, to);
      credited += c.credited;
      claimed += c.claimed;
    } catch (err) {
      stopped(start, err);
      complete = false;
      break;
    }
    setMeta(db, cursor, String(to));
    progress(to);
  }
  if (!complete) break;
}

if (complete && CFG.feeSplitter) {
  for (let start = from; start <= head; start += chunk) {
    const to = Math.min(head, start + chunk - 1);
    try {
      splits += await indexSplits(db, CFG.feeSplitter, start, to);
    } catch (err) {
      stopped(start, err);
      complete = false;
      break;
    }
    setMeta(db, "fees_to_block", String(to));
    progress(to);
  }
}
if (complete) setMeta(db, "fees_to_block", String(head));

const led = feeLedger(db);
console.log(`\n\ncredited   ${eth(led.credited.eth)} over ${led.credited.count} events`);
console.log(`claimed    ${eth(led.claimed.eth)} over ${led.claimed.count} events`);
console.log(`unclaimed  ${eth(led.unclaimed.eth)}`);
if (led.splits.count > 0) {
  console.log(`\nsplit      ${eth(led.splits.totalEth)} over ${led.splits.count} payouts`);
  console.log(`  server   ${eth(led.splits.serverEth)}`);
  console.log(`  holders  ${eth(led.splits.holdersEth)}`);
  console.log(`  buyback  ${eth(led.splits.buybackEth)}`);
} else if (CFG.feeSplitter) {
  console.log("\nno payouts yet: the splitter is deployed and has not been released.");
} else {
  console.log("\nno splitter deployed, so nothing has been divided yet. See DEPLOY.md.");
}
db.close();
