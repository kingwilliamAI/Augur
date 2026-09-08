import { parseAbi, toEventSelector } from "viem";

/**
 * pons v2 ABIs. The struct shapes and event signatures were checked against the live
 * contracts: getLaunchedToken decodes correctly for a known graduated token, and both
 * topic0 values below match logs actually emitted by the factory.
 */
export const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function feeEscrow() view returns (address)",
  "function memeHook() view returns (address)",
  "function launchDeployer() view returns (address)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)",
]);

export const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function snipeTaxExempt(address account) view returns (bool)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event CurveCompleted()",
  // The opening tax has its own event. CurveBuy's `tax` field is the creator's standing tax and is
  // the same on every trade; only wallets that actually raced the 3-second window appear here.
  "event SnipeTaxCharged(address indexed payer, uint256 amount)",
]);

export const tokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "event Credited(address indexed recipient, address indexed depositor, uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
]);

/**
 * The launch entrypoint. `snipeTaxExemptions` is the list of wallets the creator waived the
 * opening tax for: the single most telling field on a fresh launch, and the reason the card
 * decodes the launch transaction's input rather than reading state alone.
 */
export const routerAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
  "event Launched(address indexed token, address indexed curve, address indexed recipient, address launcher, uint256 quoteSpent, uint256 tokensReceived)",
]);

export const TOPIC = {
  tokenLaunched: toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)"),
  poolGraduated: toEventSelector("PoolGraduated(address,uint256,uint256,uint256)"),
  launchSwept: toEventSelector("LaunchSwept(address,uint256,uint256)"),
  creatorFeeRecipientUpdated: toEventSelector("CreatorFeeRecipientUpdated(address,address,address)"),
  curveBuy: toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  curveSell: toEventSelector("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  snipeTaxCharged: toEventSelector("SnipeTaxCharged(address,uint256)"),
  credited: toEventSelector("Credited(address,address,uint256)"),
  claimed: toEventSelector("Claimed(address,uint256)"),
} as const;

/** getLaunchedToken().phase */
export const PHASE = ["curve", "swept", "pool", "rescued"] as const;
export type Phase = (typeof PHASE)[number];
