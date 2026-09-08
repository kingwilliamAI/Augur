/**
 * Deciding whether the watcher has stopped following the chain.
 *
 * Kept apart from the command that acts on it so the decision can be tested. A watchdog that never
 * fires looks exactly like a watchdog with nothing to do, which is the failure mode this whole file
 * exists to avoid elsewhere in the project; it would be strange to leave it untested here.
 */

/** Seconds per block, from the same measured rate the rest of the tool uses. */
export const SEC_PER_BLOCK = 0.1009;

export type Sample = {
  now: number;
  /** Chain head the watcher last reported, 0 when it never has. */
  head: number;
  /** When it last reported, 0 when it never has. */
  seenAt: number;
  /** Highest block any launch has been written for. */
  indexedBlock: number;
};

export type Thresholds = { behindSec: number; silentSec: number };

export type Verdict = {
  reasons: string[];
  silentFor: number;
  behindSec: number;
};

/**
 * Two independent ways to be broken, reported separately because they point at different causes.
 *
 * Silence means the process is gone or wedged before it writes anything. Lag means it is running and
 * losing the race. A watcher can be silent without being behind — it died at the head — so neither
 * check subsumes the other.
 */
export function assess(s: Sample, t: Thresholds): Verdict {
  const silentFor = s.seenAt ? s.now - s.seenAt : Number.POSITIVE_INFINITY;
  const behindSec = s.head && s.indexedBlock
    ? Math.max(0, s.head - s.indexedBlock) * SEC_PER_BLOCK
    : Number.POSITIVE_INFINITY;

  const reasons: string[] = [];
  if (silentFor > t.silentSec) reasons.push(s.seenAt ? `silent for ${Math.round(silentFor)}s` : "never reported");
  if (behindSec > t.behindSec) reasons.push(`${Math.round(behindSec)}s behind the chain`);
  return { reasons, silentFor, behindSec };
}
