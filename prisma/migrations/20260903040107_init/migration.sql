-- CreateTable
CREATE TABLE "users" (
    "telegramId" TEXT NOT NULL,
    "telegramUsername" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "wallets" (
    "telegramId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastExportedAt" TIMESTAMP(3),
    "exportCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "user_configs" (
    "telegramId" TEXT NOT NULL,
    "risk" JSONB NOT NULL DEFAULT '{}',
    "screening" JSONB NOT NULL DEFAULT '{}',
    "management" JSONB NOT NULL DEFAULT '{}',
    "strategy" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "llm" JSONB NOT NULL DEFAULT '{}',
    "darwin" JSONB NOT NULL DEFAULT '{}',
    "hiveMind" JSONB NOT NULL DEFAULT '{}',
    "api" JSONB NOT NULL DEFAULT '{}',
    "pnl" JSONB NOT NULL DEFAULT '{}',
    "opportunity" JSONB NOT NULL DEFAULT '{}',
    "gmgn" JSONB NOT NULL DEFAULT '{}',
    "jupiter" JSONB NOT NULL DEFAULT '{}',
    "indicators" JSONB NOT NULL DEFAULT '{}',
    "technicalAnalysis" JSONB NOT NULL DEFAULT '{}',
    "riskManagement" JSONB NOT NULL DEFAULT '{}',
    "onChainIntelligence" JSONB NOT NULL DEFAULT '{}',
    "execution" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_configs_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "user_secrets" (
    "telegramId" TEXT NOT NULL,
    "rpcUrlEnc" TEXT,
    "pnlRpcUrlEnc" TEXT,
    "heliusApiKeyEnc" TEXT,
    "llmBaseUrlEnc" TEXT,
    "llmApiKeyEnc" TEXT,
    "openrouterApiKeyEnc" TEXT,
    "gmgnApiKeyEnc" TEXT,
    "jupiterApiKeyEnc" TEXT,
    "jupiterReferralAccount" TEXT,
    "jupiterReferralFeeBps" INTEGER,
    "lpAgentApiKeyEnc" TEXT,
    "hiveMindApiKeyEnc" TEXT,
    "publicApiKeyEnc" TEXT,
    "agentMeridianApiUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_secrets_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "positionAddress" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "poolName" TEXT,
    "strategy" TEXT,
    "binRange" JSONB,
    "amountSol" DOUBLE PRECISION,
    "amountX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activeBinAtDeploy" INTEGER,
    "binStep" INTEGER,
    "volatility" DOUBLE PRECISION,
    "feeTvlRatio" DOUBLE PRECISION,
    "initialFeeTvl24h" DOUBLE PRECISION,
    "organicScore" DOUBLE PRECISION,
    "initialValueUsd" DOUBLE PRECISION,
    "entryMcap" DOUBLE PRECISION,
    "entryTvl" DOUBLE PRECISION,
    "entryVolume" DOUBLE PRECISION,
    "entryHolders" INTEGER,
    "signalSnapshot" JSONB,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outOfRangeSince" TIMESTAMP(3),
    "lastClaimAt" TIMESTAMP(3),
    "totalFeesClaimedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rebalanceCount" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "peakPnlPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pendingPeakPnlPct" DOUBLE PRECISION,
    "pendingPeakConfirmCount" INTEGER NOT NULL DEFAULT 0,
    "pendingPeakStartedAt" TIMESTAMP(3),
    "pendingExitAction" TEXT,
    "pendingExitCount" INTEGER NOT NULL DEFAULT 0,
    "pendingExitStartedAt" TIMESTAMP(3),
    "trailingActive" BOOLEAN NOT NULL DEFAULT false,
    "instruction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_events" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "position" TEXT,
    "poolName" TEXT,
    "reason" TEXT,

    CONSTRAINT "position_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_logs" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "pool" TEXT,
    "poolName" TEXT,
    "position" TEXT,
    "summary" TEXT,
    "reason" TEXT,
    "risks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metrics" JSONB,
    "rejected" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "role" TEXT,
    "outcome" TEXT,
    "source" TEXT NOT NULL DEFAULT 'local',
    "score" DOUBLE PRECISION,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_records" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "poolName" TEXT,
    "strategy" TEXT,
    "binRange" JSONB,
    "binStep" INTEGER,
    "volatility" DOUBLE PRECISION,
    "feeTvlRatio" DOUBLE PRECISION,
    "organicScore" DOUBLE PRECISION,
    "amountSol" DOUBLE PRECISION,
    "feesEarnedUsd" DOUBLE PRECISION,
    "feesEarnedSol" DOUBLE PRECISION,
    "finalValueUsd" DOUBLE PRECISION,
    "initialValueUsd" DOUBLE PRECISION,
    "minutesInRange" INTEGER,
    "minutesHeld" INTEGER,
    "closeReason" TEXT,
    "pnlUsd" DOUBLE PRECISION,
    "pnlPct" DOUBLE PRECISION,
    "rangeEfficiency" DOUBLE PRECISION,
    "signalSnapshot" JSONB,
    "baseMint" TEXT,
    "entryMcap" DOUBLE PRECISION,
    "entryTvl" DOUBLE PRECISION,
    "entryVolume" DOUBLE PRECISION,
    "exitMcap" DOUBLE PRECISION,
    "exitTvl" DOUBLE PRECISION,
    "exitVolume" DOUBLE PRECISION,
    "deployedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_weights" (
    "telegramId" TEXT NOT NULL,
    "weights" JSONB NOT NULL DEFAULT '{}',
    "lastRecalc" TIMESTAMP(3),
    "recalcCount" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "signal_weights_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "smart_wallets" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT NOT NULL,
    "category" TEXT,
    "type" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smart_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategies" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "strategyKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "author" TEXT,
    "lpStrategy" TEXT,
    "tokenCriteria" JSONB,
    "entry" JSONB,
    "range" JSONB,
    "exit" JSONB,
    "bestFor" TEXT,
    "raw" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_blacklist_entries" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT,
    "reason" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" TEXT NOT NULL DEFAULT 'user',

    CONSTRAINT "token_blacklist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dev_blocklist_entries" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "label" TEXT,
    "reason" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dev_blocklist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_memories" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "name" TEXT,
    "baseMint" TEXT,
    "totalDeploys" INTEGER NOT NULL DEFAULT 0,
    "avgPnlPct" DOUBLE PRECISION,
    "winRate" DOUBLE PRECISION,
    "adjustedWinRate" DOUBLE PRECISION,
    "adjustedWinRateSampleCount" INTEGER,
    "lastDeployedAt" TIMESTAMP(3),
    "lastOutcome" TEXT,
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cooldownUntil" TIMESTAMP(3),
    "cooldownReason" TEXT,
    "baseMintCooldownUntil" TIMESTAMP(3),
    "baseMintCooldownReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_deploys" (
    "id" TEXT NOT NULL,
    "poolMemoryId" TEXT NOT NULL,
    "deployedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "pnlPct" DOUBLE PRECISION,
    "pnlUsd" DOUBLE PRECISION,
    "feesEarnedUsd" DOUBLE PRECISION,
    "feesEarnedSol" DOUBLE PRECISION,
    "feeEarnedPct" DOUBLE PRECISION,
    "rangeEfficiency" DOUBLE PRECISION,
    "minutesHeld" INTEGER,
    "closeReason" TEXT,
    "strategy" TEXT,
    "volatilityAtDeploy" DOUBLE PRECISION,
    "entryMcap" DOUBLE PRECISION,
    "entryTvl" DOUBLE PRECISION,
    "entryVolume" DOUBLE PRECISION,
    "exitMcap" DOUBLE PRECISION,
    "exitTvl" DOUBLE PRECISION,
    "exitVolume" DOUBLE PRECISION,

    CONSTRAINT "pool_deploys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hivemind_caches" (
    "telegramId" TEXT NOT NULL,
    "agentId" TEXT,
    "pullMode" TEXT NOT NULL DEFAULT 'auto',
    "sharedLessons" JSONB NOT NULL DEFAULT '[]',
    "presets" JSONB NOT NULL DEFAULT '[]',
    "pulledAt" TIMESTAMP(3),

    CONSTRAINT "hivemind_caches_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "briefing_states" (
    "telegramId" TEXT NOT NULL,
    "lastBriefingDate" TEXT,

    CONSTRAINT "briefing_states_pkey" PRIMARY KEY ("telegramId")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_publicKey_key" ON "wallets"("publicKey");

-- CreateIndex
CREATE INDEX "positions_telegramId_closed_idx" ON "positions"("telegramId", "closed");

-- CreateIndex
CREATE UNIQUE INDEX "positions_telegramId_positionAddress_key" ON "positions"("telegramId", "positionAddress");

-- CreateIndex
CREATE INDEX "position_events_telegramId_ts_idx" ON "position_events"("telegramId", "ts");

-- CreateIndex
CREATE INDEX "decision_logs_telegramId_ts_idx" ON "decision_logs"("telegramId", "ts");

-- CreateIndex
CREATE INDEX "lessons_telegramId_idx" ON "lessons"("telegramId");

-- CreateIndex
CREATE INDEX "performance_records_telegramId_recordedAt_idx" ON "performance_records"("telegramId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "smart_wallets_telegramId_address_key" ON "smart_wallets"("telegramId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "strategies_telegramId_strategyKey_key" ON "strategies"("telegramId", "strategyKey");

-- CreateIndex
CREATE UNIQUE INDEX "token_blacklist_entries_telegramId_mint_key" ON "token_blacklist_entries"("telegramId", "mint");

-- CreateIndex
CREATE UNIQUE INDEX "dev_blocklist_entries_telegramId_wallet_key" ON "dev_blocklist_entries"("telegramId", "wallet");

-- CreateIndex
CREATE UNIQUE INDEX "pool_memories_telegramId_poolAddress_key" ON "pool_memories"("telegramId", "poolAddress");

-- CreateIndex
CREATE INDEX "pool_deploys_poolMemoryId_idx" ON "pool_deploys"("poolMemoryId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_configs" ADD CONSTRAINT "user_configs_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_weights" ADD CONSTRAINT "signal_weights_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_wallets" ADD CONSTRAINT "smart_wallets_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_blacklist_entries" ADD CONSTRAINT "token_blacklist_entries_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dev_blocklist_entries" ADD CONSTRAINT "dev_blocklist_entries_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_memories" ADD CONSTRAINT "pool_memories_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_deploys" ADD CONSTRAINT "pool_deploys_poolMemoryId_fkey" FOREIGN KEY ("poolMemoryId") REFERENCES "pool_memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hivemind_caches" ADD CONSTRAINT "hivemind_caches_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "briefing_states" ADD CONSTRAINT "briefing_states_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "users"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;
