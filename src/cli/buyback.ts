import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buyCalldata, findOutput, planBuy, poolKeyFor, ROUTER_ABI, sizeBuy } from "../buyback.ts";
import { robinhood, sleep } from "../chain.ts";
import { CFG, EXPLORER } from "../config.ts";
import { openDb } from "../db.ts";
import { format, parseUnits, seconds } from "../payout.ts";

/**
 * augur buyback — spends the buyback wallet on the token, through the pool it graduated into.
 *
 * The second of the two commands here that sign, and the one that trades. Like the payout it dry
 * runs by default, refuses more often than it acts, and writes to the ledger only what was mined.
 *
 * Every run asks the chain what the swap would return before deciding anything: a simulated call
 * that demands more than the pool would pay reverts, so a search over that floor finds the real
 * price through the hook's fee and the ticks, without a quoter contract or a price feed. The floor
 * that finally goes on chain is that number less the slippage allowance, which is what makes a
 * sandwiched fill revert instead of settling.
 *
 * The tokens stay in the buyback wallet. Burning them, locking them or holding them is a separate
 * decision and a separate transaction, and this tool deliberately has no opinion about it.
 *
 *   npm run buyback                     what it would buy, and at what price
 *   npm run buyback -- --send           sign and broadcast it
 *   npm run buyback -- --max 0.05 --send   cap this run
 *   npm run buyback -- --every 3h --send   keep doing it, with jitter
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SEND = argv.includes("--send");
const MAX = flag("max");
const EVERY = flag("every");
const JITTER = flag("jitter") ?? "20m";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const db = openDb();
const rpc = CFG.buyback.rpcUrl || CFG.httpUrl;
const reader = createPublicClient({ chain: robinhood, transport: http(rpc) });
const KEY = process.env.BUYBACK_PRIVATE_KEY?.trim();
const TOKEN = (CFG.buyback.token || CFG.coinToken) as Address;
const ROUTER = CFG.buyback.router as Address;

async function once(account: ReturnType<typeof privateKeyToAccount> | null): Promise<void> {
  if (!TOKEN) {
    console.error("no token to buy: set COIN_TOKEN, or BUYBACK_TOKEN if it is a different one.");
    process.exitCode = 1;
    return;
  }
  const wallet = account?.address.toLowerCase() ?? "";
  if (!wallet) {
    console.error(`no wallet to spend.

Set BUYBACK_PRIVATE_KEY in .env: it is the wallet the payout sends the buyback share to,
and it should hold nothing else.`);
    process.exitCode = 1;
    return;
  }

  const [decimals, symbol, balance] = await Promise.all([
    reader.readContract({ address: TOKEN, abi: erc20, functionName: "decimals" }).then(Number),
    reader.readContract({ address: TOKEN, abi: erc20, functionName: "symbol" }).then(String),
    reader.getBalance({ address: wallet as Address }),
  ]);

  /**
   * The two halves have to name the same wallet.
   *
   * The payout sends the buyback share to PAYOUT_BUYBACK and this command spends whatever is under
   * BUYBACK_PRIVATE_KEY. If those are different addresses the money piles up somewhere this cannot
   * reach while this one buys with whatever happens to be lying in the other, and both halves look
   * like they are working. Said once, loudly, rather than left to be discovered from a balance.
   */
  if (CFG.payout.buyback && CFG.payout.buyback !== wallet) {
    console.log(`warning: the payout sends the buyback share to ${CFG.payout.buyback},`);
    console.log(`         and this key is ${wallet}. One of the two is wrong.\n`);
  }

  const key = poolKeyFor(TOKEN);
  const reserve = parseUnits(CFG.buyback.reserveEth, 18);
  const minimum = parseUnits(CFG.buyback.minimumEth, 18);
  const cap = MAX ? parseUnits(MAX, 18) : undefined;

  console.log(`wallet     ${wallet}`);
  console.log(`buying     ${symbol}  ${TOKEN}`);
  console.log(`pool       fee ${key.fee}, spacing ${key.tickSpacing}, hook ${key.hooks}`);
  console.log(`balance    ${format(balance, 18)} ETH   reserve ${format(reserve, 18)} ETH`);

  // The size first, so the simulation asks about the amount that would really be sent.
  const sizing = sizeBuy({ balance, reserve, minimum, max: cap });
  if (!sizing.ok) {
    console.log(`\nnothing to do: ${sizing.reason}.`);
    return;
  }

  /**
   * One simulated swap. A revert is an answer, not a failure: it means the pool would not pay that
   * much, which is exactly what the search is asking.
   */
  const probe = async (minOut: bigint): Promise<boolean> => {
    const { args, value } = buyCalldata(key, sizing.spend, minOut);
    try {
      await reader.simulateContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "execute", args, value, account: account as never });
      return true;
    } catch {
      return false;
    }
  };

  process.stdout.write("\nasking the pool what it pays… ");
  const expected = await findOutput(sizing.spend, probe);
  console.log(`${format(expected, decimals)} ${symbol}`);

  const plan = planBuy({ balance, reserve, minimum, max: cap, expected, slippageBps: CFG.buyback.slippageBps, decimals });
  if (!plan.ok) {
    console.log(`\nnothing to do: ${plan.reason}.`);
    return;
  }

  console.log(`\nspend      ${format(plan.spend, 18)} ETH`);
  console.log(`expect     ${format(plan.expected, decimals)} ${symbol}`);
  console.log(`floor      ${format(plan.minOut, decimals)} ${symbol}   (${CFG.buyback.slippageBps / 100}% slippage allowed)`);
  console.log(`price      ${plan.pricePerToken.toExponential(3)} ETH per ${symbol}`);

  if (!SEND) {
    console.log("\ndry run. Nothing was signed and nothing moved; add --send to broadcast this.");
    return;
  }

  const { args, value } = buyCalldata(key, plan.spend, plan.minOut);
  try {
    const hash = await createWalletClient({ account: account as never, chain: robinhood, transport: http(rpc) })
      .writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "execute", args, value });
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") {
      console.error(`\nreverted: ${EXPLORER.tx(hash)}`);
      process.exitCode = 1;
      return;
    }

    // What actually arrived, from the token's own Transfer log rather than from the estimate.
    let received = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== TOKEN.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: erc20, topics: log.topics, data: log.data });
        const a = ev.args as unknown as { to: string; value: bigint };
        if (ev.eventName === "Transfer" && a.to.toLowerCase() === wallet) received += a.value;
      } catch { /* another token's log in the same transaction */ }
    }

    db.prepare(`INSERT INTO buybacks (tx, wallet, token, spent_wei, spent_eth, received, min_out, price_eth, block, ts)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx) DO NOTHING`).run(
      hash, wallet, TOKEN.toLowerCase(), plan.spend.toString(), Number(plan.spend) / 1e18,
      received.toString(), plan.minOut.toString(),
      received > 0n ? Number(plan.spend) / 1e18 / (Number(received) / 10 ** decimals) : 0,
      Number(receipt.blockNumber), Math.floor(Date.now() / 1000),
    );

    console.log(`\nbought     ${format(received, decimals)} ${symbol}`);
    if (received > 0n && received <= plan.minOut) {
      console.log("           that is the floor exactly, which is what a sandwiched fill looks like.");
    }
    console.log(`           ${EXPLORER.tx(hash)}`);
  } catch (err) {
    console.error(`\nthe swap did not go through: ${(err as Error).message.slice(0, 200)}`);
    console.error("the balance is untouched apart from gas; the next run tries again.");
    process.exitCode = 1;
  }
}

/**
 * The loop, with the interval deliberately fuzzed.
 *
 * A buy of a predictable size at a predictable minute is the easiest thing on a chain to trade
 * ahead of, and this one would be announced by its own regularity. Jitter is not a fix for that, it
 * is the cheap half of one: the other half is the floor, which makes being front-run expensive
 * rather than free.
 */
async function loop(account: ReturnType<typeof privateKeyToAccount> | null, everySec: number, jitterSec: number): Promise<void> {
  console.log(`every ${everySec}s, give or take ${jitterSec}s\n`);
  for (;;) {
    try {
      await once(account);
    } catch (err) {
      console.error(`run failed: ${(err as Error).message.slice(0, 160)}`);
    }
    const wait = Math.max(30, everySec + Math.round((Math.random() * 2 - 1) * jitterSec));
    console.log(`\nnext run in ${(wait / 60).toFixed(1)} min\n${"─".repeat(60)}`);
    await sleep(wait * 1000);
  }
}

try {
  const account = KEY ? privateKeyToAccount(KEY as `0x${string}`) : null;
  if (EVERY && seconds(EVERY) < 60) {
    // A misread interval would turn a buy every three hours into one a minute, each paying gas and
    // each moving the price against the next.
    console.error(`"--every ${EVERY}" is not an interval this understands. Try 3h, 90m or 45s.`);
    process.exitCode = 1;
  } else if (EVERY) await loop(account, seconds(EVERY), seconds(JITTER));
  else await once(account);
} finally {
  db.close();
}
