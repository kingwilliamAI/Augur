import { logsClient, withRetry } from "../chain.ts";
import { CFG } from "../config.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { feeLedger, indexEscrow, indexSplits, readSplitConfig } from "../fees.ts";

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
if (!launch.creator_fee_recipient) {
  console.error("the launch has no fee recipient on record. Run: npm run enrich-window");
  db.close();
  process.exit(1);
}

const recipient = launch.creator_fee_recipient.toLowerCase();
const head = Number(await withRetry(() => logsClient.getBlockNumber()));
const stored = Number(getMeta(db, "fees_to_block") ?? 0);
const from = arg("from", stored > 0 ? stored + 1 : launch.block);
const chunk = arg("chunk", CFG.logsChunk);

console.log(`fee recipient  ${recipient}`);
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
for (let start = from; start <= head; start += chunk) {
  const to = Math.min(head, start + chunk - 1);
  const c = await indexEscrow(db, recipient, start, to);
  credited += c.credited;
  claimed += c.claimed;
  if (CFG.feeSplitter) splits += await indexSplits(db, CFG.feeSplitter, start, to);
  setMeta(db, "fees_to_block", String(to));
  process.stdout.write(`\r  ${to.toLocaleString()} / ${head.toLocaleString()}  ${credited} credits, ${claimed} claims, ${splits} splits   `);
}

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
