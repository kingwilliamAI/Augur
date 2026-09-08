import { readFileSync, existsSync } from "node:fs";
import type { Address } from "viem";

/** Minimal .env loader. Keeps the dependency list at one (viem). */
function loadEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] === undefined) process.env[k] = raw.replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const str = (k: string, d: string): string => process.env[k]?.trim() || d;
const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const CFG = {
  /** Only this endpoint serves eth_getLogs on Robinhood Chain. */
  httpUrl: str("RPC_HTTP_URL", "https://rpc.mainnet.chain.robinhood.com"),
  /** Faster and more generous, but refuses eth_getLogs. Used for contract reads. */
  stateUrl: str("RPC_STATE_URL", "https://robinhood-rpc.publicnode.com"),
  /** "off" disables push detection and falls back to polling. */
  wsUrl: str("RPC_WS_URL", "wss://robinhood-rpc.publicnode.com"),
  pollMs: num("POLL_MS", 300),
  inFlight: num("RPC_IN_FLIGHT", 3),
  spacingMs: num("RPC_SPACING_MS", 60),
  logsChunk: num("LOGS_CHUNK_BLOCKS", 60_000),
  logsSpacingMs: num("LOGS_SPACING_MS", 400),
  /**
   * The token the coin page is about.
   *
   * $AUGUR does not exist yet, and a page that describes a coin is only worth reading if the
   * numbers on it are real. So this points at a launched token in the meantime and the page says
   * plainly that it is standing in; when the real one launches this is the only line that changes.
   *
   * Empty turns the coin page back into the "not launched" notice.
   */
  coinToken: str("COIN_TOKEN", "0xb19f5a6e22f9057980b08ff05b7f5a6878ab0c8a").toLowerCase(),
  /** Set once $AUGUR itself is the token above, so the page stops calling itself a stand-in. */
  coinIsOurs: str("COIN_IS_OURS", "0") === "1",
  /**
   * Who stands behind the coin, so a reader can check the name against an account rather than
   * against this page alone. A page vouching only for itself is worth nothing to someone deciding
   * whether an address is genuine.
   *
   * The handle only, without the @ or the URL. Empty hides the line rather than showing a dead one.
   */
  coinX: str("COIN_X", "kingwilliam_"),
  /** Public source for the coin, once there is one. Empty until then. */
  coinRepo: str("COIN_REPO", ""),
  dbPath: str("DB_PATH", "./data/augur.db"),
  boardPort: num("BOARD_PORT", 4663),
  /**
   * Interface the board listens on. Defaults to every interface, which is what a local run wants.
   * Behind a reverse proxy set it to 127.0.0.1: otherwise the port stays reachable directly, and a
   * request that skips the proxy also skips its TLS and arrives with no forwarded address, so rate
   * limiting counts the whole internet as one client.
   */
  boardHost: str("BOARD_HOST", "0.0.0.0"),
} as const;

/**
 * pons v2. Every address here was confirmed against the live factory's own getters
 * (feeEscrow(), memeHook(), launchDeployer()) on 2026-09-06, not copied from docs:
 * docs.ponsfamily.com still defaults to the v1 page, whose factory has been idle for weeks.
 */
export const ADDR = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  deployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  /** Canonical Multicall3. The chain docs list an "L2 Multicall" that is not aggregate3-compatible. */
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

/** ~0.1009 s per block, measured over 1M blocks on 2026-09-06. */
export const BLOCKS_PER_DAY = 856_582;
/** The factory's first block. Backfill never needs to look further back than this. */
export const FACTORY_START_BLOCK = 0;

export const EXPLORER = {
  tx: (h: string): string => `https://robinhoodchain.blockscout.com/tx/${h}`,
  address: (a: string): string => `https://robinhoodchain.blockscout.com/address/${a}`,
  token: (a: string): string => `https://robinhoodchain.blockscout.com/token/${a}`,
  pons: (a: string): string => `https://www.ponsfamily.com/token/${a}`,
  /**
   * A place to trade the thing, one tap from an alert.
   *
   * `chain` is the part that matters: without it the address is looked up on the wrong chain. The
   * other parameters a shared link carries are that reader's own sidebar state, so they are left off
   * rather than imposed on everyone who taps.
   */
  axiom: (a: string): string => `https://axiom.trade/token/${a}?chain=robinhood`,
} as const;
