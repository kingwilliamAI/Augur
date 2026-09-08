import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, SEC_PER_BLOCK } from "./watchdog.ts";

/**
 * A watchdog that never fires is indistinguishable from a watchdog with nothing to do, which is
 * exactly the class of silent failure the rest of this project is careful about. These fix the two
 * ways it could be wrong: staying quiet through a real outage, and restarting a healthy watcher.
 */

const T = { behindSec: 300, silentSec: 180 };
const NOW = 1_800_000_000;
const behind = (sec: number): number => Math.round(sec / SEC_PER_BLOCK);

test("says nothing when the watcher is current", () => {
  const v = assess({ now: NOW, head: 1_000_000, seenAt: NOW - 5, indexedBlock: 1_000_000 - behind(3) }, T);
  assert.deepEqual(v.reasons, []);
});

test("tolerates lag that is real but inside the threshold", () => {
  const v = assess({ now: NOW, head: 1_000_000, seenAt: NOW - 20, indexedBlock: 1_000_000 - behind(120) }, T);
  assert.deepEqual(v.reasons, [], "two minutes behind is catching up, not broken");
});

test("notices a watcher that is running and losing the race", () => {
  const v = assess({ now: NOW, head: 1_000_000, seenAt: NOW - 3, indexedBlock: 1_000_000 - behind(600) }, T);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /behind the chain/);
  assert.ok(Math.abs(v.behindSec - 600) < 1);
});

test("notices a watcher that has gone quiet even while it looks caught up", () => {
  // The dangerous case: it died at the head, so lag looks fine and only the silence gives it away.
  const v = assess({ now: NOW, head: 1_000_000, seenAt: NOW - 900, indexedBlock: 1_000_000 }, T);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /silent for 900s/);
});

test("reports both when both are true", () => {
  const v = assess({ now: NOW, head: 1_000_000, seenAt: NOW - 900, indexedBlock: 1_000_000 - behind(900) }, T);
  assert.equal(v.reasons.length, 2);
});

test("treats a watcher that has never reported as broken, not as healthy", () => {
  const v = assess({ now: NOW, head: 0, seenAt: 0, indexedBlock: 0 }, T);
  assert.match(v.reasons.join(" "), /never reported/);
  assert.equal(v.silentFor, Number.POSITIVE_INFINITY);
});
