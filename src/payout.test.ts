import { test } from "node:test";
import assert from "node:assert/strict";

import { format, parseUnits, planPayout, type Destination } from "./payout.ts";

/**
 * The split, driven without a wallet, a key or a network.
 *
 * This is the one part of the project that moves money, so the tests are mostly refusals: every
 * configuration below would send somebody's funds somewhere they did not intend, and each one has to
 * stop the run rather than be quietly corrected. The arithmetic tests exist for the opposite reason,
 * that nothing may go missing between the balance and the three transfers.
 */

const SOURCE = "0x1111111111111111111111111111111111111111";
const NODES = "0x2222222222222222222222222222222222222222";
const BUYBACK = "0x3333333333333333333333333333333333333333";
const TEAM = "0x4444444444444444444444444444444444444444";
const ETH = (v: string): bigint => parseUnits(v, 18);

const dests = (nodes = 4000, buyback = 4000, team = 2000): Destination[] => [
  { name: "nodes", address: NODES, bps: nodes },
  { name: "buyback", address: BUYBACK, bps: buyback },
  { name: "team", address: TEAM, bps: team },
];

const plan = (over: Partial<Parameters<typeof planPayout>[0]> = {}) => planPayout({
  source: SOURCE,
  destinations: dests(),
  balance: ETH("1"),
  reserve: ETH("0.01"),
  minimum: ETH("0.02"),
  ...over,
});

test("a whole balance is split by the shares, minus the gas reserve", () => {
  const p = plan();
  assert.equal(p.ok, true);
  assert.equal(p.distributable, ETH("0.99"), "the reserve stays behind");
  const by = Object.fromEntries(p.parts.map((x) => [x.name, x.amount]));
  assert.equal(by.nodes, ETH("0.396"));
  assert.equal(by.buyback, ETH("0.396"));
  assert.equal(by.team, ETH("0.198"));
});

test("nothing goes missing between the balance and the transfers", () => {
  const p = plan({ balance: 1_000_000_007n, reserve: 0n, minimum: 0n });
  assert.equal(p.ok, true);
  const sum = p.parts.reduce((acc, x) => acc + x.amount, 0n);
  assert.equal(sum, p.distributable, "the remainder of the division has to land somewhere");
  assert.equal(p.parts.find((x) => x.name === "buyback")?.amount, 400_000_004n,
    "and it lands on the share that comes back to holders: 400000002 plus the two wei left over");
});

test("shares that do not add up to a whole stop the run", () => {
  const p = plan({ destinations: dests(4000, 4000, 1000) });
  assert.equal(p.ok, false);
  assert.match(p.reason, /9000 basis points/);
});

test("an unset share stops the run rather than being treated as zero", () => {
  const p = plan({ destinations: [
    { name: "nodes", address: NODES, bps: 5000 },
    { name: "buyback", address: BUYBACK, bps: 5000 },
    { name: "team", address: "", bps: 0 },
  ] });
  assert.equal(p.ok, false);
  assert.match(p.reason, /team has no usable address/);
});

test("paying the fee wallet itself is refused", () => {
  const p = plan({ destinations: dests().map((d) => (d.name === "team" ? { ...d, address: SOURCE } : d)) });
  assert.equal(p.ok, false);
  assert.match(p.reason, /the fee wallet itself/);
});

test("two destinations at one address is refused, because the split would not be the written one", () => {
  const p = plan({ destinations: dests().map((d) => (d.name === "team" ? { ...d, address: NODES } : d)) });
  assert.equal(p.ok, false);
  assert.match(p.reason, /the same address/);
});

test("a wallet holding only its reserve does nothing", () => {
  const p = plan({ balance: ETH("0.01") });
  assert.equal(p.ok, false);
  assert.match(p.reason, /above the gas reserve/);
  assert.equal(p.distributable, 0n);
});

test("dust is left to accumulate rather than split three ways", () => {
  const p = plan({ balance: ETH("0.025") });
  assert.equal(p.ok, false);
  assert.match(p.reason, /below the floor/);
});

test("a ceiling keeps a first run small, and the rest waits for the next one", () => {
  const p = plan({ balance: ETH("10"), max: ETH("1") });
  assert.equal(p.ok, true);
  assert.equal(p.distributable, ETH("1"));
  assert.equal(p.parts.reduce((a, x) => a + x.amount, 0n), ETH("1"));
});

test("a share that rounds to nothing stops the run rather than sending an empty transfer", () => {
  const p = plan({
    destinations: [
      { name: "nodes", address: NODES, bps: 9998 },
      { name: "buyback", address: BUYBACK, bps: 1 },
      { name: "team", address: TEAM, bps: 1 },
    ],
    balance: 5000n, reserve: 0n, minimum: 0n,
  });
  assert.equal(p.ok, false);
  assert.match(p.reason, /rounds to nothing/);
});

test("amounts are read and printed without ever becoming a float", () => {
  assert.equal(parseUnits("0.1", 18), 100_000_000_000_000_000n);
  assert.equal(parseUnits("1", 6), 1_000_000n);
  assert.equal(parseUnits("12.345678901234567890", 18), 12_345_678_901_234_567_890n);
  assert.equal(format(1_234_500_000_000_000_000n, 18), "1.2345");
  assert.equal(format(1_000_000_000_000_000_000n, 18), "1");
  assert.equal(format(1n, 18), "0");
  assert.equal(format(1n, 18, 18), "0.000000000000000001");
});
