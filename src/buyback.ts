import { encodeAbiParameters, parseAbi, parseAbiParameters, type Address } from "viem";
import { ADDR, CFG } from "./config.ts";

/**
 * Buying $AUGUR back with the share of the fee set aside for it.
 *
 * The encoding here is not invented. It is what a real buy of this token looks like on this chain,
 * taken off a transaction that worked and rebuilt field by field: the Universal Router's V4_SWAP
 * command carrying the three v4 actions, against the pool key pons graduated the token into. Six
 * other pools exist for this token, opened by strangers at fee tiers up to 80%, so a key that was
 * guessed rather than read is a trade into somebody else's market.
 *
 * What is deliberately absent is a price feed. The amount to expect back is found by asking the
 * chain to simulate the swap: a call that would return less than the floor reverts, so a search over
 * the floor converges on what the pool would actually pay, through the pons hook's fee and whatever
 * the ticks do on the way. No oracle, no quoter deployment to depend on, and the number that comes
 * out is the number the real transaction would produce a second later.
 *
 * Nothing in this file signs or sends. It builds calldata and describes a plan.
 */

/** UniversalRouter, verified on chain: the router real buys of this token go through. */
export const ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

/** V4_SWAP. One command, one input. */
const V4_SWAP = "0x10";
/** SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL: the shape every ordinary v4 buy uses. */
const ACTIONS = "0x060c0f";

export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The pool the token graduated into.
 *
 * Read from a real swap rather than assembled from configuration: currency0 is the chain's own
 * currency, currency1 is the token, the pool charges nothing at the pool because pons charges at its
 * hook instead, and the hook is the one the factory reports. Overridable in the environment for the
 * day any of that changes, which is the same reason the addresses in config.ts are.
 */
export type PoolKey = {
  currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address;
};

export const poolKeyFor = (token: string): PoolKey => ({
  currency0: NATIVE,
  currency1: token.toLowerCase() as Address,
  fee: CFG.buyback.poolFee,
  tickSpacing: CFG.buyback.tickSpacing,
  hooks: (CFG.buyback.hook || ADDR.hook).toLowerCase() as Address,
});

/**
 * The calldata for one buy.
 *
 * `minOut` is the whole safety of this call. The router hands back whatever the pool gives and the
 * TAKE_ALL action reverts below the floor, so a swap that would be sandwiched into a bad price fails
 * instead of settling: the money stays where it was and the next run tries again.
 */
export function buyCalldata(key: PoolKey, amountIn: bigint, minOut: bigint): {
  args: readonly [`0x${string}`, readonly `0x${string}`[], bigint];
  value: bigint;
} {
  const swap = encodeAbiParameters(
    parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"),
    [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], true, amountIn, minOut, "0x"]],
  );
  const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [key.currency0, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address,uint256"), [key.currency1, minOut]);
  const input = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [ACTIONS, [swap, settle, take]]);

  return {
    args: [V4_SWAP, [input], BigInt(Math.floor(Date.now() / 1000) + CFG.buyback.deadlineSec)] as const,
    value: amountIn,
  };
}

/**
 * The most the pool will pay for this size, found by asking it.
 *
 * `probe` returns whether a swap demanding at least that much would go through, which is one
 * `eth_call` and costs nothing. The bracket grows by sixty-four at a time rather than doubling, and
 * that is not arbitrary: a token priced in the tens of thousands per coin puts the answer twenty-four
 * digits up, and doubling spends forty calls just getting there, leaving none for the part that
 * matters. Sixty-four reaches it in a dozen and the bisection that follows closes to a tenth of a
 * percent in a dozen more.
 *
 * Whatever it returns is a number the chain has already agreed to once, and an interrupted search
 * returns a floor that is too low rather than one that is too high.
 */
export async function findOutput(
  amountIn: bigint,
  probe: (minOut: bigint) => Promise<boolean>,
  opts: { maxCalls?: number; precisionBps?: number } = {},
): Promise<bigint> {
  const maxCalls = opts.maxCalls ?? 64;
  const precision = BigInt(opts.precisionBps ?? 10);
  let calls = 0;

  // Nothing at all comes back: either the pool is unreachable or the size is too small to move it.
  if (!(await probe(1n))) return 0n;
  calls++;

  let lo = 1n;
  let hi = 64n;
  while (calls < maxCalls && (await probe(hi))) {
    calls++;
    lo = hi;
    hi *= 64n;
  }
  calls++;

  while (calls < maxCalls && hi - lo > (lo * precision) / 10_000n + 1n) {
    const mid = (lo + hi) / 2n;
    if (await probe(mid)) lo = mid;
    else hi = mid;
    calls++;
  }
  return lo;
}

/** The floor that goes on chain: what the pool offered, less the slippage the operator allows. */
export const floorFor = (expected: bigint, slippageBps: number): bigint =>
  (expected * BigInt(10_000 - slippageBps)) / 10_000n;

export type BuyPlan =
  | { ok: false; reason: string; spend: bigint }
  | { ok: true; spend: bigint; expected: bigint; minOut: bigint; pricePerToken: number };

/**
 * What one run would buy, or why it would not run.
 *
 * The refusals are the same shape as the payout's, and for the same reason: every one of them is a
 * configuration that would spend somebody's money in a way they did not mean.
 */
export function planBuy(input: {
  balance: bigint; reserve: bigint; minimum: bigint; max?: bigint;
  expected: bigint; slippageBps: number; decimals: number;
}): BuyPlan {
  const { balance, reserve, minimum, expected, slippageBps } = input;
  const no = (reason: string, spend = 0n): BuyPlan => ({ ok: false, reason, spend });

  if (slippageBps < 0 || slippageBps >= 10_000) return no("the slippage allowance is not a share of a whole");
  if (balance <= reserve) return no("nothing above the gas reserve");
  let spend = balance - reserve;
  if (input.max !== undefined && input.max > 0n && spend > input.max) spend = input.max;
  if (spend < minimum) return no("below the floor for a run, so the gas would cost more than the buy", spend);
  if (expected <= 0n) return no("the pool would pay nothing for this size", spend);

  const minOut = floorFor(expected, slippageBps);
  if (minOut <= 0n) return no("the floor rounds to nothing", spend);

  return {
    ok: true,
    spend,
    expected,
    minOut,
    // For printing only, and only ever a display: the decision above is made on integers.
    pricePerToken: Number(spend) / 1e18 / (Number(expected) / 10 ** input.decimals),
  };
}
