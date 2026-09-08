import { formatEther } from "viem";
import { factoryAbi } from "../abi.ts";
import { ADDR, CFG } from "../config.ts";
import { logsClient, stateClient, wsClient, withRetry } from "../chain.ts";
import { openDb } from "../db.ts";

const ok = (s: string): string => `  ok    ${s}`;
const bad = (s: string): string => `  FAIL  ${s}`;
let failures = 0;
const check = (pass: boolean, msg: string): void => {
  if (!pass) failures++;
  console.log(pass ? ok(msg) : bad(msg));
};

console.log("augur doctor\n");

console.log("endpoints");
const logsBlock = Number(await logsClient.getBlockNumber());
check(logsBlock > 0, `logs endpoint ${CFG.httpUrl} at block ${logsBlock}`);
try {
  const sb = Number(await stateClient.getBlockNumber());
  check(Math.abs(sb - logsBlock) < 5000, `state endpoint ${CFG.stateUrl} at block ${sb}`);
} catch {
  check(false, `state endpoint ${CFG.stateUrl} unreachable`);
}
check(wsClient !== null, wsClient ? `websocket ${CFG.wsUrl}` : "websocket disabled, detection will poll");

console.log("\nchain");
const id = await logsClient.getChainId();
check(id === 4663, `chain id ${id} (expected 4663)`);

console.log("\npons v2 factory");
const code = await stateClient.getCode({ address: ADDR.factory });
check(!!code && code.length > 2, `factory ${ADDR.factory} has ${code ? (code.length - 2) / 2 : 0} bytes of code`);

const read = async (fn: string): Promise<unknown> =>
  withRetry(() => stateClient.readContract({ address: ADDR.factory, abi: factoryAbi, functionName: fn as never }));

const [escrow, hook, deployer, enabled, taxBps, taxSecs, fee] = await Promise.all(
  ["feeEscrow", "memeHook", "launchDeployer", "launchEnabled", "snipeTaxStartBps", "snipeTaxSeconds", "launchFee"].map(read),
);
// The factory is the authority on its own wiring; a mismatch means our constants drifted.
check(String(escrow).toLowerCase() === ADDR.escrow.toLowerCase(), `feeEscrow() matches config (${escrow})`);
check(String(hook).toLowerCase() === ADDR.hook.toLowerCase(), `memeHook() matches config (${hook})`);
check(String(deployer).toLowerCase() === ADDR.deployer.toLowerCase(), `launchDeployer() matches config (${deployer})`);
check(enabled === true, `launchEnabled() is ${enabled}`);
check(taxBps === 9900n, `snipeTaxStartBps() ${taxBps} (opening tax ${Number(taxBps) / 100}%)`);
check(taxSecs === 3n, `snipeTaxSeconds() ${taxSecs}`);
console.log(ok(`launchFee() ${formatEther(fee as bigint)} ETH`));

console.log("\nstorage");
const db = openDb();
const n = (db.prepare("SELECT count(*) c FROM launches").get() as { c: number }).c;
const g = (db.prepare("SELECT count(*) c FROM graduations").get() as { c: number }).c;
check(true, `${CFG.dbPath}: ${n} launches, ${g} graduations`);
db.close();

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
