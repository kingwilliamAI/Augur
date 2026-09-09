import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood, sleep } from "../chain.ts";
import { CFG, EXPLORER } from "../config.ts";
import { openDb } from "../db.ts";
import { currentFeeRecipient } from "../fees.ts";
import { format, parseUnits, planPayout, seconds, type Destination } from "../payout.ts";

/**
 * augur payout — moves what the fee wallet holds into the three wallets it is meant to fund.
 *
 * This is the only command in the project that signs anything, and it exists on its own for exactly
 * that reason. The scanner, the board and the bot hold no key and never will: a reader running a
 * clone is never asked for one, and nothing they run can move a coin. This is the operator's own
 * tool, run by hand or by a timer on the machine that already holds the fee wallet.
 *
 * It refuses far more often than it sends. A dry run is the default and printing the plan is most of
 * what it does; `--send` is the only way to broadcast, and even then the shares must add up to a
 * whole, the three addresses must be set and distinct, a gas reserve stays behind, and a balance
 * below the floor waits for next time. Those rules live in `payout.ts`, which has no network in it.
 *
 * Nothing reaches the ledger until a transfer is mined, so the page shows what happened rather than
 * what was attempted.
 *
 *   npm run payout                          the plan, and nothing else
 *   npm run payout -- --send                sign and broadcast it
 *   npm run payout -- --asset 0x… --send    the same for a fee paid in a token
 *   npm run payout -- --max 1 --send        cap this run at 1 whole unit
 *   npm run payout -- --every 3h --send     keep splitting on that cadence
 */
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SEND = argv.includes("--send");
const ASSET = (flag("asset") ?? "").trim().toLowerCase();
const MAX = flag("max");
const EVERY = flag("every");
const JITTER = flag("jitter") ?? "0";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const db = openDb();
const rpc = CFG.payout.rpcUrl || CFG.httpUrl;
const reader = createPublicClient({ chain: robinhood, transport: http(rpc) });

/**
 * The key, read once and never printed.
 *
 * From the environment rather than from a prompt or a file this tool manages: .env is git-ignored,
 * the operator already keeps it there, and a tool that offers to store a key is a tool that has to
 * be trusted with one. A missing key is not an error worth a stack trace, it is the normal state of
 * every machine except one.
 */
const RAW_KEY = process.env.PAYOUT_PRIVATE_KEY?.trim();

const destinations = (): Destination[] => [
  { name: "nodes", address: CFG.payout.nodes, bps: CFG.payout.nodesBps },
  { name: "buyback", address: CFG.payout.buyback, bps: CFG.payout.buybackBps },
  { name: "team", address: CFG.payout.team, bps: CFG.payout.teamBps },
];

/**
 * Everything runs inside a function so that no path calls `process.exit` after a request.
 *
 * On Windows, exiting the process while an HTTP socket is still being torn down aborts node with a
 * libuv assertion, which turns a run that did its job into a failure in the logs and a red unit in
 * systemd. Returning instead lets the loop drain, which it does in well under a second.
 */
async function main(): Promise<void> {
  const asset = ASSET && ASSET !== "eth"
    ? {
      native: false as const,
      address: ASSET as Address,
      decimals: Number(await reader.readContract({ address: ASSET as Address, abi: erc20, functionName: "decimals" })),
      symbol: String(await reader.readContract({ address: ASSET as Address, abi: erc20, functionName: "symbol" })),
    }
    : {
      native: true as const,
      address: "0x0000000000000000000000000000000000000000" as Address,
      decimals: 18,
      symbol: "ETH",
    };

  /**
   * Whose wallet this is.
   *
   * With a key, the address it derives; without one, the fee recipient on record, so a dry run still
   * says something useful on a machine that holds no key at all. Looking at the plan somewhere far
   * away from the wallet is the normal way to decide whether to run it near one.
   */
  const account = RAW_KEY ? privateKeyToAccount(RAW_KEY as `0x${string}`) : null;
  const onRecord = currentFeeRecipient(db, CFG.coinToken);
  const source = (account?.address ?? onRecord ?? "").toLowerCase();

  if (!source) {
    console.error(`no wallet to read.

Set PAYOUT_PRIVATE_KEY in .env to run this, or run the backfill first so the fee recipient
of ${CFG.coinToken} is on record and the plan can be printed without a key.`);
    process.exitCode = 1;
    return;
  }

  const balance = asset.native
    ? await reader.getBalance({ address: source as Address })
    : await reader.readContract({
      address: asset.address, abi: erc20, functionName: "balanceOf", args: [source as Address],
    }) as bigint;

  // A token balance is not what gas is paid in, so the reserve belongs to a native run only. The
  // native balance is checked separately below, because a token transfer still costs gas.
  const reserve = asset.native ? parseUnits(CFG.payout.reserveEth, 18) : 0n;
  const plan = planPayout({
    source,
    destinations: destinations(),
    balance,
    reserve,
    minimum: parseUnits(CFG.payout.minimumEth, asset.decimals),
    max: MAX ? parseUnits(MAX, asset.decimals) : undefined,
  });

  const amount = (v: bigint): string => `${format(v, asset.decimals)} ${asset.symbol}`;
  const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

  console.log(`wallet     ${source}${account ? "" : "   (from the launch on record; no key loaded)"}`);
  console.log(`asset      ${asset.symbol}${asset.native ? "" : `  ${asset.address}`}`);
  console.log(`balance    ${amount(balance)}`);
  if (asset.native) console.log(`reserve    ${amount(reserve)}   left behind for gas`);
  console.log("");

  if (!plan.ok) {
    console.log(`nothing to do: ${plan.reason}.`);
    if (CFG.payout.nodesBps + CFG.payout.buybackBps + CFG.payout.teamBps === 0) {
      console.log(`
The three shares ship at zero, so this command does nothing until somebody decides them.
Set them in .env, in basis points adding up to 10000, along with the three addresses:

  PAYOUT_NODES=0x…          PAYOUT_NODES_BPS=4000
  PAYOUT_BUYBACK=0x…        PAYOUT_BUYBACK_BPS=4000
  PAYOUT_TEAM=0x…           PAYOUT_TEAM_BPS=2000`);
    }
    return;
  }

  console.log(`splitting  ${amount(plan.distributable)}`);
  for (const p of plan.parts) {
    console.log(`  ${p.name.padEnd(8)} ${pct(p.bps).padStart(6)}   ${amount(p.amount).padStart(22)}   ${p.address}`);
  }
  console.log("");

  if (!SEND) {
    console.log("dry run. Nothing was signed and nothing moved; add --send to broadcast this.");
    return;
  }
  if (!account) {
    console.error("no PAYOUT_PRIVATE_KEY set, so there is nothing to sign with. The plan above is all this machine can do.");
    process.exitCode = 1;
    return;
  }
  if (onRecord && onRecord.toLowerCase() !== source) {
    console.log(`note: the launch pays ${onRecord}, and this key is ${source}.`);
    console.log("      splitting anyway, since that is what was asked for.\n");
  }

  const gas = await reader.getBalance({ address: account.address });
  if (gas <= (asset.native ? reserve : 0n)) {
    console.error(`the wallet holds ${format(gas, 18)} ETH, which will not cover the gas for three transfers.`);
    process.exitCode = 1;
    return;
  }

  const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpc) });
  const runId = randomUUID();
  const record = db.prepare(`
    INSERT INTO payouts (tx, run_id, kind, asset, sender, address, amount_wei, amount_eth, bps, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx) DO NOTHING`);

  /**
   * One transfer at a time, each waited out before the next.
   *
   * Slower than firing all three and collecting receipts, and worth it: a nonce is sequential, a
   * public endpoint drops requests under load, and a run that half-broadcasts three transfers
   * against guessed nonces is the one failure here that costs money rather than time.
   */
  let sent = 0;
  for (const part of plan.parts) {
    try {
      const hash = asset.native
        ? await wallet.sendTransaction({ to: part.address as Address, value: part.amount })
        : await wallet.writeContract({
          address: asset.address, abi: erc20, functionName: "transfer",
          args: [part.address as Address, part.amount],
        });
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") {
        console.error(`  ${part.name}: reverted (${EXPLORER.tx(hash)}). Stopping here.`);
        process.exitCode = 1;
        break;
      }
      record.run(
        hash, runId, part.name, asset.address, source, part.address,
        part.amount.toString(), Number(part.amount) / 10 ** asset.decimals, part.bps,
        Number(receipt.blockNumber), Math.floor(Date.now() / 1000),
      );
      sent++;
      console.log(`  ${part.name.padEnd(8)} ${amount(part.amount).padStart(22)}   ${EXPLORER.tx(hash)}`);
    } catch (err) {
      // Stop rather than carry on. What is left stays in the wallet and goes out on the next run,
      // which is the harmless outcome; sending the rest against an uncertain nonce is not.
      console.error(`  ${part.name}: ${(err as Error).message.slice(0, 160)}`);
      console.error("  stopping. What is left stays in the wallet and goes out on the next run.");
      process.exitCode = 1;
      break;
    }
  }

  console.log(`\n${sent} of ${plan.parts.length} transfers mined. The fees page reads them from the ledger.`);
}

/**
 * The cadence, when this is left running rather than called by a timer.
 *
 * A systemd timer does the same job and survives a reboot, which is why DEPLOY.md leads with one.
 * This exists because a machine that already runs the watcher and the bot can run the split beside
 * them under the same supervisor, and because a failed run must not end the process: what did not
 * go out this time is still in the wallet, and the next run splits it.
 */
async function every(everySec: number, jitterSec: number): Promise<void> {
  console.log(`splitting every ${(everySec / 3600).toFixed(1)}h`
    + (jitterSec ? `, give or take ${Math.round(jitterSec / 60)} min` : "") + "\n");
  for (;;) {
    try {
      await main();
    } catch (err) {
      console.error(`run failed: ${(err as Error).message.slice(0, 160)}`);
    }
    const wait = Math.max(60, everySec + Math.round((Math.random() * 2 - 1) * jitterSec));
    console.log(`
next run in ${(wait / 60).toFixed(0)} min
${"─".repeat(60)}
`);
    await sleep(wait * 1000);
  }
}

try {
  if (EVERY && seconds(EVERY) < 60) {
    // A misread interval is the difference between four runs a day and a run a minute, each one
    // paying gas, so an unparseable one stops rather than falling back to a default.
    console.error(`"--every ${EVERY}" is not an interval this understands. Try 3h, 90m or 45s.`);
    process.exitCode = 1;
  } else if (EVERY) await every(seconds(EVERY), seconds(JITTER));
  else await main();
} finally {
  db.close();
}
