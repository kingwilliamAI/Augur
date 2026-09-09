import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { planBurn } from "../buyback.ts";
import { robinhood } from "../chain.ts";
import { CFG, EXPLORER } from "../config.ts";
import { openDb } from "../db.ts";
import { format, parseUnits } from "../payout.ts";

/**
 * augur burn — destroys tokens the buyback wallet holds.
 *
 * Two ways of "burning" get confused, and only one of them is real. Sending to a dead address parks
 * the tokens at a key nobody has and leaves `totalSupply` exactly where it was; this token also
 * refuses transfers to the zero address outright, which is the wall most people hit first. Calling
 * `burn` removes the tokens from the supply, and the supply is a number anybody can read back off
 * the contract afterwards. That difference is the whole point of the command.
 *
 * It is the most irreversible thing in this repository, so it dry runs by default like the other
 * two, prints what the supply would become, and only acts on --send.
 *
 *   npm run burn                     what it would destroy, and what supply is left
 *   npm run burn -- --send           do it, for the whole balance
 *   npm run burn -- --amount 1000000 --send   destroy part of it
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SEND = argv.includes("--send");
const AMOUNT = flag("amount");

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function burn(uint256 amount)",
]);

const db = openDb();
const rpc = CFG.buyback.rpcUrl || CFG.httpUrl;
const reader = createPublicClient({ chain: robinhood, transport: http(rpc) });
const KEY = process.env.BUYBACK_PRIVATE_KEY?.trim();
const TOKEN = (CFG.buyback.token || CFG.coinToken) as Address;

async function main(): Promise<void> {
  const account = KEY ? privateKeyToAccount(KEY as `0x${string}`) : null;
  if (!account) {
    console.error(`no wallet to burn from.

Set BUYBACK_PRIVATE_KEY in .env: burning spends from the wallet that holds the tokens, which is
the one the payout funds and the buyback buys with.`);
    process.exitCode = 1;
    return;
  }
  const wallet = account.address as Address;

  const [decimals, symbol, balance, supply] = await Promise.all([
    reader.readContract({ address: TOKEN, abi, functionName: "decimals" }).then(Number),
    reader.readContract({ address: TOKEN, abi, functionName: "symbol" }).then(String),
    reader.readContract({ address: TOKEN, abi, functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
    reader.readContract({ address: TOKEN, abi, functionName: "totalSupply" }) as Promise<bigint>,
  ]);

  const plan = planBurn({
    balance,
    supply,
    minimum: parseUnits("1", decimals),
    amount: AMOUNT ? parseUnits(AMOUNT, decimals) : undefined,
  });

  const n = (v: bigint): string => format(v, decimals, 2);
  console.log(`wallet     ${wallet.toLowerCase()}`);
  console.log(`token      ${symbol}  ${TOKEN}`);
  console.log(`holds      ${n(balance)} ${symbol}`);
  console.log(`supply     ${n(supply)} ${symbol}`);

  if (!plan.ok) {
    console.log(`\nnothing to do: ${plan.reason}.`);
    return;
  }

  console.log(`\nburning    ${n(plan.amount)} ${symbol}   ${(100 * plan.shareOfSupply).toFixed(3)}% of the supply`);
  console.log(`leaves     ${n(supply - plan.amount)} ${symbol}`);

  if (!SEND) {
    console.log("\ndry run. Nothing was signed and nothing was destroyed; add --send to do it.");
    console.log("This cannot be undone, and no part of it can be recovered afterwards.");
    return;
  }

  /**
   * Simulated first, and not as a formality.
   *
   * A token without a burn function, a balance that moved between the read and the send, or a
   * transfer restriction all fail here for free rather than costing gas to discover.
   */
  try {
    await reader.simulateContract({ address: TOKEN, abi, functionName: "burn", args: [plan.amount], account });
  } catch (err) {
    console.error(`\nthe burn would not go through: ${(err as Error).message.slice(0, 200)}`);
    console.error("nothing was sent.");
    process.exitCode = 1;
    return;
  }

  try {
    const hash = await createWalletClient({ account, chain: robinhood, transport: http(rpc) })
      .writeContract({ address: TOKEN, abi, functionName: "burn", args: [plan.amount] });
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") {
      console.error(`\nreverted: ${EXPLORER.tx(hash)}`);
      process.exitCode = 1;
      return;
    }

    // The supply the contract reports now, not the one this command predicted.
    const after = await reader.readContract({ address: TOKEN, abi, functionName: "totalSupply" }) as bigint;
    db.prepare(`INSERT INTO burns (tx, wallet, token, amount, supply_after, block, ts)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(tx) DO NOTHING`).run(
      hash, wallet.toLowerCase(), TOKEN.toLowerCase(), plan.amount.toString(), after.toString(),
      Number(receipt.blockNumber), Math.floor(Date.now() / 1000),
    );

    console.log(`\nburned     ${n(plan.amount)} ${symbol}`);
    console.log(`supply     ${n(after)} ${symbol}   as the contract reports it`);
    console.log(`           ${EXPLORER.tx(hash)}`);
  } catch (err) {
    console.error(`\nthe burn did not go through: ${(err as Error).message.slice(0, 200)}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  db.close();
}
