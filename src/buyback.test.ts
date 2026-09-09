import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, parseAbiParameters } from "viem";

import { buyCalldata, findOutput, floorFor, planBuy, poolKeyFor } from "./buyback.ts";
import { parseUnits } from "./payout.ts";

/**
 * The buyback, driven without a wallet and without the chain.
 *
 * Two things are being protected here. One is the encoding: the calldata is rebuilt from a real
 * transaction that bought this token, and a field that quietly moves would send money into one of
 * the six stranger-made pools that share the token's name. The other is the search that stands in
 * for a price feed, which has to converge on what the pool pays and must never come back with a
 * number the pool would not honour.
 */

const TOKEN = "0x04d2d16c26b2e82fbd93d1bbb91855fb8660f72c";
const ETH = (v: string): bigint => parseUnits(v, 18);

test("the calldata is the shape a real buy of this token has", () => {
  const key = poolKeyFor(TOKEN);
  const { args, value } = buyCalldata(key, ETH("0.015"), 123n);
  const [commands, inputs, deadline] = args;

  assert.equal(commands, "0x10", "V4_SWAP, the one command a v4 buy needs");
  assert.equal(inputs.length, 1);
  assert.equal(value, ETH("0.015"), "the swap is paid for with the transaction's own value");
  assert.ok(deadline > BigInt(Math.floor(Date.now() / 1000)), "a deadline in the past never mines");

  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), inputs[0]);
  assert.equal(actions, "0x060c0f", "SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL");
  assert.equal(params.length, 3);

  const [swap] = decodeAbiParameters(
    parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"), params[0],
  ) as unknown as [[[string, string, number, number, string], boolean, bigint, bigint, string]];
  const [poolKey, zeroForOne, amountIn, minOut, hookData] = swap;

  assert.equal(poolKey[0].toLowerCase(), "0x0000000000000000000000000000000000000000", "currency0 is the chain's own coin");
  assert.equal(poolKey[1].toLowerCase(), TOKEN, "currency1 is the token being bought");
  assert.equal(poolKey[2], 0, "the pool charges nothing; pons charges at its hook");
  assert.equal(poolKey[3], 200);
  assert.equal(poolKey[4].toLowerCase(), "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044", "the pons hook");
  assert.equal(zeroForOne, true, "spending the coin to receive the token, not the other way round");
  assert.equal(amountIn, ETH("0.015"));
  assert.equal(minOut, 123n);
  assert.equal(hookData, "0x");

  const [settleCurrency, settleAmount] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[1]);
  assert.equal(settleCurrency.toLowerCase(), "0x0000000000000000000000000000000000000000");
  assert.equal(settleAmount, ETH("0.015"));
  const [takeCurrency, takeAmount] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[2]);
  assert.equal(takeCurrency.toLowerCase(), TOKEN);
  assert.equal(takeAmount, 123n, "the floor is what makes a bad fill revert instead of settling");
});

/** A pool that pays exactly `price` and refuses anything above it, which is what the chain does. */
const poolPaying = (price: bigint) => async (minOut: bigint): Promise<boolean> => minOut <= price;

test("the search finds what the pool pays, from below", async () => {
  const truth = 812_325_269_719_752_685_450_898n;
  const found = await findOutput(ETH("0.015"), poolPaying(truth));
  assert.ok(found <= truth, "never claims more than the pool would honour");
  assert.ok(found > (truth * 9990n) / 10_000n, `within a tenth of a percent, got ${found}`);
});

test("a pool that pays nothing answers nothing rather than a guess", async () => {
  assert.equal(await findOutput(ETH("1"), async () => false), 0n);
});

test("the search is bounded, and a stingy budget still comes back under the truth", async () => {
  let calls = 0;
  const counted = async (minOut: bigint): Promise<boolean> => {
    calls++;
    return minOut <= 1_000_000n;
  };
  const found = await findOutput(ETH("1"), counted, { maxCalls: 12 });
  assert.ok(calls <= 12, `stayed inside its budget: ${calls}`);
  assert.ok(found <= 1_000_000n, "an interrupted search is still a floor the pool would honour");
});

test("slippage is taken off the top, and the floor is what goes on chain", () => {
  assert.equal(floorFor(1000n, 100), 990n, "1%");
  assert.equal(floorFor(1000n, 0), 1000n, "no allowance means the exact simulated price");
  assert.equal(floorFor(1000n, 10_000 - 1), 0n);
});

const plan = (over: Partial<Parameters<typeof planBuy>[0]> = {}) => planBuy({
  balance: ETH("1"), reserve: ETH("0.005"), minimum: ETH("0.01"),
  expected: 55_487_806_173_000_000_000_000n, slippageBps: 100, decimals: 18,
  ...over,
});

test("a run spends what is there, minus the reserve", () => {
  const p = plan();
  assert.equal(p.ok, true);
  assert.equal(p.spend, ETH("0.995"));
  assert.equal(p.minOut, (p.expected * 9900n) / 10_000n);
});

test("a wallet with only its reserve does nothing", () => {
  const p = plan({ balance: ETH("0.005") });
  assert.equal(p.ok, false);
  assert.match(p.reason, /above the gas reserve/);
});

test("dust waits for a bigger run rather than paying gas to move itself", () => {
  const p = plan({ balance: ETH("0.012") });
  assert.equal(p.ok, false);
  assert.match(p.reason, /below the floor/);
});

test("a pool that would pay nothing stops the run before it is signed", () => {
  const p = plan({ expected: 0n });
  assert.equal(p.ok, false);
  assert.match(p.reason, /would pay nothing/);
});

test("a slippage allowance that is not a share of a whole is refused", () => {
  assert.equal(plan({ slippageBps: 10_000 }).ok, false);
  assert.equal(plan({ slippageBps: -1 }).ok, false);
});

test("a cap keeps a first run small", () => {
  const p = plan({ balance: ETH("10"), max: ETH("0.05") });
  assert.equal(p.ok, true);
  assert.equal(p.spend, ETH("0.05"));
});
