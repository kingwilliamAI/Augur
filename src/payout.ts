/**
 * Splitting the fee wallet three ways, in software.
 *
 * `contracts/FeeSplitter.sol` does the same job trustlessly and needs a deployment, a decision that
 * cannot be undone, and a fee recipient pointed at it. This is the version that works today: the
 * wallet stays the wallet, and a command run by whoever operates the board moves what arrived into
 * three addresses in fixed shares. What it buys over the contract is that it can be changed and that
 * it needs nothing on chain; what it costs is that the split is a habit rather than a guarantee,
 * which is why the ledger page names which of the two paid each line.
 *
 * Everything here is arithmetic on integers and a set of refusals. Nothing in this file signs, sends,
 * reads a key or touches the network: the signing lives in `cli/payout.ts` alone, so the part that
 * decides how much goes where can be driven from a test with no wallet in sight.
 *
 * Two rules are worth stating out loud because they are what stops a bad run:
 *
 *   - A reserve is held back, always. A wallet drained to the last wei cannot pay for the gas of the
 *     next payout, and the first thing that would fail is the tool that emptied it.
 *   - Below a floor, nothing is sent. Three transfers cost gas whatever they carry, and splitting
 *     dust three ways spends more than it moves.
 */

export type Share = "nodes" | "buyback" | "team";

export const SHARES: readonly Share[] = ["nodes", "buyback", "team"] as const;

/** Where one share goes and how big it is, in basis points of the distributable balance. */
export type Destination = { name: Share; address: string; bps: number };

export type PayoutInput = {
  /** The wallet the fee arrives in, and the only address that signs anything. */
  source: string;
  destinations: Destination[];
  /** Everything the wallet holds of the asset being split, in its smallest unit. */
  balance: bigint;
  /** Held back so the wallet can still pay gas. Zero for a token, which is not what gas is paid in. */
  reserve: bigint;
  /** Below this, a run is refused rather than made. */
  minimum: bigint;
  /** An optional ceiling for one run, for a first run somebody wants to keep small. */
  max?: bigint;
};

export type PayoutPart = { name: Share; address: string; bps: number; amount: bigint };

export type PayoutPlan =
  | { ok: false; reason: string; balance: bigint; distributable: bigint; parts: [] }
  | { ok: true; balance: bigint; distributable: bigint; parts: PayoutPart[] };

const DENOMINATOR = 10_000n;

const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/**
 * What one run would move, or why it would not run.
 *
 * The refusals come first and they are deliberately blunt. Every one of them describes a
 * configuration that would send somebody's money somewhere they did not mean, and a tool that
 * corrects such a configuration silently is worse than one that stops: the shares not summing to
 * a whole is not a rounding problem to be fixed, it is a sign the operator meant something else.
 */
export function planPayout(input: PayoutInput): PayoutPlan {
  const { source, destinations, balance, reserve, minimum } = input;
  const no = (reason: string, distributable = 0n): PayoutPlan =>
    ({ ok: false, reason, balance, distributable, parts: [] });

  if (destinations.length !== SHARES.length) {
    return no(`three destinations are needed, ${destinations.length} configured`);
  }
  for (const name of SHARES) {
    if (!destinations.some((d) => d.name === name)) return no(`no address set for ${name}`);
  }
  for (const d of destinations) {
    if (!isAddress(d.address)) return no(`${d.name} has no usable address`);
    if (d.address.toLowerCase() === source.trim().toLowerCase()) {
      return no(`${d.name} is the fee wallet itself, which would pay gas to move nothing`);
    }
    if (d.bps < 0) return no(`${d.name} has a negative share`);
  }
  const seen = new Set(destinations.map((d) => d.address.toLowerCase()));
  if (seen.size !== destinations.length) {
    return no("two of the three destinations are the same address, so the split is not the one written");
  }

  const total = destinations.reduce((acc, d) => acc + BigInt(d.bps), 0n);
  if (total !== DENOMINATOR) {
    return no(`the shares add up to ${total} basis points, and a whole is ${DENOMINATOR}`);
  }

  if (balance <= reserve) return no("nothing above the gas reserve", 0n);
  let distributable = balance - reserve;
  if (input.max !== undefined && input.max > 0n && distributable > input.max) distributable = input.max;
  if (distributable < minimum) {
    return no("below the floor for a run, so the gas would cost more than the split moves", distributable);
  }

  /**
   * Integer shares, with the remainder going to the buyback.
   *
   * Division leaves at most two of the smallest unit unaccounted for, and it has to land somewhere.
   * It goes to the share that comes back to holders rather than to the two that do not, which is the
   * same rule the contract uses and the only one that needs no explaining.
   */
  const parts: PayoutPart[] = destinations.map((d) => ({
    name: d.name,
    address: d.address.toLowerCase(),
    bps: d.bps,
    amount: (distributable * BigInt(d.bps)) / DENOMINATOR,
  }));
  const assigned = parts.reduce((acc, p) => acc + p.amount, 0n);
  const remainder = distributable - assigned;
  if (remainder > 0n) {
    const buyback = parts.find((p) => p.name === "buyback") ?? parts[0];
    buyback.amount += remainder;
  }

  if (parts.some((p) => p.amount <= 0n)) {
    return no("one of the shares rounds to nothing at this size, so the run would send an empty transfer", distributable);
  }

  return { ok: true, balance, distributable, parts };
}

/** Whole units from the smallest ones, for printing only. Never used to decide an amount. */
export const format = (v: bigint, decimals: number, places = 6): string => {
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

/**
 * A duration like "3h", "90m" or "45s" in seconds. A bare number is minutes, because that is what a
 * missing unit most likely meant and an interval read as seconds would run the tool 180 times an
 * hour.
 */
export function seconds(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(spec.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] ?? 60));
}

/** The smallest units in a decimal string, without going through a float. */
export function parseUnits(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
