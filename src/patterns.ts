import { EARLY_FIELDS, type Early, type Outcome } from "./early.ts";

/**
 * Searching for the green flag, without finding one that isn't there.
 *
 * The appeal of this is obvious: somewhere in the opening seconds there might be a shape — six
 * buyers and no seller, say, or a creator who never touches their own launch — after which tokens
 * run. The danger is just as obvious and much easier to ignore. A search over a few hundred
 * conditions on seven thousand launches will *always* return something that looks like a green flag,
 * because the best of three hundred noisy estimates is not a typical noisy estimate. Run the search,
 * read off the winner, and you have manufactured an edge out of nothing at all — and it will hold up
 * beautifully right until it is asked to predict something.
 *
 * So this file finds patterns and then attacks them, three ways:
 *
 * 1. **A held-out half.** Patterns are proposed on the older launches and scored on the newer ones,
 *    which the search never touched.
 * 2. **A permutation null.** The entire search is re-run against shuffled outcomes, dozens of times.
 *    Every relationship between a pattern and what happened is destroyed, so whatever the search
 *    still finds is exactly what it invents from nothing. A real pattern has to beat that, not merely
 *    beat the base rate.
 * 3. **Support floors.** A pattern holding forty launches and a 40% hit rate is sixteen events, and
 *    sixteen events is a rumour.
 *
 * The permutation is the one that matters. Lift over the base rate says a pattern looks good; lift
 * over the best-of-the-same-search-on-noise says it is good.
 */

export type Condition = { field: keyof Early; op: ">=" | "<="; value: number };
export type Pattern = { conditions: Condition[] };

export const show = (p: Pattern): string =>
  p.conditions.map((c) => `${c.field} ${c.op} ${fmt(c.value)}`).join(" and ");

const fmt = (v: number): string =>
  Math.abs(v) >= 1e6 ? v.toExponential(2) : Number.isInteger(v) ? String(v) : v.toFixed(3);

const holds = (c: Condition, e: Early): boolean => {
  const v = e[c.field] as number;
  return c.op === ">=" ? v >= c.value : v <= c.value;
};

export const matches = (p: Pattern, e: Early): boolean => p.conditions.every((c) => holds(c, e));

/**
 * What a pattern is being asked to predict.
 *
 * Peak, not graduation, is the target this search can actually support. Graduation happens to about
 * one launch in forty-five, so a window holding seven thousand launches holds perhaps a hundred and
 * sixty of them, and slicing a hundred and sixty events by three hundred conditions leaves nothing
 * anybody should act on. A peak, by contrast, is measured on every launch that traded at all — the
 * question "did this reach 5x" has seven thousand answers, not a hundred and sixty.
 */
export type Target = { label: string; of: (o: Outcome) => number };

export const TARGETS: Record<string, Target> = {
  grad: { label: "graduated", of: (o) => o.graduated },
  x2: { label: "doubled from here", of: (o) => (o.peakAfter >= 2 ? 1 : 0) },
  x3: { label: "tripled from here", of: (o) => (o.peakAfter >= 3 ? 1 : 0) },
  x5: { label: "5x from here", of: (o) => (o.peakAfter >= 5 ? 1 : 0) },
  x10: { label: "10x from here", of: (o) => (o.peakAfter >= 10 ? 1 : 0) },
};

/** A pattern's record over one set of launches. */
export type Verdict = {
  pattern: Pattern;
  n: number;
  hits: number;
  rate: number;
  /** Rate over the base rate of the same set. 1.0 is a pattern that says nothing. */
  lift: number;
};

const quantiles = (values: number[], qs: number[]): number[] => {
  const s = [...values].sort((a, b) => a - b);
  return qs.map((q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]);
};

/**
 * Every condition worth testing, from the data's own distribution.
 *
 * Thresholds are quantiles rather than round numbers so that each one splits the sample somewhere
 * useful: "buyers >= 7" means nothing until you know whether that is the top half or the top
 * thousandth, and a grid of pretty numbers spends most of its candidates on empty slices.
 */
export function candidates(rows: Early[]): Condition[] {
  const out: Condition[] = [];
  for (const field of EARLY_FIELDS) {
    const values = rows.map((r) => r[field] as number).filter((v) => Number.isFinite(v));
    if (!values.length) continue;
    const distinct = new Set(values);
    if (distinct.size < 2) continue;

    // A field with two values needs one split, not nine copies of the same one.
    if (distinct.size === 2) {
      const [lo] = [...distinct].sort((a, b) => a - b);
      out.push({ field, op: ">=", value: lo + Number.EPSILON }, { field, op: "<=", value: lo });
      continue;
    }
    const qs = quantiles(values, [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]);
    const seen = new Set<number>();
    for (const v of qs) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push({ field, op: ">=", value: v }, { field, op: "<=", value: v });
    }
  }
  return out;
}

/**
 * Member indices for every candidate, computed once.
 *
 * The permutation null re-scores the same patterns dozens of times against different labels, and
 * membership does not depend on the labels. Recomputing it per permutation is the difference between
 * a search that runs in seconds and one that runs in minutes.
 */
export function membership(rows: Early[], conds: Condition[]): Int32Array[] {
  return conds.map((c) => {
    const idx: number[] = [];
    for (let i = 0; i < rows.length; i++) if (holds(c, rows[i])) idx.push(i);
    return Int32Array.from(idx);
  });
}

const rateOver = (members: Int32Array, labels: Float64Array): number => {
  if (!members.length) return 0;
  let s = 0;
  for (const i of members) s += labels[i];
  return s / members.length;
};

const intersect = (a: Int32Array, b: Int32Array): Int32Array => {
  const set = new Set(b);
  const out: number[] = [];
  for (const i of a) if (set.has(i)) out.push(i);
  return Int32Array.from(out);
};

export type SearchResult = {
  verdicts: Verdict[];
  /** Everything tested, so the reader knows how many chances the winner had. */
  tested: number;
  baseRate: number;
};

/**
 * The search itself: single conditions, then pairs of the most promising ones.
 *
 * Pairs only from the best singles, and only a few of them, because the number of pairs is the
 * square of the number of conditions and every extra candidate is another lottery ticket the search
 * gets to buy. Keeping the ticket count down is not an optimisation, it is the method.
 */
export function search(
  rows: Early[], labels: Float64Array, conds: Condition[], members: Int32Array[],
  minSupport: number, pairFrom = 12,
): SearchResult {
  const base = labels.reduce((s, v) => s + v, 0) / Math.max(1, labels.length);
  const verdicts: Verdict[] = [];

  const single: Array<{ i: number; rate: number }> = [];
  for (let i = 0; i < conds.length; i++) {
    const m = members[i];
    if (m.length < minSupport) continue;
    const rate = rateOver(m, labels);
    single.push({ i, rate });
    verdicts.push({
      pattern: { conditions: [conds[i]] },
      n: m.length, hits: Math.round(rate * m.length), rate, lift: base > 0 ? rate / base : 0,
    });
  }

  let tested = single.length;
  const top = [...single].sort((a, b) => b.rate - a.rate).slice(0, pairFrom);
  for (let a = 0; a < top.length; a++) {
    for (let b = a + 1; b < top.length; b++) {
      const ca = conds[top[a].i];
      const cb = conds[top[b].i];
      // Two thresholds on one field are a range, not a conjunction worth its own ticket.
      if (ca.field === cb.field) continue;
      const m = intersect(members[top[a].i], members[top[b].i]);
      tested++;
      if (m.length < minSupport) continue;
      const rate = rateOver(m, labels);
      verdicts.push({
        pattern: { conditions: [ca, cb] },
        n: m.length, hits: Math.round(rate * m.length), rate, lift: base > 0 ? rate / base : 0,
      });
    }
  }

  verdicts.sort((x, y) => y.lift - x.lift);
  return { verdicts, tested, baseRate: base };
}

/**
 * What the same search finds when there is nothing to find.
 *
 * Shuffling the labels across launches destroys every relationship with the features while leaving
 * both distributions exactly as they were, so the best pattern the search returns afterwards is pure
 * selection: it is what searching this many conditions on this much data buys you for free. Run it
 * enough times and the result is a distribution — and a real pattern has to sit outside it.
 *
 * Seeded, because a null that moves between runs cannot be quoted.
 */
export function permutationNull(
  rows: Early[], labels: Float64Array, conds: Condition[], members: Int32Array[],
  minSupport: number, runs = 100, seed = 0x2545f491,
): { lifts: number[]; p95: number; max: number } {
  let state = seed >>> 0;
  const rand = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };

  const lifts: number[] = [];
  const shuffled = new Float64Array(labels.length);
  for (let r = 0; r < runs; r++) {
    shuffled.set(labels);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
    }
    const res = search(rows, shuffled, conds, members, minSupport);
    lifts.push(res.verdicts[0]?.lift ?? 0);
  }
  lifts.sort((a, b) => a - b);
  return {
    lifts,
    p95: lifts[Math.floor(0.95 * lifts.length)] ?? 0,
    max: lifts[lifts.length - 1] ?? 0,
  };
}

/** A pattern's record over a set it had no part in choosing. */
export function confirm(
  pattern: Pattern, rows: Early[], labels: Float64Array,
): Verdict {
  const idx: number[] = [];
  for (let i = 0; i < rows.length; i++) if (matches(pattern, rows[i])) idx.push(i);
  const base = labels.reduce((s, v) => s + v, 0) / Math.max(1, labels.length);
  let hits = 0;
  for (const i of idx) hits += labels[i];
  const rate = idx.length ? hits / idx.length : 0;
  return { pattern, n: idx.length, hits: Math.round(hits), rate, lift: base > 0 ? rate / base : 0 };
}
