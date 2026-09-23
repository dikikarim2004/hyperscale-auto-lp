/**
 * Pool memory — persistent deploy history per pool, per user (telegramId-scoped).
 *
 * Automatically updated when positions close (via recordPerformance in
 * lessons.js). Agent can query before deploying. Persisted in the
 * PoolMemory + PoolDeploy tables via Prisma instead of pool-memory.json.
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";

const MAX_NOTE_LENGTH = 280;
const MAX_SNAPSHOTS = 48; // ~4h at 5min intervals

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function isFeeGeneratingDeploy(deploy, management) {
  const minFeeEarnedPct = Number(management.repeatDeployCooldownMinFeeEarnedPct ?? 0);
  const feeEarnedPct = Number(deploy.feeEarnedPct ?? 0);
  const feesUsd = Number(deploy.feesEarnedUsd ?? 0);
  const feesSol = Number(deploy.feesEarnedSol ?? 0);
  const hasFees = (Number.isFinite(feesUsd) && feesUsd > 0) || (Number.isFinite(feesSol) && feesSol > 0);
  if (!hasFees) return false;
  return Number.isFinite(feeEarnedPct) && feeEarnedPct >= minFeeEarnedPct;
}

async function getOrCreatePoolMemory(telegramId, poolAddress, fallbackName) {
  const existing = await prisma.poolMemory.findUnique({ where: { telegramId_poolAddress: { telegramId, poolAddress } } });
  if (existing) return existing;
  return prisma.poolMemory.create({
    data: { telegramId, poolAddress, name: fallbackName || poolAddress.slice(0, 8) },
  });
}

async function setPoolCooldown(telegramId, poolAddress, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  await prisma.poolMemory.update({
    where: { telegramId_poolAddress: { telegramId, poolAddress } },
    data: { cooldownUntil, cooldownReason: reason },
  });
  return cooldownUntil.toISOString();
}

async function setBaseMintCooldown(telegramId, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  await prisma.poolMemory.updateMany({
    where: { telegramId, baseMint },
    data: { baseMintCooldownUntil: cooldownUntil, baseMintCooldownReason: reason },
  });
  return cooldownUntil.toISOString();
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool memory. Called automatically from
 * recordPerformance() in lessons.js.
 */
export async function recordPoolDeploy(telegramId, poolAddress, deployData, userConfig) {
  if (!poolAddress) return;
  const management = userConfig?.management || {};

  const entry = await getOrCreatePoolMemory(telegramId, poolAddress, deployData.pool_name);

  const deploy = await prisma.poolDeploy.create({
    data: {
      poolMemoryId: entry.id,
      deployedAt: deployData.deployed_at ? new Date(deployData.deployed_at) : null,
      closedAt: deployData.closed_at ? new Date(deployData.closed_at) : new Date(),
      pnlPct: deployData.pnl_pct ?? null,
      pnlUsd: deployData.pnl_usd ?? null,
      feesEarnedUsd: deployData.fees_earned_usd ?? null,
      feesEarnedSol: deployData.fees_earned_sol ?? null,
      feeEarnedPct: deployData.fee_earned_pct ?? null,
      rangeEfficiency: deployData.range_efficiency ?? null,
      minutesHeld: deployData.minutes_held ?? null,
      closeReason: deployData.close_reason || null,
      strategy: deployData.strategy || null,
      volatilityAtDeploy: deployData.volatility ?? null,
      entryMcap: deployData.entry_mcap ?? null,
      entryTvl: deployData.entry_tvl ?? null,
      entryVolume: deployData.entry_volume ?? null,
      exitMcap: deployData.exit_mcap ?? null,
      exitTvl: deployData.exit_tvl ?? null,
      exitVolume: deployData.exit_volume ?? null,
    },
  });

  const allDeploys = await prisma.poolDeploy.findMany({ where: { poolMemoryId: entry.id }, orderBy: { createdAt: "asc" } });

  const withPnl = allDeploys.filter((d) => d.pnlPct != null);
  const avgPnlPct = withPnl.length > 0
    ? Math.round((withPnl.reduce((s, d) => s + d.pnlPct, 0) / withPnl.length) * 100) / 100
    : 0;
  const winRate = withPnl.length > 0
    ? Math.round((withPnl.filter((d) => d.pnlPct >= 0).length / withPnl.length) * 100) / 100
    : 0;
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.closeReason));
  const adjustedWinRate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnlPct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  await prisma.poolMemory.update({
    where: { id: entry.id },
    data: {
      totalDeploys: allDeploys.length,
      lastDeployedAt: deploy.closedAt,
      lastOutcome: (deploy.pnlPct ?? 0) >= 0 ? "profit" : "loss",
      avgPnlPct,
      winRate,
      adjustedWinRate,
      adjustedWinRateSampleCount: adjusted.length,
      baseMint: entry.baseMint || deployData.base_mint || null,
    },
  });
  const baseMint = entry.baseMint || deployData.base_mint || null;
  const name = entry.name;

  // Set cooldown for low yield closes — pool wasn't profitable enough, don't redeploy soon
  if (deploy.closeReason === "low yield") {
    const cooldownUntil = await setPoolCooldown(telegramId, poolAddress, 4, "low yield");
    log("pool-memory", `[${telegramId}] Cooldown set for ${name} until ${cooldownUntil} (low yield close)`);
  }

  const oorTriggerCount = management.oorCooldownTriggerCount ?? 3;
  const oorCooldownHours = management.oorCooldownHours ?? 12;
  const recentDeploys = allDeploys.slice(-oorTriggerCount);
  const repeatedOorCloses =
    recentDeploys.length >= oorTriggerCount &&
    recentDeploys.every((d) => isOorCloseReason(d.closeReason));

  if (repeatedOorCloses) {
    const reason = `repeated OOR closes (${oorTriggerCount}x)`;
    const poolCooldownUntil = await setPoolCooldown(telegramId, poolAddress, oorCooldownHours, reason);
    log("pool-memory", `[${telegramId}] Cooldown set for ${name} until ${poolCooldownUntil} (${reason})`);
    if (baseMint) {
      const mintCooldownUntil = await setBaseMintCooldown(telegramId, baseMint, oorCooldownHours, reason);
      if (mintCooldownUntil) log("pool-memory", `[${telegramId}] Base mint cooldown set for ${baseMint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
    }
  }

  if (management.repeatDeployCooldownEnabled) {
    const triggerCount = Math.max(1, Number(management.repeatDeployCooldownTriggerCount ?? 3));
    const cooldownHours = Math.max(0, Number(management.repeatDeployCooldownHours ?? 12));
    const rawScope = String(management.repeatDeployCooldownScope || "token").toLowerCase();
    const scope = ["pool", "token", "both"].includes(rawScope) ? rawScope : "token";
    const recentRepeatDeploys = allDeploys.slice(-triggerCount);
    const repeatedFeeGeneratingDeploys =
      cooldownHours > 0 &&
      recentRepeatDeploys.length >= triggerCount &&
      recentRepeatDeploys.every((d) => d.pnlPct != null && isFeeGeneratingDeploy(d, management));

    if (repeatedFeeGeneratingDeploys) {
      const reason = `repeat fee-generating deploys (${triggerCount}x)`;
      if (scope === "pool" || scope === "both" || !baseMint) {
        const poolCooldownUntil = await setPoolCooldown(telegramId, poolAddress, cooldownHours, reason);
        log("pool-memory", `[${telegramId}] Cooldown set for ${name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((scope === "token" || scope === "both") && baseMint) {
        const mintCooldownUntil = await setBaseMintCooldown(telegramId, baseMint, cooldownHours, reason);
        if (mintCooldownUntil) log("pool-memory", `[${telegramId}] Base mint cooldown set for ${baseMint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
      }
    }
  }

  // Cooldown berbasis pnl_pct murni — terpisah dari repeatDeployCooldown (yang berbasis fee)
  if (management.repeatLossCooldownEnabled) {
    const lossTriggerCount = Math.max(1, Number(management.repeatLossCooldownTriggerCount ?? 2));
    const lossCooldownHours = Math.max(0, Number(management.repeatLossCooldownHours ?? 12));
    const rawLossScope = String(management.repeatLossCooldownScope || "token").toLowerCase();
    const lossScope = ["pool", "token", "both"].includes(rawLossScope) ? rawLossScope : "token";
    const minLossPct = Number(management.repeatLossCooldownMinLossPct ?? management.stopLossPct ?? -5);
    const recentLossDeploys = allDeploys.slice(-lossTriggerCount);
    const repeatedLosses =
      lossCooldownHours > 0 &&
      recentLossDeploys.length >= lossTriggerCount &&
      recentLossDeploys.every((d) => d.pnlPct != null && d.pnlPct <= minLossPct);

    if (repeatedLosses) {
      const reason = `repeat losses (${lossTriggerCount}x)`;
      if (lossScope === "pool" || lossScope === "both" || !baseMint) {
        const poolCooldownUntil = await setPoolCooldown(telegramId, poolAddress, lossCooldownHours, reason);
        log("pool-memory", `[${telegramId}] Cooldown set for ${name} until ${poolCooldownUntil} (${reason})`);
      }
      if ((lossScope === "token" || lossScope === "both") && baseMint) {
        const mintCooldownUntil = await setBaseMintCooldown(telegramId, baseMint, lossCooldownHours, reason);
        if (mintCooldownUntil) log("pool-memory", `[${telegramId}] Base mint cooldown set for ${baseMint.slice(0, 8)} until ${mintCooldownUntil} (${reason})`);
      }
    }
  }

  log("pool-memory", `[${telegramId}] Recorded deploy for ${name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnlPct}%`);
}

export async function isPoolOnCooldown(telegramId, poolAddress) {
  if (!poolAddress) return false;
  const entry = await prisma.poolMemory.findUnique({ where: { telegramId_poolAddress: { telegramId, poolAddress } } });
  if (!entry?.cooldownUntil) return false;
  return entry.cooldownUntil > new Date();
}

export async function isBaseMintOnCooldown(telegramId, baseMint) {
  if (!baseMint) return false;
  const entry = await prisma.poolMemory.findFirst({
    where: { telegramId, baseMint, baseMintCooldownUntil: { gt: new Date() } },
  });
  return !!entry;
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export async function getPoolMemory(telegramId, { pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const entry = await prisma.poolMemory.findUnique({
    where: { telegramId_poolAddress: { telegramId, poolAddress: pool_address } },
    include: { deploys: { orderBy: { createdAt: "desc" }, take: 10 } },
  });

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.baseMint,
    total_deploys: entry.totalDeploys,
    avg_pnl_pct: entry.avgPnlPct,
    win_rate: entry.winRate,
    adjusted_win_rate: entry.adjustedWinRate ?? 0,
    adjusted_win_rate_sample_count: entry.adjustedWinRateSampleCount ?? 0,
    last_deployed_at: entry.lastDeployedAt?.toISOString() ?? null,
    last_outcome: entry.lastOutcome,
    cooldown_until: entry.cooldownUntil?.toISOString() ?? null,
    cooldown_reason: entry.cooldownReason || null,
    base_mint_cooldown_until: entry.baseMintCooldownUntil?.toISOString() ?? null,
    base_mint_cooldown_reason: entry.baseMintCooldownReason || null,
    notes: entry.notes,
    history: entry.deploys.reverse(), // chronological, last 10
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export async function recordPositionSnapshot(telegramId, poolAddress, snapshot) {
  if (!poolAddress) return;
  const entry = await getOrCreatePoolMemory(telegramId, poolAddress, snapshot.pair);

  const snapshots = Array.isArray(entry.snapshots) ? entry.snapshots : [];
  snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  const trimmed = snapshots.length > MAX_SNAPSHOTS ? snapshots.slice(-MAX_SNAPSHOTS) : snapshots;
  await prisma.poolMemory.update({ where: { id: entry.id }, data: { snapshots: trimmed } });
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export async function recallForPool(telegramId, poolAddress) {
  if (!poolAddress) return null;
  const entry = await prisma.poolMemory.findUnique({ where: { telegramId_poolAddress: { telegramId, poolAddress } } });
  if (!entry) return null;

  const lines = [];

  if (entry.totalDeploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.totalDeploys} past deploy(s), avg PnL ${entry.avgPnlPct}%, win rate ${entry.winRate}%, last outcome: ${entry.lastOutcome}`);
  }

  if (entry.cooldownUntil && entry.cooldownUntil > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldownUntil.toISOString()}${entry.cooldownReason ? ` (${entry.cooldownReason})` : ""}`);
  }

  if (entry.baseMintCooldownUntil && entry.baseMintCooldownUntil > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.baseMintCooldownUntil.toISOString()}${entry.baseMintCooldownReason ? ` (${entry.baseMintCooldownReason})` : ""}`);
  }

  const snaps = (Array.isArray(entry.snapshots) ? entry.snapshots : []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter((s) => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  const notes = Array.isArray(entry.notes) ? entry.notes : [];
  if (notes.length > 0) {
    const lastNote = notes[notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export async function addPoolNote(telegramId, { pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const entry = await getOrCreatePoolMemory(telegramId, pool_address);
  const notes = Array.isArray(entry.notes) ? entry.notes : [];
  notes.push({ note: safeNote, added_at: new Date().toISOString() });

  await prisma.poolMemory.update({ where: { id: entry.id }, data: { notes } });
  log("pool-memory", `[${telegramId}] Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}

