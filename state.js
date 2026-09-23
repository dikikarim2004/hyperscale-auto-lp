/**
 * Persistent agent state — per user (telegramId-scoped), stored in Postgres
 * via Prisma (Position + PositionEvent tables) instead of state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function findPos(telegramId, positionAddress) {
  return prisma.position.findUnique({
    where: { telegramId_positionAddress: { telegramId, positionAddress } },
  });
}

async function pushEvent(telegramId, event) {
  await prisma.positionEvent.create({ data: { telegramId, ...event } });
  const count = await prisma.positionEvent.count({ where: { telegramId } });
  if (count > MAX_RECENT_EVENTS) {
    const stale = await prisma.positionEvent.findMany({
      where: { telegramId },
      orderBy: { ts: "asc" },
      take: count - MAX_RECENT_EVENTS,
      select: { id: true },
    });
    await prisma.positionEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export async function trackPosition(telegramId, {
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  await prisma.position.create({
    data: {
      telegramId,
      positionAddress: position,
      pool,
      poolName: pool_name,
      strategy,
      binRange: bin_range,
      amountSol: amount_sol,
      amountX: amount_x,
      activeBinAtDeploy: active_bin,
      binStep: bin_step,
      volatility,
      feeTvlRatio: fee_tvl_ratio,
      initialFeeTvl24h: fee_tvl_ratio,
      organicScore: organic_score,
      initialValueUsd: initial_value_usd,
      entryMcap: entry_mcap,
      entryTvl: entry_tvl,
      entryVolume: entry_volume,
      entryHolders: entry_holders,
      signalSnapshot: signal_snapshot,
    },
  });
  await pushEvent(telegramId, { action: "deploy", position, poolName: pool_name || pool });
  log("state", `[${telegramId}] Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export async function markOutOfRange(telegramId, position_address) {
  const pos = await findPos(telegramId, position_address);
  if (!pos) return;
  if (!pos.outOfRangeSince) {
    await prisma.position.update({ where: { id: pos.id }, data: { outOfRangeSince: new Date() } });
    log("state", `[${telegramId}] Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export async function markInRange(telegramId, position_address) {
  const pos = await findPos(telegramId, position_address);
  if (!pos) return;
  if (pos.outOfRangeSince) {
    await prisma.position.update({ where: { id: pos.id }, data: { outOfRangeSince: null } });
    log("state", `[${telegramId}] Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export async function minutesOutOfRange(telegramId, position_address) {
  const pos = await findPos(telegramId, position_address);
  if (!pos || !pos.outOfRangeSince) return 0;
  const ms = Date.now() - pos.outOfRangeSince.getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export async function recordClaim(telegramId, position_address, fees_usd) {
  const pos = await findPos(telegramId, position_address);
  if (!pos) return;
  const note = `Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${new Date().toISOString()}`;
  await prisma.position.update({
    where: { id: pos.id },
    data: {
      lastClaimAt: new Date(),
      totalFeesClaimedUsd: (pos.totalFeesClaimedUsd || 0) + (fees_usd || 0),
      notes: { push: note },
    },
  });
}

/**
 * Mark a position as closed.
 */
export async function recordClose(telegramId, position_address, reason) {
  const pos = await findPos(telegramId, position_address);
  if (!pos) return;
  const closedAt = new Date();
  await prisma.position.update({
    where: { id: pos.id },
    data: { closed: true, closedAt, notes: { push: `Closed at ${closedAt.toISOString()}: ${reason}` } },
  });
  await pushEvent(telegramId, { action: "close", position: position_address, poolName: pos.poolName || pos.pool, reason });
  log("state", `[${telegramId}] Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export async function setPositionInstruction(telegramId, position_address, instruction) {
  const pos = await findPos(telegramId, position_address);
  if (!pos) return false;
  const clean = sanitizeStoredText(instruction);
  await prisma.position.update({ where: { id: pos.id }, data: { instruction: clean } });
  log("state", `[${telegramId}] Position ${position_address} instruction set: ${clean}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Returns true when the peak was raised this call.
 */
export async function confirmPeak(telegramId, position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const pos = await findPos(telegramId, position_address);
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peakPnlPct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pendingPeakPnlPct != null) {
      await prisma.position.update({ where: { id: pos.id }, data: { pendingPeakPnlPct: null, pendingPeakConfirmCount: 0 } });
    }
    return false;
  }

  const data = {};
  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pendingPeakPnlPct != null && candidatePnlPct >= pos.pendingPeakPnlPct) {
    data.pendingPeakConfirmCount = (pos.pendingPeakConfirmCount ?? 1) + 1;
    data.pendingPeakPnlPct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    data.pendingPeakPnlPct = candidatePnlPct;
    data.pendingPeakConfirmCount = 1;
    data.pendingPeakStartedAt = new Date();
  }

  if (data.pendingPeakConfirmCount >= confirmTicks) {
    const newPeak = Math.max(currentPeak, data.pendingPeakPnlPct);
    await prisma.position.update({
      where: { id: pos.id },
      data: { peakPnlPct: newPeak, pendingPeakPnlPct: null, pendingPeakConfirmCount: 0, pendingPeakStartedAt: null },
    });
    log("state", `[${telegramId}] Position ${position_address} peak PnL confirmed at ${newPeak.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  await prisma.position.update({ where: { id: pos.id }, data });
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export async function registerExitSignal(telegramId, position_address, signal, confirmTicks = 2) {
  const pos = await findPos(telegramId, position_address);
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pendingExitAction != null) {
      await prisma.position.update({ where: { id: pos.id }, data: { pendingExitAction: null, pendingExitCount: 0 } });
    }
    return { fire: false, action: null, count: 0 };
  }

  const data = {};
  if (pos.pendingExitAction === signal) {
    data.pendingExitCount = (pos.pendingExitCount ?? 1) + 1;
  } else {
    data.pendingExitAction = signal;
    data.pendingExitCount = 1;
    data.pendingExitStartedAt = new Date();
  }

  const count = data.pendingExitCount;
  const fire = count >= confirmTicks;
  if (fire) {
    data.pendingExitAction = null;
    data.pendingExitCount = 0;
    data.pendingExitStartedAt = null;
  }
  await prisma.position.update({ where: { id: pos.id }, data });
  if (fire) log("state", `[${telegramId}] Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export async function getTrackedPositions(telegramId, openOnly = false) {
  return prisma.position.findMany({ where: { telegramId, ...(openOnly ? { closed: false } : {}) } });
}

/**
 * Get a single tracked position.
 */
export async function getTrackedPosition(telegramId, position_address) {
  return findPos(telegramId, position_address);
}

/**
 * Summarize state for the agent system prompt.
 */
export async function getStateSummary(telegramId) {
  const all = await prisma.position.findMany({ where: { telegramId } });
  const open = all.filter((p) => !p.closed);
  const closed = all.filter((p) => p.closed);
  const totalFeesClaimed = all.reduce((sum, p) => sum + (p.totalFeesClaimedUsd || 0), 0);
  const recentEvents = await prisma.positionEvent.findMany({ where: { telegramId }, orderBy: { ts: "desc" }, take: 10 });
  const lastUpdated = all.reduce((max, p) => (p.updatedAt > max ? p.updatedAt : max), new Date(0));

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: await Promise.all(open.map(async (p) => ({
      position: p.positionAddress,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployedAt.toISOString(),
      out_of_range_since: p.outOfRangeSince?.toISOString() ?? null,
      minutes_out_of_range: await minutesOutOfRange(telegramId, p.positionAddress),
      total_fees_claimed_usd: p.totalFeesClaimedUsd,
      initial_fee_tvl_24h: p.initialFeeTvl24h,
      rebalance_count: p.rebalanceCount,
      instruction: p.instruction || null,
    }))),
    last_updated: all.length > 0 ? lastUpdated.toISOString() : null,
    recent_events: recentEvents.reverse().map((e) => ({
      ts: e.ts.toISOString(), action: e.action, position: e.position, pool_name: e.poolName, reason: e.reason,
    })),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} telegramId
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export async function updatePnlAndCheckExits(telegramId, position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const pos = await findPos(telegramId, position_address);
  if (!pos || pos.closed) return null;

  const data = {};

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailingActive && (pos.peakPnlPct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    data.trailingActive = true;
    log("state", `[${telegramId}] Position ${position_address} trailing TP activated (confirmed peak: ${pos.peakPnlPct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.outOfRangeSince) {
    data.outOfRangeSince = new Date();
    log("state", `[${telegramId}] Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.outOfRangeSince) {
    data.outOfRangeSince = null;
    log("state", `[${telegramId}] Position ${position_address} back in range`);
  }

  if (Object.keys(data).length > 0) await prisma.position.update({ where: { id: pos.id }, data });
  const trailingActive = data.trailingActive ?? pos.trailingActive;
  const peakPnlPct = pos.peakPnlPct;
  const outOfRangeSince = data.outOfRangeSince !== undefined ? data.outOfRangeSince : pos.outOfRangeSince;

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && trailingActive) {
    const dropFromPeak = peakPnlPct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${peakPnlPct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: peakPnlPct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (outOfRangeSince) {
    const minutesOOR = Math.floor((Date.now() - outOfRangeSince.getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export async function getLastBriefingDate(telegramId) {
  const row = await prisma.briefingState.findUnique({ where: { telegramId } });
  return row?.lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export async function setLastBriefingDate(telegramId) {
  const lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  await prisma.briefingState.upsert({
    where: { telegramId },
    update: { lastBriefingDate },
    create: { telegramId, lastBriefingDate },
  });
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export async function syncOpenPositions(telegramId, active_addresses) {
  const activeSet = new Set(active_addresses);
  const openPositions = await prisma.position.findMany({ where: { telegramId, closed: false } });

  for (const pos of openPositions) {
    if (activeSet.has(pos.positionAddress)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployedAt ? pos.deployedAt.getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `[${telegramId}] Position ${pos.positionAddress} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    await prisma.position.update({
      where: { id: pos.id },
      data: { closed: true, closedAt: new Date(), notes: { push: "Auto-closed during state sync (not found on-chain)" } },
    });
    log("state", `[${telegramId}] Position ${pos.positionAddress} auto-closed (missing from on-chain data)`);
  }
}

