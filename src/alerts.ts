import type { DB } from "./db.ts";
import type { Scored } from "./score.ts";

/**
 * Alerts built from the claim the watcher just wrote, rather than from a freshly scored page.
 *
 * Speed is not a refinement here, it is the product. Half of all graduations happen within two
 * minutes of the launch and a quarter within thirty seconds, so an alert that arrives a minute late
 * is a report, not a warning. The path it replaces cost up to thirty seconds waiting for the next
 * poll and up to fifteen more on a feed matrix that rebuilds on a timer, and those together could
 * outlast the time the token had left on the curve.
 *
 * None of that work was needed. The watcher scores every launch the moment it sees it, four seconds
 * after the block at the median, and writes the claim to the log: token, probability, rank, reasons,
 * all of it. Reading that row back is both fresher than the matrix and nearly free, and it has a
 * second virtue worth as much as the speed. The alert now says exactly what the log recorded,
 * because it is the same row, instead of a number computed separately that could quietly disagree
 * with the claim the tool is judged on.
 *
 * What it cannot see is a launch whose standing changed after first sight, because a claim is
 * written once and never revised. That is what the slower full pass beside it is for.
 */
export function claimsFor(db: DB, minProbability: number, since: number, limit = 25): Scored[] {
  const rows = db.prepare(`
    SELECT token, launch_ts, probability, raw_probability, rank, of, reasons_json
    FROM predictions
    WHERE launch_ts >= ? AND probability >= ?
    ORDER BY probability DESC LIMIT ?`).all(since, minProbability, limit) as
    Array<{ token: string; launch_ts: number; probability: number; raw_probability: number | null;
            rank: number; of: number; reasons_json: string }>;
  return rows.map((r) => ({
    token: r.token,
    ts: r.launch_ts,
    probability: r.probability,
    rawProbability: r.raw_probability ?? r.probability,
    rank: r.rank,
    of: r.of,
    // Rank 1 of 500 is the top of the list, so the highest percentile. A single-launch window has
    // no spread to speak of, and dividing by zero there would put NaN on a card.
    percentile: r.of > 1 ? 1 - (r.rank - 1) / (r.of - 1) : 1,
    reasons: JSON.parse(r.reasons_json) as Scored["reasons"],
  }));
}
