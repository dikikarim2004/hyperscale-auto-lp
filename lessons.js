/**
 * Agent learning system — per user (telegramId-scoped).
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 * Persisted via Prisma (Lesson + PerformanceRecord tables) instead of
 * lessons.json.
 */

import { prisma } from "./db/client.js";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";
import { getUserConfig, updateUserConfigSection } from "./user-config-service.js";
import { recordPoolDeploy } from "./pool-memory.js";
import { recalculateWeights } from "./signal-weights.js";

const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "entry_mcap",
  "entry_tvl",
  "entry_volume",
];
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export function perfRowToApiShape(row) {
  return {
    position: row.position,
    pool: row.pool,
    pool_name: row.poolName,
    strategy: row.strategy,
    bin_range: row.binRange,
    bin_step: row.binStep,
    volatility: row.volatility,
    fee_tvl_ratio: row.feeTvlRatio,
    organic_score: row.organicScore,
    amount_sol: row.amountSol,
    fees_earned_usd: row.feesEarnedUsd,
    fees_earned_sol: row.feesEarnedSol,
    final_value_usd: row.finalValueUsd,
    initial_value_usd: row.initialValueUsd,
    minutes_in_range: row.minutesInRange,
    minutes_held: row.minutesHeld,
    close_reason: row.closeReason,
    pnl_usd: row.pnlUsd,
    pnl_pct: row.pnlPct,
    range_efficiency: row.rangeEfficiency,
    recorded_at: row.recordedAt.toISOString(),
    signal_snapshot: row.signalSnapshot,
    base_mint: row.baseMint,
    entry_mcap: row.entryMcap,
    entry_tvl: row.entryTvl,
    entry_volume: row.entryVolume,
    exit_mcap: row.exitMcap,
    exit_tvl: row.exitTvl,
    exit_volume: row.exitVolume,
    deployed_at: row.deployedAt?.toISOString() ?? null,
  };
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {string} telegramId
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(telegramId, perf) {
  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `[${telegramId}] Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `[${telegramId}] Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const signalSnapshot = buildSignalSnapshot(perf);
  const entry = {
    ...perf,
    signal_snapshot: signalSnapshot,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  await prisma.performanceRecord.create({
    data: {
      telegramId,
      position: entry.position,
      pool: entry.pool,
      poolName: entry.pool_name,
      strategy: entry.strategy,
      binRange: typeof entry.bin_range === "object" ? entry.bin_range : { value: entry.bin_range },
      binStep: entry.bin_step,
      volatility: entry.volatility,
      feeTvlRatio: entry.fee_tvl_ratio,
      organicScore: entry.organic_score,
      amountSol: entry.amount_sol,
      feesEarnedUsd: entry.fees_earned_usd,
      feesEarnedSol: entry.fees_earned_sol,
      finalValueUsd: entry.final_value_usd,
      initialValueUsd: entry.initial_value_usd,
      minutesInRange: entry.minutes_in_range,
      minutesHeld: entry.minutes_held,
      closeReason: entry.close_reason,
      pnlUsd: entry.pnl_usd,
      pnlPct: entry.pnl_pct,
      rangeEfficiency: entry.range_efficiency,
      signalSnapshot: entry.signal_snapshot,
      baseMint: entry.base_mint,
      entryMcap: entry.entry_mcap,
      entryTvl: entry.entry_tvl,
      entryVolume: entry.entry_volume,
      exitMcap: entry.exit_mcap,
      exitTvl: entry.exit_tvl,
      exitVolume: entry.exit_volume,
      deployedAt: entry.deployed_at ? new Date(entry.deployed_at) : null,
      recordedAt: new Date(entry.recorded_at),
    },
  });

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    await prisma.lesson.create({
      data: {
        telegramId,
        rule: lesson.rule,
        tags: lesson.tags,
        role: null,
        outcome: lesson.outcome,
        source: lesson.sourceType,
        score: lesson.confidence,
        metadata: {
          confidence: lesson.confidence,
          context: lesson.context,
          pnl_pct: lesson.pnl_pct,
          fees_earned_usd: lesson.fees_earned_usd,
          initial_value_usd: lesson.initial_value_usd,
          range_efficiency: lesson.range_efficiency,
          close_reason: lesson.close_reason,
          pool: lesson.pool,
          entry_mcap: lesson.entry_mcap,
          entry_tvl: lesson.entry_tvl,
          entry_volume: lesson.entry_volume,
          exit_mcap: lesson.exit_mcap,
          exit_tvl: lesson.exit_tvl,
          exit_volume: lesson.exit_volume,
        },
      },
    });
    log("lessons", `[${telegramId}] New lesson: ${lesson.rule}`);
    void pushHiveLesson(telegramId, lesson);
  }

  const userConfig = await getUserConfig(telegramId);

  // Update pool-level memory
  if (perf.pool) {
    await recordPoolDeploy(telegramId, perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
      entry_mcap: perf.entry_mcap,
      entry_tvl: perf.entry_tvl,
      entry_volume: perf.entry_volume,
      exit_mcap: perf.exit_mcap,
      exit_tvl: perf.exit_tvl,
      exit_volume: perf.exit_volume,
    }, userConfig);
  }

  // Evolve thresholds every 5 closed positions
  const totalPositions = await prisma.performanceRecord.count({ where: { telegramId } });
  if (totalPositions % MIN_EVOLVE_POSITIONS === 0) {
    const perfRows = await prisma.performanceRecord.findMany({ where: { telegramId }, orderBy: { recordedAt: "asc" } });
    const perfData = perfRows.map(perfRowToApiShape);

    const result = await evolveThresholds(telegramId, perfData, userConfig);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      log("evolve", `[${telegramId}] Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (userConfig.darwin?.enabled) {
      const wResult = await recalculateWeights(telegramId, perfData, userConfig);
      if (wResult.changes.length > 0) {
        log("evolve", `[${telegramId}] Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  void pushHivePerformanceEvent(telegramId, {
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description with entry/exit market conditions
  const fmtNum = (n) => n == null ? "?" : n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(Math.round(n));
  const contextParts = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ];
  if (perf.entry_mcap != null || perf.entry_tvl != null || perf.entry_volume != null) {
    contextParts.push(`entry(mcap=${fmtNum(perf.entry_mcap)}, tvl=${fmtNum(perf.entry_tvl)}, vol=${fmtNum(perf.entry_volume)})`);
  }
  if (perf.exit_mcap != null || perf.exit_tvl != null || perf.exit_volume != null) {
    contextParts.push(`exit(mcap=${fmtNum(perf.exit_mcap)}, tvl=${fmtNum(perf.exit_tvl)}, vol=${fmtNum(perf.exit_volume)})`);
  }
  const context = contextParts.join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      const entryNote = perf.entry_mcap != null ? ` Entry: mcap=${fmtNum(perf.entry_mcap)}, tvl=${fmtNum(perf.entry_tvl)}, vol=${fmtNum(perf.entry_volume)}.` : "";
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.${entryNote}`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    entry_mcap: perf.entry_mcap ?? null,
    entry_tvl: perf.entry_tvl ?? null,
    entry_volume: perf.entry_volume ?? null,
    exit_mcap: perf.exit_mcap ?? null,
    exit_tvl: perf.exit_tvl ?? null,
    exit_volume: perf.exit_volume ?? null,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Persists changes to this user's UserConfig.screening section.
 *
 * @param {string} telegramId
 * @param {Array}  perfData    - Array of performance records (API-shaped, see perfRowToApiShape)
 * @param {Object} userConfig  - This user's live config object (read-only reference for current values)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export async function evolveThresholds(telegramId, perfData, userConfig) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. minFeeActiveTvlRatio ────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = userConfig.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 2. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = userConfig.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to this user's screening config ────────────
  await updateUserConfigSection(telegramId, "screening", {
    ...changes,
    _lastEvolved: new Date().toISOString(),
    _positionsAtEvolution: perfData.length,
  });

  // Log a lesson summarizing the evolution
  await prisma.lesson.create({
    data: {
      telegramId,
      rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
      tags: ["evolution", "config_change"],
      outcome: "manual",
      source: "config_change",
    },
  });

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   telegramId
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export async function addLesson(telegramId, rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const source = tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual";
  const lesson = await prisma.lesson.create({
    data: { telegramId, rule: safeRule, tags, outcome: "manual", source, pinned: !!pinned, role: role || null },
  });
  log("lessons", `[${telegramId}] Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(telegramId, { id: lesson.id, rule: safeRule, tags, outcome: "manual", sourceType: source, pinned, role, created_at: lesson.createdAt.toISOString() });
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export async function pinLesson(telegramId, id) {
  const lesson = await prisma.lesson.findFirst({ where: { telegramId, id } });
  if (!lesson) return { found: false };
  await prisma.lesson.update({ where: { id }, data: { pinned: true } });
  log("lessons", `[${telegramId}] Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export async function unpinLesson(telegramId, id) {
  const lesson = await prisma.lesson.findFirst({ where: { telegramId, id } });
  if (!lesson) return { found: false };
  await prisma.lesson.update({ where: { id }, data: { pinned: false } });
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export async function listLessons(telegramId, { role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const all = await prisma.lesson.findMany({ where: { telegramId }, orderBy: { createdAt: "asc" } });
  let lessons = all;

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.createdAt.toISOString().slice(0, 10),
    })),
  };
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export async function removeLessonsByKeyword(telegramId, keyword) {
  const result = await prisma.lesson.deleteMany({
    where: { telegramId, rule: { contains: keyword, mode: "insensitive" } },
  });
  return result.count;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export async function clearAllLessons(telegramId) {
  const result = await prisma.lesson.deleteMany({ where: { telegramId } });
  return result.count;
}

/**
 * Clear ALL performance records.
 */
export async function clearPerformance(telegramId) {
  const result = await prisma.performanceRecord.deleteMany({ where: { telegramId } });
  return result.count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {string} telegramId
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export async function getLessonsForPrompt(telegramId, opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(telegramId, 20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const lessons = await prisma.lesson.findMany({ where: { telegramId }, orderBy: { createdAt: "desc" } });
  if (lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = await getSharedLessonsForPrompt(telegramId, {
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.createdAt ? l.createdAt.toISOString().slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {string} telegramId
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export async function getPerformanceHistory(telegramId, { hours = 24, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await prisma.performanceRecord.findMany({
    where: { telegramId, recordedAt: { gte: cutoff } },
    orderBy: { recordedAt: "asc" },
    take: limit,
  });

  if (rows.length === 0) return { positions: [], count: 0, hours };

  const filtered = rows.map((r) => ({
    pool_name: r.poolName,
    pool: r.pool,
    strategy: r.strategy,
    pnl_usd: r.pnlUsd,
    pnl_pct: r.pnlPct,
    fees_earned_usd: r.feesEarnedUsd,
    range_efficiency: r.rangeEfficiency,
    minutes_held: r.minutesHeld,
    close_reason: r.closeReason,
    closed_at: r.recordedAt.toISOString(),
  }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export async function getPerformanceSummary(telegramId) {
  const p = await prisma.performanceRecord.findMany({ where: { telegramId } });
  if (p.length === 0) return null;

  const totalLessons = await prisma.lesson.count({ where: { telegramId } });
  const totalPnl = p.reduce((s, x) => s + x.pnlUsd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnlPct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.rangeEfficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnlUsd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: totalLessons,
  };
}

