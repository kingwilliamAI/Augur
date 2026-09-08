import { existsSync, readFileSync, statSync } from "node:fs";
import { predictAth, type AthModel } from "./model/ath.ts";
import { datasetWith } from "./score.ts";
import type { DB } from "./db.ts";

/**
 * Loading and applying the peak model, kept apart from fitting it.
 *
 * The board only ever needs to read a fitted model; training pulls in the whole dataset builder and
 * has no business being on the request path.
 */
let cached: { at: number; mtime: number; model: AthModel | null } | null = null;

export function loadAthModel(path = "./data/model-ath.json"): AthModel | null {
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (cached && cached.mtime === mtime && Date.now() - cached.at < 30_000) return cached.model;
  let model: AthModel | null = null;
  try {
    model = JSON.parse(readFileSync(path, "utf8")) as AthModel;
  } catch {
    model = null;
  }
  cached = { at: Date.now(), mtime, model };
  return model;
}

/**
 * The predicted peak for one launch, or null when the launch is not in the feature matrix.
 *
 * Goes through the shared cache rather than rebuilding the matrix: a fresh build costs five seconds
 * on this database, and a synchronous five seconds on the request path is the whole server's, not
 * just this card's.
 */
export function predictAthFor(db: DB, m: AthModel, token: string): { multiple: number; lo: number; hi: number; tailChance: number | null } | null {
  const row = datasetWith(db, token).find((r) => r.token === token);
  return row ? predictAth(m, row.x) : null;
}
