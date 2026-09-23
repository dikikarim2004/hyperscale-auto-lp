/**
 * Per-user config defaults — the exact same values that used to live in
 * config.js as `u.xxx ?? <default>`. Every field from user-config.example.json
 * and config.js is represented here so nothing is lost in the move from a
 * single shared user-config.json file to a per-telegramId Postgres row.
 *
 * Shape mirrors config.js's `config` export 1:1 (same section names, same
 * field names) so downstream modules that destructure `config.screening.minTvl`
 * etc. keep working once they're switched from the old singleton import to
 * `getUserConfig(telegramId)`.
 */

export const MIN_SAFE_BINS_BELOW = 35;

export const CONFIG_SECTION_KEYS = [
  "risk", "screening", "management", "strategy", "schedule", "llm", "darwin",
  "hiveMind", "api", "pnl", "opportunity", "gmgn", "indicators",
  "technicalAnalysis", "riskManagement", "onChainIntelligence", "execution",
];

export const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
export const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
export const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
export const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const DEFAULT_PNL_RPC_URL = "https://pump.helius-rpc.com";

export const DEFAULT_CONFIG_SECTIONS = {
  risk: {
    maxPositions: 1,
    maxDeployAmount: 0.1,
  },
  screening: {
    excludeHighSupplyConcentration: true,
    minFeeActiveTvlRatio: 0.06,
    minTvl: 10_000,
    maxTvl: 150_000,
    minVolume: 1000,
    minOrganic: 60,
    minQuoteOrganic: 60,
    minHolders: 500,
    minMcap: 100_000,
    maxMcap: 10_000_000,
    minBinStep: 80,
    maxBinStep: 125,
    timeframe: "5m",
    category: "trending",
    minTokenFeesSol: 20,
    useDiscordSignals: false,
    discordSignalMode: "merge",
    avoidPvpSymbols: true,
    blockPvpSymbols: false,
    maxBotHoldersPct: 35,
    maxTop10Pct: 60,
    loneCandidateMinDegen: 50,
    allowedLaunchpads: [],
    blockedLaunchpads: [],
    minTokenAgeHours: null,
    maxTokenAgeHours: 72,
  },
  management: {
    minClaimAmount: 5,
    autoSwapAfterClaim: true,
    autoSwapRetryAttempts: 3,
    autoSwapRetryDelayMs: 3000,
    outOfRangeBinsToClose: 1,
    outOfRangeWaitMinutes: 1,
    oorCooldownTriggerCount: 1,
    oorCooldownHours: 4,
    repeatDeployCooldownEnabled: true,
    repeatDeployCooldownTriggerCount: 3,
    repeatDeployCooldownHours: 12,
    repeatDeployCooldownScope: "token",
    repeatDeployCooldownMinFeeEarnedPct: -100,
    repeatLossCooldownEnabled: true,
    repeatLossCooldownTriggerCount: 1,
    repeatLossCooldownHours: 12,
    repeatLossCooldownScope: "token",
    repeatLossCooldownMinLossPct: -4,
    minVolumeToRebalance: 1000,
    stopLossPct: -5,
    takeProfitPct: 5,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 30,
    minSolToOpen: 0.1,
    deployAmountSol: 0.1,
    gasReserve: 0.02,
    positionSizePct: 0.35,
    trailingTakeProfit: true,
    trailingTriggerPct: 0.5,
    trailingDropPct: 0.25,
    pnlSanityMaxDiffPct: 5,
    solMode: false,
  },
  strategy: {
    strategy: "spot",
    minBinsBelow: MIN_SAFE_BINS_BELOW,
    maxBinsBelow: 69,
    defaultBinsBelow: 69,
  },
  schedule: {
    managementIntervalMin: 10,
    screeningIntervalMin: 5,
    healthCheckIntervalMin: 60,
  },
  llm: {
    temperature: 0.373,
    maxTokens: 4096,
    maxSteps: 20,
    managementModel: "openai/gpt-4o-mini",
    screeningModel: "openai/gpt-4o-mini",
    generalModel: "openai/gpt-4o-mini",
  },
  darwin: {
    enabled: true,
    windowDays: 60,
    recalcEvery: 5,
    boostFactor: 1.05,
    decayFactor: 0.95,
    weightFloor: 0.3,
    weightCeiling: 2.5,
    minSamples: 10,
  },
  hiveMind: {
    url: "",
    agentId: null,
    pullMode: "auto",
  },
  api: {
    agentMeridianApiUrl: DEFAULT_AGENT_MERIDIAN_API_URL,
    lpAgentRelayEnabled: false,
  },
  pnl: {
    source: "rpc",
    pollIntervalSec: 3,
    depositCacheTtlSec: 300,
    confirmTicks: 1,
  },
  opportunity: {
    enabled: true,
    pollIntervalSec: 45,
    limit: 10,
    minScore: 40,
    smartWalletScoreBonus: 20,
    targetVolRatio: 20,
    targetLpCount: 40,
    targetFeeRatio: 0.20,
    targetLiquidity: 20000,
  },
  gmgn: {
    baseUrl: "https://openapi.gmgn.ai",
    requestDelayMs: 2500,
    maxRetries: 2,
    feeSource: "gmgn",
  },
  indicators: {
    enabled: true,
    entryPreset: "supertrend_break",
    exitPreset: "supertrend_break",
    rsiLength: 2,
    intervals: ["5_MINUTE"],
    candles: 298,
    rsiOversold: 30,
    rsiOverbought: 80,
    requireAllIntervals: false,
  },
  technicalAnalysis: {
    enabled: true,
    interval: "15_MINUTE",
    candles: 120,
    rsi: { period: 14, overboughtThreshold: 70, oversoldThreshold: 30 },
    macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    volume: { spikeMultiplier: 2, declineThreshold: 0.5 },
    supportResistance: { enabled: true, windowPeriods: 20 },
  },
  riskManagement: {
    stopLossATRMultiplier: 1.5,
    atrPeriod: 14,
    minStopLossPct: -5,
    maxStopLossPct: -5,
    atrInterval: "15_MINUTE",
    atrCandles: 120,
  },
  onChainIntelligence: {
    enabled: true,
    smartMoney: {
      minNetBuyUsd: 50000,
      maxNetSellUsd: 30000,
      timeWindowMinutes: 5,
      requireSmartMoneyForDeploy: false,
    },
    holderConcentration: {
      maxTop10Pct: 60,
      maxTop50Pct: 80,
      alertWhaleDump: true,
      whaleDumpThresholdPct: 5,
    },
    devWallet: {
      maxDevHoldingsPct: 10,
      monitorActivity: true,
      cooldownHours: 24,
    },
  },
  execution: {
    confirmationTimeoutMs: 60_000,
    requireFinalized: false,
    retryOnTimeout: true,
    retryAttempts: 1,
    usePriorityFeeOnRetry: true,
    priorityFeeMultiplier: 2,
    priorityFeeFallbackMicroLamports: 5_000,
  },
};

export const DEFAULT_SECRET_DEFAULTS = {
  rpcUrl: DEFAULT_RPC_URL,
  pnlRpcUrl: DEFAULT_PNL_RPC_URL,
  hiveMindApiKey: null,
  publicApiKey: null,
  agentMeridianApiUrl: DEFAULT_AGENT_MERIDIAN_API_URL,
};
