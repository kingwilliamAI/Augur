import { execFileSync } from "node:child_process";
import { openDb, getMeta } from "../db.ts";
import { assess, SEC_PER_BLOCK } from "../watchdog.ts";

/**
 * Restarts the watcher when it is alive but no longer following the chain.
 *
 * systemd already restarts a process that exits. The failure this covers is the other one: the
 * watcher still running, still answering, and minutes behind — a socket that went quiet without
 * erroring, a catch-up wedged behind a slow read, an endpoint refusing it in a way that retries
 * forever. Half of all graduations happen within two minutes, so a feed a few minutes behind is not
 * a slightly worse feed, it is the wrong one, presented with the same confidence as the right one.
 *
 * Two consecutive bad checks are required before acting. One check catches a passing hiccup and
 * restarting on it would cost more than it fixes: a restart makes the watcher re-read the gap it
 * was already reading. The state lives in the database rather than in memory because this runs from
 * a timer as a fresh process every time.
 *
 * augur watchdog [--behind-sec N] [--silent-sec N] [--restart] [--unit NAME]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const str = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1]) : dflt;
};

/** Lag past which the feed is describing a chain that has moved on. */
const BEHIND_SEC = arg("behind-sec", 300);
/** Silence past which the watcher is not merely behind but gone. */
const SILENT_SEC = arg("silent-sec", 180);
const UNIT = str("unit", "augur-watch");
/** Without this the check reports and changes nothing, which is what a first run should do. */
const RESTART = argv.includes("--restart");

const db = openDb();
const now = Math.floor(Date.now() / 1000);

const head = Number(getMeta(db, "live_head_block") ?? 0);
const seenAt = Number(getMeta(db, "live_seen_at") ?? 0);
const done = (db.prepare("SELECT coalesce(max(block), 0) b FROM launches").get() as { b: number }).b;

const { reasons } = assess({ now, head, seenAt, indexedBlock: done }, { behindSec: BEHIND_SEC, silentSec: SILENT_SEC });

const strikes = Number(getMeta(db, "watchdog_strikes") ?? 0);
const stamp = new Date(now * 1000).toISOString().replace("T", " ").slice(0, 19);

if (reasons.length === 0) {
  if (strikes > 0) console.log(`${stamp}  recovered on its own, clearing ${strikes} strike(s)`);
  db.prepare("INSERT INTO meta(key,value) VALUES('watchdog_strikes','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  db.close();
  process.exit(0);
}

const next = strikes + 1;
console.log(`${stamp}  unhealthy: ${reasons.join(", ")}  (strike ${next})`);

if (next < 2) {
  db.prepare("INSERT INTO meta(key,value) VALUES('watchdog_strikes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(next));
  db.close();
  process.exit(0);
}

if (!RESTART) {
  console.log(`  would restart ${UNIT}; pass --restart to let it`);
  db.close();
  process.exit(0);
}

// Cleared before the restart, not after: if the restart throws, the next run should start from a
// clean count and decide on fresh evidence rather than acting again immediately.
db.prepare("INSERT INTO meta(key,value) VALUES('watchdog_strikes','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
const before = Number(getMeta(db, "watchdog_restarts") ?? 0);
db.prepare("INSERT INTO meta(key,value) VALUES('watchdog_restarts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(String(before + 1));
db.prepare("INSERT INTO meta(key,value) VALUES('watchdog_last_restart',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(String(now));
db.close();

try {
  execFileSync("sudo", ["systemctl", "restart", UNIT], { stdio: "inherit" });
  console.log(`  restarted ${UNIT} (restart #${before + 1} since this database was created)`);
} catch (err) {
  console.error(`  could not restart ${UNIT}: ${(err as Error).message}`);
  process.exit(1);
}
