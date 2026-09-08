import { decodeEventLog, decodeFunctionData, parseAbi } from "viem";
import { curveAbi, routerAbi, TOPIC } from "./abi.ts";
import { ADDR } from "./config.ts";
import { stateClient, withRetry } from "./chain.ts";
import { toEth, type DB } from "./db.ts";
import { normaliseName } from "./features.ts";

/**
 * Facts that only the launch transaction holds.
 *
 * The `TokenLaunched` event's `deployer` is whoever called the factory, which is frequently a
 * batching contract: Multicall3 alone accounts for the single largest "deployer" in a day. The
 * human behind a launch is the transaction sender, so the card reads `tx.from` and treats the
 * event's deployer as the calling contract.
 */
export type LaunchDetail = {
  token: string;
  sender: string;
  routedThroughRouter: boolean;
  name?: string;
  symbol?: string;
  description?: string;
  socials?: Record<string, string>;
  creatorFeeRecipient?: string;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
  initialBuyWei?: bigint;
  exemptions: string[];
  coBuyers: Array<{ recipient: string; quoteWei: bigint; taxWei: bigint }>;
};

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

/**
 * Name and ticker straight from the token contract.
 *
 * Roughly half of launches do not go through the pons router, so the creator's declared parameters
 * cannot be read out of the calldata — and that is where the name used to come from, which left
 * half the board reading "?". The contract itself always knows: these are plain ERC-20 getters, and
 * the state client batches concurrent reads into one multicall.
 *
 * This is a display fact only. It is deliberately not fed to the model: a name readable here but not
 * in the calldata would be knowable at different times for different launches, which is exactly the
 * kind of asymmetry that quietly leaks.
 */
export async function readTokenIdentity(token: string): Promise<{ name?: string; symbol?: string }> {
  const address = token as `0x${string}`;
  const [n, s] = await Promise.allSettled([
    withRetry(() => stateClient.readContract({ address, abi: erc20, functionName: "name" })),
    withRetry(() => stateClient.readContract({ address, abi: erc20, functionName: "symbol" })),
  ]);
  return {
    name: n.status === "fulfilled" ? String(n.value).slice(0, 128) : undefined,
    symbol: s.status === "fulfilled" ? String(s.value).slice(0, 32) : undefined,
  };
}

export async function fetchLaunchDetail(token: string, txHash: string, deep = true): Promise<LaunchDetail> {
  // Both reads go to the state endpoint on purpose. Only the other endpoint serves eth_getLogs, and
  // an enrichment pass is tens of thousands of calls: sharing it starves the live watcher into 429s
  // and loses launches. publicnode serves transactions and receipts happily, and about three times
  // faster besides.
  const tx = await withRetry(() => stateClient.getTransaction({ hash: txHash as `0x${string}` }));
  const detail: LaunchDetail = {
    token: token.toLowerCase(),
    sender: tx.from.toLowerCase(),
    routedThroughRouter: (tx.to ?? "").toLowerCase() === ADDR.router.toLowerCase(),
    exemptions: [],
    coBuyers: [],
  };

  // Launches that go through the router carry the creator's declared intent in the calldata.
  // Launches that do not (batched through another contract) still give us the sender and the logs.
  try {
    const d = decodeFunctionData({ abi: routerAbi, data: tx.input });
    if (d.functionName === "launchAndBuy") {
      const [params, , , quoteIn, , , exemptions] = d.args as [
        { name: string; symbol: string; description: string; socials: Record<string, string>;
          creatorFeeRecipient: string; creatorTaxBps: number; buybackEnabled: boolean },
        bigint, string, bigint, bigint, string, readonly string[],
      ];
      detail.name = params.name;
      detail.symbol = params.symbol;
      detail.description = params.description;
      detail.socials = { ...params.socials };
      detail.creatorFeeRecipient = params.creatorFeeRecipient.toLowerCase();
      detail.creatorTaxBps = Number(params.creatorTaxBps);
      detail.buybackEnabled = Boolean(params.buybackEnabled);
      detail.initialBuyWei = quoteIn;
      detail.exemptions = exemptions.map((a) => a.toLowerCase());
    }
  } catch {
    // Not a router call we can decode; the sender and log-derived facts still stand.
  }

  // Launches outside the router carry no declared name, so ask the contract rather than showing "?".
  if (detail.symbol === undefined) {
    try {
      const id = await readTokenIdentity(token);
      detail.name = id.name;
      detail.symbol = id.symbol;
    } catch { /* an unreadable token keeps its unknown name */ }
  }

  if (deep) {
    const rc = await withRetry(() => stateClient.getTransactionReceipt({ hash: txHash as `0x${string}` }));
    for (const log of rc.logs) {
      if (log.topics[0] !== TOPIC.curveBuy) continue;
      try {
        const e = decodeEventLog({ abi: curveAbi, topics: log.topics, data: log.data });
        const a = e.args as { recipient: string; quoteIn: bigint; tax: bigint };
        detail.coBuyers.push({ recipient: a.recipient.toLowerCase(), quoteWei: a.quoteIn, taxWei: a.tax });
      } catch { /* not a curve buy we model */ }
    }
  }
  return detail;
}

export function saveLaunchDetail(db: DB, d: LaunchDetail): void {
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE launches SET
        launch_sender = ?, creator_fee_recipient = ?, creator_tax_bps = ?, buyback_enabled = ?,
        initial_buy_wei = ?, initial_buy_eth = ?, exempt_count = ?, name = ?, symbol = ?,
        symbol_key = ?, description = ?, socials_json = ?, enriched_at = ?
      WHERE token = ?`).run(
      d.sender,
      d.creatorFeeRecipient ?? null,
      d.creatorTaxBps ?? null,
      d.buybackEnabled === undefined ? null : d.buybackEnabled ? 1 : 0,
      d.initialBuyWei?.toString() ?? null,
      d.initialBuyWei === undefined ? null : toEth(d.initialBuyWei),
      d.exemptions.length,
      d.name ?? null,
      d.symbol ?? null,
      d.symbol ? normaliseName(d.symbol) || null : null,
      d.description ?? null,
      d.socials ? JSON.stringify(d.socials) : null,
      Math.floor(Date.now() / 1000),
      d.token,
    );
    const insEx = db.prepare("INSERT INTO exemptions(token,address) VALUES(?,?) ON CONFLICT DO NOTHING");
    for (const a of d.exemptions) insEx.run(d.token, a);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Enriches launches that have no detail yet, newest first. */
export async function enrichPending(
  db: DB, limit: number, deep = true, onEach?: (done: number, total: number) => void,
): Promise<number> {
  const rows = db.prepare(
    "SELECT token, tx FROM launches WHERE enriched_at IS NULL ORDER BY block DESC LIMIT ?",
  ).all(limit) as Array<{ token: string; tx: string }>;

  let done = 0;
  const workers = 4;
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        try {
          saveLaunchDetail(db, await fetchLaunchDetail(row.token, row.tx, deep));
        } catch {
          // Leave enriched_at null so a later pass retries this launch.
        }
        onEach?.(++done, rows.length);
      }
    }),
  );
  return done;
}
