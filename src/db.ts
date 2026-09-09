import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CFG } from "./config.ts";

/**
 * Money is stored twice on purpose: `*_wei` is the exact integer as a decimal string, `*_eth` is a
 * float for sorting and aggregation. SQLite integers are 64-bit and wei overflows them, so an exact
 * column that SQL can also ORDER BY does not exist. Reads that matter use the wei column.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  token                    TEXT PRIMARY KEY,
  curve                    TEXT NOT NULL,
  deployer                 TEXT NOT NULL,
  pair_token               TEXT NOT NULL,
  launch_config_id         INTEGER NOT NULL,
  graduation_threshold_wei TEXT NOT NULL,
  graduation_threshold_eth REAL NOT NULL,
  block                    INTEGER NOT NULL,
  tx                       TEXT NOT NULL,
  log_index                INTEGER NOT NULL,
  ts                       INTEGER NOT NULL,
  launch_sender            TEXT,
  creator_fee_recipient    TEXT,
  creator_tax_bps          INTEGER,
  buyback_enabled          INTEGER,
  initial_buy_wei          TEXT,
  initial_buy_eth          REAL,
  initial_tokens           TEXT,
  exempt_count             INTEGER,
  name                     TEXT,
  symbol                   TEXT,
  description              TEXT,
  socials_json             TEXT,
  symbol_key               TEXT,
  phase                    INTEGER NOT NULL DEFAULT 0,
  enriched_at              INTEGER,
  first_seen_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_launches_deployer ON launches(deployer);
-- The address a card calls the creator is launch_sender, the wallet that sent the transaction,
-- not the deployer the event names. The two differ on a sixth of launches, and Multicall3, a
-- deployer that is nobody's creator, is the second busiest address in that column. So a wallet
-- someone read off a card is looked up here, and without an index that is a scan of every launch
-- ever seen: 51 ms against 0.3 ms.
CREATE INDEX IF NOT EXISTS ix_launches_sender ON launches(launch_sender);
CREATE INDEX IF NOT EXISTS ix_launches_ts       ON launches(ts DESC);
CREATE INDEX IF NOT EXISTS ix_launches_block    ON launches(block);
CREATE INDEX IF NOT EXISTS ix_launches_phase    ON launches(phase);
-- Copies of a launch share its ticker under case, spacing and emoji differences; the normalised
-- key is what makes "how many times has this name been launched" a single indexed lookup.
CREATE INDEX IF NOT EXISTS ix_launches_symkey   ON launches(symbol_key, block);

-- Wallets the creator waived the 99% opening tax for. Declared in the launch tx input.
CREATE TABLE IF NOT EXISTS exemptions (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (token, address)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_exempt_address ON exemptions(address);

CREATE TABLE IF NOT EXISTS graduations (
  token        TEXT PRIMARY KEY,
  block        INTEGER NOT NULL,
  tx           TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  position_id  TEXT NOT NULL,
  token_amount TEXT NOT NULL,
  pair_wei     TEXT NOT NULL,
  pair_eth     REAL NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_grad_ts ON graduations(ts DESC);

CREATE TABLE IF NOT EXISTS sweeps (
  token     TEXT PRIMARY KEY,
  block     INTEGER NOT NULL,
  tx        TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  quote_wei TEXT NOT NULL,
  quote_eth REAL NOT NULL,
  token_out TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS curve_trades (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  side      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  recipient TEXT NOT NULL,
  quote_wei TEXT NOT NULL,
  quote_eth REAL NOT NULL,
  token_amt TEXT NOT NULL,
  fee_wei   TEXT NOT NULL,
  tax_wei   TEXT NOT NULL,
  tax_eth   REAL NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_trades_token ON curve_trades(token, block);
CREATE INDEX IF NOT EXISTS ix_trades_actor ON curve_trades(recipient);

-- Wallets that bought inside the 3-second opening window and were charged for it. Separate from
-- curve_trades because the tax field on CurveBuy is the creator's standing tax, identical on every
-- trade; only a racer appears here, and only a handful per launch do.
CREATE TABLE IF NOT EXISTS snipe_tax (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  payer     TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  block     INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_snipe_token ON snipe_tax(token);
CREATE INDEX IF NOT EXISTS ix_snipe_payer ON snipe_tax(payer);

-- Per-token indexing state: curve logs are fetched on demand, so we record how far each token got.
CREATE TABLE IF NOT EXISTS curve_indexed (
  token      TEXT PRIMARY KEY,
  to_block   INTEGER NOT NULL,
  trades     INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
) STRICT;

-- What a curve did, kept once its individual trades are gone.
--
-- Storing every trade forever does not scale: a trade costs about 490 bytes with its indexes, a
-- read curve carries 65 of them, and 26,000 launches happen a day. Reading every curve and keeping
-- every row would be roughly 830 MB a day. Almost none of that detail is read after the launch is
-- a day old, but the numbers computed from it are read forever, so the numbers are what survive.
--
-- The scalar prices are here rather than only inside the JSON because the peak model and the
-- creator rankings ask for them across thousands of tokens at once, and a query cannot sort on a
-- field it has to parse first. They are raw quote units per token unit, the same scale the trades
-- were in, so a ratio between them means what it meant before.
CREATE TABLE IF NOT EXISTS curve_summary (
  token        TEXT PRIMARY KEY,
  first_price  REAL NOT NULL,
  peak_price   REAL NOT NULL,
  last_price   REAL NOT NULL,
  trades       INTEGER NOT NULL,
  buys         INTEGER NOT NULL,
  sells        INTEGER NOT NULL,
  -- The rest of CurveStats, computed while the rows still existed.
  stats_json   TEXT NOT NULL,
  compacted_at INTEGER NOT NULL,
  -- Raw token units the creator bought in their own launch block. Stored rather than derived
  -- because it lives only in the trades, and the trades are what this row exists to replace.
  self_buy_tokens REAL
) STRICT;

-- Price, volume and fees over time, for the one coin this site is about.
--
-- The swap stream is folded to a high, low and last per pool because 3.4 million swaps a day pass
-- through the singleton and keeping them all is what the disk cannot afford. That fold is right for
-- four thousand pools and wrong for the single pool the coin page is about, which wants a shape over
-- time. So this is the exception, and it is bounded by being an exception: one pool at roughly five
-- minutes a bar is 288 rows a day.
--
-- Everything here comes out of the Swap event we already decode. It carries both amounts, the price,
-- the pool's liquidity and its fee rate; we were reading the price and discarding the rest.
CREATE TABLE IF NOT EXISTS coin_bars (
  pool_id    TEXT NOT NULL,
  bucket     INTEGER NOT NULL,
  open_sqrt  TEXT NOT NULL,
  hi_sqrt    TEXT NOT NULL,
  lo_sqrt    TEXT NOT NULL,
  close_sqrt TEXT NOT NULL,
  swaps      INTEGER NOT NULL,
  vol_quote  TEXT NOT NULL,
  fee_quote  TEXT NOT NULL,
  liquidity  TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  PRIMARY KEY (pool_id, bucket)
) STRICT;

-- Creator fees, as they are actually paid: in sweeps, not per swap.
--
-- The pool's own fee field is zero on every swap, which is what made this look unreadable at first.
-- pons does not charge at the pool; its hook accrues and then sweeps, emitting one event per sweep
-- keyed by pool id. Summed over one token's history the third word of that event came to 73.713673
-- ETH against the 74.164802 the pons page reports, the gap being twelve sweeps outside the range
-- read. So this is the number, and it is checkable against a public page.
--
-- Rows rather than a running total, because a ledger of recent sweeps is worth showing.
CREATE TABLE IF NOT EXISTS coin_sweeps (
  pool_id   TEXT NOT NULL,
  block     INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  fee_quote TEXT NOT NULL,
  other     TEXT NOT NULL,
  PRIMARY KEY (pool_id, block, log_index)
) STRICT;

-- Telegram subscribers, and what has already been sent to each.
--
-- The bot is the one part of this project that talks to a third party, so what it may do is narrow
-- by construction. A chat exists in this table only because someone sent /start from it, which is
-- what keeps the promise on the Telegram page that the bot never messages anyone first. Nothing
-- here identifies a person: a chat id is what Telegram hands us and all we can act on.
CREATE TABLE IF NOT EXISTS tg_subs (
  chat_id    INTEGER PRIMARY KEY,
  min_score  REAL NOT NULL,
  quiet      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL DEFAULT 0
) STRICT;

-- One alert per launch per chat, ever. A launch stays above the threshold for as long as it is in
-- the window, so without this the same token would be re-sent on every pass.
CREATE TABLE IF NOT EXISTS tg_sent (
  chat_id INTEGER NOT NULL,
  token   TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, token)
) STRICT;
CREATE INDEX IF NOT EXISTS tg_sent_at ON tg_sent(sent_at);

-- Wallets a chat asked to be told about by name, rather than by score.
--
-- The alert this feeds is the one case where a launch nobody would rank goes out anyway: a reader
-- who followed a wallet has already decided that this wallet is the signal, and a score floor
-- applied on top would quietly overrule them. It is capped by how many wallets a chat may hold
-- rather than by what they may be told, so the cost of the feature is bounded without the promise
-- being hedged.
CREATE TABLE IF NOT EXISTS tg_follows (
  chat_id    INTEGER NOT NULL,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, address)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_follows_addr ON tg_follows(address);

-- Launches a chat is holding and wants watched for arrivals, and who it has been told about.
--
-- This is the only thing the bot does that the watcher has not already collected: curve trades are
-- read per token and on demand, so a tracked token is a request per pass and the list is capped
-- because of it. The from_block column is where watching began, never the launch — a wallet that entered
-- before anybody asked is history, and this table exists to deliver warnings.
CREATE TABLE IF NOT EXISTS tg_tracks (
  chat_id    INTEGER NOT NULL,
  token      TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, token)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_tracks_token ON tg_tracks(token);

-- One message per wallet per token per chat. A wallet that keeps buying is the same arrival, and
-- being told about it again on every pass is how a useful alert turns into a reason to mute the bot.
CREATE TABLE IF NOT EXISTS tg_trader_sent (
  chat_id INTEGER NOT NULL,
  token   TEXT NOT NULL,
  trader  TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, token, trader)
) STRICT;

-- The wallet a chat has proved it controls, and what its balance currently buys.
--
-- Proof is a signature over a sentence this table issued, which costs no gas and moves nothing; the
-- bot never sees a key and never sends a transaction. Only the address survives the check, because
-- the address is the only part a balance can be read against.
--
-- One address, one chat: without the UNIQUE a single holder could open the paid half for any number
-- of chats by signing the same sentence in each of them, and the tier would stop meaning that this
-- reader holds anything.
--
-- raw_tier is what the balance says right now and tier is what the reader actually gets. They
-- differ for a week after a sell, which is the whole point of keeping both: a tier that could be
-- dropped and reclaimed within a block is a tier that can be borrowed for the minute an alert is
-- worth, and then returned.
CREATE TABLE IF NOT EXISTS wallet_links (
  chat_id     INTEGER PRIMARY KEY,
  address     TEXT NOT NULL UNIQUE,
  linked_at   INTEGER NOT NULL,
  balance     TEXT NOT NULL DEFAULT '0',
  checked_at  INTEGER NOT NULL DEFAULT 0,
  tier        INTEGER NOT NULL DEFAULT 0,
  raw_tier    INTEGER NOT NULL DEFAULT 0,
  -- When the balance last reached the level it is at now. A grant after a sell waits from here.
  raw_since   INTEGER NOT NULL DEFAULT 0,
  -- When a sell last cost this wallet a tier. Null means it has never dropped, and the first grant
  -- is immediate: the week is a penalty for selling, not a queue for arriving.
  dropped_at  INTEGER,
  -- Continuous holding at tier 1 or above, for the streak. Cleared by any drop below it.
  streak_from INTEGER,
  -- A link made on the website happens where the bot is not looking, so the chat has to be told
  -- about it afterwards. Null means nobody has been told yet.
  announced_at INTEGER
) STRICT;

-- Sentences waiting to be signed. Short-lived on purpose: a challenge that never expires is a
-- signature somebody can be talked into producing today and have used against them next month.
CREATE TABLE IF NOT EXISTS link_challenges (
  chat_id   INTEGER PRIMARY KEY,
  -- The secret in the URL the bot hands out. Whoever holds it can prove a wallet into this chat,
  -- which is why it is unguessable and short-lived; what it cannot do is prove somebody else's.
  token     TEXT NOT NULL UNIQUE,
  -- Null until a wallet is named: the page fills it in when one connects, and the manual path
  -- fills it in from the address typed after /link.
  address   TEXT,
  nonce     TEXT NOT NULL,
  issued_at INTEGER NOT NULL
) STRICT;

-- API keys, one per linked chat. The key stands in for the address so a caller never has to send a
-- signature with a request, and it is revoked by unlinking, which is the same act that gave it.
CREATE TABLE IF NOT EXISTS api_keys (
  key        TEXT PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL DEFAULT 0,
  calls      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS ix_api_keys_chat ON api_keys(chat_id);

CREATE TABLE IF NOT EXISTS pools (
  token       TEXT PRIMARY KEY,
  pool_id     TEXT NOT NULL,
  currency0   TEXT NOT NULL,
  currency1   TEXT NOT NULL,
  token_is_c1 INTEGER NOT NULL,
  dec0        INTEGER NOT NULL,
  dec1        INTEGER NOT NULL,
  init_block  INTEGER NOT NULL,
  init_sqrt   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS pools_pool ON pools(pool_id);

CREATE TABLE IF NOT EXISTS pool_peaks (
  pool_id    TEXT PRIMARY KEY,
  min_sqrt   TEXT NOT NULL,
  max_sqrt   TEXT NOT NULL,
  min_block  INTEGER NOT NULL,
  max_block  INTEGER NOT NULL,
  last_sqrt  TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  swaps      INTEGER NOT NULL,
  to_block   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS fee_events (
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  recipient TEXT NOT NULL,
  depositor TEXT,
  amount_wei TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_fee_recipient ON fee_events(recipient);

-- What the splitter did with the fees, one row per release.
--
-- The three destinations are fixed in the contract and the shares are immutable, so this table is
-- not where the arrangement is kept: it is where the arrangement is checked. Every row carries the
-- transaction it came from, which is the whole point of putting the split on chain rather than
-- describing it on a page.
CREATE TABLE IF NOT EXISTS fee_splits (
  tx           TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  -- The zero address for the chain's own currency, or the ERC-20 the fee arrived in.
  asset        TEXT NOT NULL,
  total_wei    TEXT NOT NULL,
  server_wei   TEXT NOT NULL,
  holders_wei  TEXT NOT NULL,
  buyback_wei  TEXT NOT NULL,
  total_eth    REAL NOT NULL,
  block        INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_splits_block ON fee_splits(block DESC);

-- Payouts made by the wallet itself, one row per transfer, written after the receipt.
--
-- The splitter contract and this table describe the same arrangement carried out two different ways,
-- and the ledger page says which paid each line rather than blending them. A row is written only
-- once the transaction is mined, so a run that dies halfway leaves what actually happened and not
-- what was intended: the point of a ledger is that it cannot flatter the operator.
--
-- run_id groups the transfers of one run, so three lines a second apart read as one split.
CREATE TABLE IF NOT EXISTS payouts (
  tx         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  asset      TEXT NOT NULL,
  sender     TEXT NOT NULL,
  address    TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  bps        INTEGER NOT NULL,
  block      INTEGER,
  ts         INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_payouts_ts ON payouts(ts DESC);

CREATE TABLE IF NOT EXISTS fee_recipient_changes (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  prev      TEXT NOT NULL,
  next      TEXT NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_feechg_token ON fee_recipient_changes(token);

-- Not every launch is quoted in ETH: roughly half pair against another token, whose decimals
-- differ. Formatting those amounts as 1e18 wei silently prints 0.0000 for real, non-zero values.
CREATE TABLE IF NOT EXISTS quote_assets (
  address  TEXT PRIMARY KEY,
  symbol   TEXT,
  decimals INTEGER NOT NULL
) STRICT;

-- What the tool claimed, written before the outcome existed.
--
-- Offline validation answers "this would have worked on data we already had". Only a log written
-- ahead of the fact answers "this works", and only if it cannot be revised afterwards: the primary
-- key is the token and inserts never update, so the first claim made about a launch is the one that
-- gets graded. model_id fingerprints the model file, so a retrain starts a new era in the numbers
-- instead of quietly mixing into the old one.
CREATE TABLE IF NOT EXISTS predictions (
  token        TEXT PRIMARY KEY,
  launch_ts    INTEGER NOT NULL,
  scored_at    INTEGER NOT NULL,
  age_at_score INTEGER NOT NULL,
  probability  REAL NOT NULL,
  -- The model's own opinion, before any live correction. The probability column above is the claim
  -- as shown; this is what a refit is fitted against, so a correction is never measured on itself.
  raw_probability REAL,
  rank         INTEGER NOT NULL,
  of           INTEGER NOT NULL,
  model_id     TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  graded_at    INTEGER,
  label        INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pred_pending ON predictions(graded_at, launch_ts);
CREATE INDEX IF NOT EXISTS ix_pred_model   ON predictions(model_id, probability DESC);
-- The alert path asks this several times a minute, forever, against a table that grows by about
-- twenty-four thousand rows a day. Unindexed it was a 6.7ms scan at thirteen thousand rows, which
-- is nothing now and a third of a second by the end of the month.
CREATE INDEX IF NOT EXISTS ix_pred_recent  ON predictions(launch_ts, probability DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

export type DB = DatabaseSync;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
 * database, so a new column never appears and any index over it fails the whole schema step. These
 * run before the schema, which keeps an old database openable instead of unopenable.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "launches", column: "symbol_key", ddl: "ALTER TABLE launches ADD COLUMN symbol_key TEXT" },
  // The model's own opinion, before any live correction was applied to it. `probability` stays the
  // number that was shown, because that is the claim; this is what the correction must be refitted
  // against, or each pass would correct an already-corrected score and drift downward unnoticed.
  { table: "predictions", column: "raw_probability", ddl: "ALTER TABLE predictions ADD COLUMN raw_probability REAL" },
  // The share of supply a creator took in their own launch is a red flag worth keeping, and it was
  // readable only from the trades, so shortening how long trades are kept would have retired it.
  { table: "curve_summary", column: "self_buy_tokens", ddl: "ALTER TABLE curve_summary ADD COLUMN self_buy_tokens REAL" },
];

/**
 * The project has been renamed three times: ponscan, then Poolitzer, then Gimlet, now Augur. Each
 * time there were databases already on disk. A database is days of collected history that cannot be
 * re-fetched cheaply, so the default path must never silently start over: if the current file is
 * absent and an older one is present, the older one is moved into place, together with its WAL and
 * shared-memory sidecars, which carry unflushed writes and must travel with it.
 *
 * A list rather than a single hop, newest first, so a machine left at any past name catches up in
 * one step instead of needing the renames replayed in order.
 */
const LEGACY_DB_NAMES = ["gimlet.db", "poolitzer.db", "ponscan.db"] as const;

function adoptLegacyDatabase(path: string): void {
  if (basename(path) !== "augur.db" || existsSync(path)) return;
  for (const name of LEGACY_DB_NAMES) {
    const legacy = join(dirname(path), name);
    if (!existsSync(legacy)) continue;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
    }
    return;
  }
}

export function openDb(path: string = CFG.dbPath): DB {
  mkdirSync(dirname(path), { recursive: true });
  adoptLegacyDatabase(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  for (const m of MIGRATIONS) {
    const exists = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(m.table) as { c: number }).c > 0;
    if (!exists) continue;
    const cols = (db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(m.ddl);
  }

  db.exec(SCHEMA);
  return db;
}

export const getMeta = (db: DB, key: string): string | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setMeta = (db: DB, key: string, value: string): void => {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};

/** 1e18 wei to ETH as a float. Only ever used for sorting and display, never for exactness. */
export const toEth = (wei: bigint): number => Number(wei) / 1e18;

/**
 * Arbitrum Nitro can reorganise recent blocks before L1 finality. Ingest is idempotent by primary
 * key, so a replay overwrites rather than duplicates, but rows from an orphaned block must go.
 */
export function rollbackFrom(db: DB, block: number): void {
  for (const t of ["launches", "graduations", "sweeps", "curve_trades", "fee_events", "fee_recipient_changes"]) {
    db.prepare(`DELETE FROM ${t} WHERE block >= ?`).run(block);
  }
  db.prepare("DELETE FROM exemptions WHERE token NOT IN (SELECT token FROM launches)").run();
}
