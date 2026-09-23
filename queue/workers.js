/**
 * BullMQ workers — one per cycle-type queue. Each job carries only
 * { telegramId }; the worker builds that user's ctx fresh per run so config/
 * secrets/wallet are always current (no stale in-memory user state).
 *
 * This is the full per-user port of the old single-tenant index.js cycle
 * logic (runManagementCycle / runScreeningCycle / health check / fast PnL
 * poller / opportunity poller / morning briefing), rewired onto ctx +
 * per-telegramId state instead of one global in-memory state.
 *
 * NOT ported here (documented, not fabricated): the interactive TTY REPL
 * (single-operator terminal UX, doesn't fit a headless multi-tenant daemon)
 * and the elaborate inline-button /settings menu (superseded by the simpler
 * text-based /config command already built in telegram.js).
 */

import { Worker } from "bullmq";
import { connection } from "./redis.js";
import { QUEUE_NAMES } from "./queues.js";
import { buildUserContext } from "../tools/context.js";
import { getUser, computeDeployAmount } from "../user-config-service.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getMyPositions, getActiveBin } from "../tools/dlmm.js";
import { getTopCandidates, degenScore } from "../tools/screening.js";
import { evaluateTechnicalExitSignal } from "../tools/ohlcv.js";
import { evaluateDynamicStopLoss } from "../tools/risk/dynamic-stop-loss.js";
import { evaluateOnChainExitSignal } from "../tools/risk/onchain-intelligence.js";
import { getTokenNarrative, getTokenInfo } from "../tools/token.js";
import { checkSmartWalletsOnPool } from "../smart-wallets.js";
import { recordPositionSnapshot, recallForPool } from "../pool-memory.js";
import {
  confirmPeak,
  updatePnlAndCheckExits,
  getTrackedPositions,
  registerExitSignal,
  getLastBriefingDate,
  setLastBriefingDate,
} from "../state.js";
import { getActiveStrategy } from "../strategy-library.js";
import { stageSignals } from "../signal-tracker.js";
import { appendDecision } from "../decision-log.js";
import { generateBriefing } from "../briefing.js";
import { agentLoop } from "../agent.js";
import { executeTool } from "../tools/executor.js";
import { sendMessage, sendHTML, createLiveMessage, notifyOutOfRange } from "../telegram.js";
import {
  getDeterministicCloseRule,
  getLoneCandidateSkipReason,
  computeBinsBelow,
  buildSmartMoneySummary,
  executeManagementActions,
} from "./cycle-helpers.js";
import { log } from "../logger.js";

const WORKER_CONCURRENCY = Number(process.env.QUEUE_WORKER_CONCURRENCY || 5);

/** In-flight guards — per telegramId, mirrors the old single-tenant module-level flags. */
const _managementBusy = new Set();
const _screeningBusy = new Set();
const _positionActionBusy = new Set();
const _screeningLastTriggered = new Map(); // telegramId -> epoch ms

/** Skip the run instead of throwing if the user disabled/blocked themselves since the job was scheduled. */
async function loadActiveUserContext(telegramId) {
  const user = await getUser(telegramId);
  if (!user || !user.agentEnabled || user.isBlocked) return null;
  return buildUserContext(telegramId);
}

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

// ═══════════════════════════════════════════
//  MANAGEMENT CYCLE
// ═══════════════════════════════════════════
async function runManagementCycle(ctx) {
  const id = ctx.telegramId;
  if (_managementBusy.has(id)) return null;
  _managementBusy.add(id);
  log("cron", `[${id}] Starting management cycle`);
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    liveMessage = await createLiveMessage(id, "🔄 Management Cycle", "Evaluating positions...");
    const livePositions = await getMyPositions(ctx, { force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", `[${id}] No open positions — triggering screening cycle`);
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle(ctx).catch((e) => log("cron_error", `[${id}] Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    const positionData = [];
    for (const p of positions) {
      await recordPositionSnapshot(id, p.pool, p);
      positionData.push({ ...p, recall: await recallForPool(id, p.pool) });
    }

    const exitMap = new Map();
    for (const p of positionData) {
      await confirmPeak(id, p.position, p.pnl_pct, 1);
      const exit = await updatePnlAndCheckExits(id, p.position, p, ctx.config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `[${id}] Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    const taExitMap = new Map();
    let taUnavailableCount = 0;
    if (ctx.config.technicalAnalysis?.enabled) {
      const taChecks = await Promise.allSettled(
        positionData.map((p) => evaluateTechnicalExitSignal(ctx, { mint: p.base_mint || p.base?.mint })),
      );
      for (let i = 0; i < positionData.length; i++) {
        const p = positionData[i];
        const checked = taChecks[i];
        if (checked?.status === "fulfilled") {
          p.ta_exit_signal = checked.value;
          if (checked.value?.should_close) taExitMap.set(p.position, checked.value.reason || "TA exit signal");
        } else {
          taUnavailableCount += 1;
          p.ta_exit_signal = { enabled: true, should_close: false, unavailable: true, reason: `TA unavailable: ${checked?.reason?.message || "unknown error"}` };
        }
      }
      log("management", `[${id}] TA exit checks: evaluated=${positionData.length}, closeSignals=${taExitMap.size}, unavailable=${taUnavailableCount}`);
    }

    const dynamicStopMap = new Map();
    let dynamicUnavailableCount = 0;
    const dynamicStopChecks = await Promise.allSettled(
      positionData.map((p) => evaluateDynamicStopLoss(ctx, { mint: p.base_mint || p.base?.mint, currentPnlPct: p.pnl_pct })),
    );
    for (let i = 0; i < positionData.length; i++) {
      const p = positionData[i];
      const checked = dynamicStopChecks[i];
      if (checked?.status === "fulfilled") {
        p.dynamic_stop_loss = checked.value;
        if (checked.value?.should_close) dynamicStopMap.set(p.position, checked.value.reason || "dynamic ATR stop-loss");
      } else {
        dynamicUnavailableCount += 1;
        p.dynamic_stop_loss = { enabled: true, should_close: false, unavailable: true, reason: `Dynamic stop-loss unavailable: ${checked?.reason?.message || "unknown error"}` };
      }
    }
    log("management", `[${id}] RiskMgmt dynamic SL checks: evaluated=${positionData.length}, closeSignals=${dynamicStopMap.size}, unavailable=${dynamicUnavailableCount}`);

    const onChainExitMap = new Map();
    let onChainUnavailableCount = 0;
    if (ctx.config.onChainIntelligence?.enabled) {
      const onchainChecks = await Promise.allSettled(
        positionData.map((p) => evaluateOnChainExitSignal(ctx, { mint: p.base_mint || p.base?.mint })),
      );
      for (let i = 0; i < positionData.length; i++) {
        const p = positionData[i];
        const checked = onchainChecks[i];
        if (checked?.status === "fulfilled") {
          p.onchain_exit_signal = checked.value;
          if (checked.value?.should_close) onChainExitMap.set(p.position, checked.value.reason || "on-chain exit signal");
        } else {
          onChainUnavailableCount += 1;
          p.onchain_exit_signal = { enabled: true, should_close: false, unavailable: true, reason: `On-chain exit unavailable: ${checked?.reason?.message || "unknown error"}` };
        }
      }
      log("management", `[${id}] On-chain exit checks: evaluated=${positionData.length}, closeSignals=${onChainExitMap.size}, unavailable=${onChainUnavailableCount}`);
    }

    const actionMap = new Map();
    for (const p of positionData) {
      if (exitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) }); continue; }
      if (dynamicStopMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", rule: "ATR_SL", reason: dynamicStopMap.get(p.position) }); continue; }
      if (onChainExitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", rule: "ONCHAIN", reason: onChainExitMap.get(p.position) }); continue; }
      if (taExitMap.has(p.position)) { actionMap.set(p.position, { action: "CLOSE", rule: "TA", reason: taExitMap.get(p.position) }); continue; }
      if (p.instruction) { actionMap.set(p.position, { action: "INSTRUCTION" }); continue; }

      const closeRule = await getDeterministicCloseRule(ctx, p);
      if (closeRule) { actionMap.set(p.position, closeRule); continue; }
      if ((p.unclaimed_fees_usd ?? 0) >= ctx.config.management.minClaimAmount) { actionMap.set(p.position, { action: "CLAIM" }); continue; }
      actionMap.set(p.position, { action: "STAY" });
    }

    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = ctx.config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = ctx.config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule) line += `\n${act.rule === "exit" ? "⚡ Trailing TP" : `Rule ${act.rule}`}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = ctx.config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    const actionPositions = positionData.filter(p => actionMap.get(p.position).action !== "STAY");

    if (actionPositions.length > 0) {
      _positionActionBusy.add(id);
      try {
        const execReport = await executeManagementActions(ctx, actionPositions, actionMap, { liveMessage, cur });
        if (execReport) mgmtReport += `\n\n${execReport}`;
      } finally {
        _positionActionBusy.delete(id);
      }
    } else {
      log("cron", `[${id}] Management: all positions STAY — skipping`);
      await liveMessage?.note("No tool actions needed.");
    }

    const afterPositions = await getMyPositions(ctx, { force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    const lastTriggered = _screeningLastTriggered.get(id) || 0;
    if (afterCount < ctx.config.risk.maxPositions && Date.now() - lastTriggered > screeningCooldownMs) {
      log("cron", `[${id}] Post-management: ${afterCount}/${ctx.config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle(ctx).catch((e) => log("cron_error", `[${id}] Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `[${id}] Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy.delete(id);
    if (mgmtReport) {
      if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
      else sendMessage(id, `🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => {});
    }
    for (const p of positions) {
      if (!p.in_range && p.minutes_out_of_range >= ctx.config.management.outOfRangeWaitMinutes) {
        notifyOutOfRange({ telegramId: id, pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => {});
      }
    }
  }
  return mgmtReport;
}

// ═══════════════════════════════════════════
//  SCREENING CYCLE
// ═══════════════════════════════════════════
async function runScreeningCycle(ctx, { silent = false } = {}) {
  const id = ctx.telegramId;
  if (_screeningBusy.has(id)) {
    log("cron", `[${id}] Screening skipped — previous cycle still running`);
    return null;
  }
  _screeningBusy.add(id);
  _screeningLastTriggered.set(id, Date.now());

  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions(ctx, { force: true }), getWalletBalances(ctx)]);
    if (prePositions.total_positions >= ctx.config.risk.maxPositions) {
      log("cron", `[${id}] Screening skipped — max positions reached (${prePositions.total_positions}/${ctx.config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${ctx.config.risk.maxPositions}).`;
      await appendDecision(id, { type: "skip", actor: "SCREENER", summary: "Screening skipped", reason: `Max positions reached (${prePositions.total_positions}/${ctx.config.risk.maxPositions})` });
      return screenReport;
    }
    const minRequired = ctx.config.management.deployAmountSol + ctx.config.management.gasReserve;
    if (!ctx.dryRun && preBalance.sol < minRequired) {
      log("cron", `[${id}] Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      await appendDecision(id, { type: "skip", actor: "SCREENER", summary: "Screening skipped", reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})` });
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `[${id}] Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    return screenReport;
  } finally {
    if (screenReport) _screeningBusy.delete(id);
  }
  if (!silent) liveMessage = await createLiveMessage(id, "🔍 Screening Cycle", "Scanning candidates...");
  log("cron", `[${id}] Starting screening cycle [model: ${ctx.config.llm.screeningModel}]`);
  try {
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(ctx.config, currentBalance.sol);
    log("cron", `[${id}] Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    const activeStrategy = await getActiveStrategy(id);
    const deployStrategy = ctx.config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    const topCandidates = await getTopCandidates(ctx, { limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const taAnalyzed = candidates.filter((pool) => pool?.ta_analysis?.enabled).length;
    const taUnavailable = candidates.filter((pool) => pool?.ta_analysis?.unavailable).length;
    const onChainAnalyzed = candidates.filter((pool) => pool?.onchain_signal?.enabled).length;
    const onChainUnavailable = candidates.filter((pool) => pool?.onchain_signal?.unavailable).length;
    const screeningFeatureFooter = [
      "FEATURE STATUS",
      `TA: ${ctx.config.technicalAnalysis?.enabled ? `ON (candidatesAnalyzed=${taAnalyzed}, unavailable=${taUnavailable})` : "OFF"}`,
      "RiskManagement: ON (used in management/exit path)",
      `OnChainIntelligence: ${ctx.config.onChainIntelligence?.enabled ? `ON (candidatesAnalyzed=${onChainAnalyzed}, unavailable=${onChainUnavailable})` : "OFF"}`,
      `Execution RequireFinalized: ${ctx.config.execution?.requireFinalized ? "ON" : "OFF"}`,
    ].join("\n");

    const smartMoneySummaryCandidates = buildSmartMoneySummary(ctx, candidates);

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool(id, { pool_address: pool.pool, base_mint: mint }),
        mint ? getTokenNarrative(ctx, { mint }) : Promise.resolve(null),
        mint ? getTokenInfo(ctx, { query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: await recallForPool(id, pool.pool),
      });
      await new Promise(r => setTimeout(r, 150));
    }

    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && ctx.config.screening.allowedLaunchpads?.length > 0 && !ctx.config.screening.allowedLaunchpads.includes(launchpad)) {
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && ctx.config.screening.blockedLaunchpads.includes(launchpad)) {
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = ctx.config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3).map((entry) => `- ${entry.name}: ${entry.reason}`).join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      screenReport += `\n\n${smartMoneySummaryCandidates}`;
      screenReport += `\n\n${screeningFeatureFooter}`;
      await appendDecision(id, {
        type: "no_deploy", actor: "SCREENER", summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(ctx, passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        const smartMoneySummaryPassing = buildSmartMoneySummary(ctx, passing.map((entry) => entry.pool));
        screenReport = [
          "⛔ NO DEPLOY", "", "Cycle finished with no valid entry.", "",
          "BEST LOOKING CANDIDATE", candidateName, "",
          "WHY SKIPPED", `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`, "",
          "REJECTED", `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        screenReport += `\n\n${smartMoneySummaryPassing}`;
        screenReport += `\n\n${screeningFeatureFooter}`;
        await appendDecision(id, { type: "no_deploy", actor: "SCREENER", summary: "Single candidate skipped", reason: skipReason, pool: passing[0].pool?.pool, pool_name: candidateName });
        return screenReport;
      }
    }

    const activeBinResults = await Promise.allSettled(passing.map(({ pool }) => getActiveBin(ctx, { pool_address: pool.pool })));

    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      if (ctx.config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(id, pool.pool, {
          base_mint: baseMint,
          organic_score: pool.organic_score ?? null,
          fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
          volume: pool.volume_window ?? null,
          mcap: pool.mcap ?? null,
          holder_count: ti?.holders ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality: n?.narrative ? "present" : "absent",
          volatility: pool.volatility ?? null,
        });
      }

      return block;
    });

    let deployAttempted = false;
    let deploySucceeded = false;
    const { content } = await agentLoop(ctx, `
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${ctx.config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${ctx.config.strategy.minBinsBelow} + (candidate volatility/5)*(${ctx.config.strategy.maxBinsBelow - ctx.config.strategy.minBinsBelow})) clamped to [${ctx.config.strategy.minBinsBelow},${ctx.config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Keep the whole report compact and highly scannable for Telegram.
      `, ctx.config.llm.maxSteps, [], "SCREENER", ctx.config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    const smartMoneySummaryPassing = buildSmartMoneySummary(ctx, passing.map((entry) => entry.pool));
    screenReport = content;
    screenReport += `\n\n${smartMoneySummaryPassing}`;
    screenReport += `\n\n${screeningFeatureFooter}`;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      await appendDecision(id, { type: "no_deploy", actor: "SCREENER", summary: "LLM chose no deploy", reason: stripThink(content).slice(0, 500) });
    } else if (!deploySucceeded) {
      await appendDecision(id, { type: "no_deploy", actor: "SCREENER", summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle", reason: stripThink(content).slice(0, 500) });
    }
  } catch (error) {
    log("cron_error", `[${id}] Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy.delete(id);
    if (screenReport) {
      if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
      else if (!silent) sendMessage(id, `🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => {});
    }
  }
  return screenReport;
}

// ═══════════════════════════════════════════
//  JOB PROCESSORS
// ═══════════════════════════════════════════
async function processManagementJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  const content = await runManagementCycle(ctx);
  return { content };
}

async function processScreeningJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  const content = await runScreeningCycle(ctx);
  return { content };
}

async function processHealthCheckJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  if (_managementBusy.has(telegramId)) return { skipped: true, reason: "management busy" };
  log("cron", `[${telegramId}] Starting health check`);
  try {
    const { content } = await agentLoop(ctx, `
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, ctx.config.llm.maxSteps, [], "MANAGER");
    return { content };
  } catch (error) {
    log("cron_error", `[${telegramId}] Health check failed: ${error.message}`);
    return { error: error.message };
  }
}

/** One tick of the fast real-time exit poller — mirrors the old 3s setInterval, now one BullMQ job per tick. */
async function processPnlPollJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  if (_positionActionBusy.has(telegramId)) return { skipped: true, reason: "position action busy" };
  if ((await getTrackedPositions(telegramId, true)).length === 0) return { skipped: true, reason: "no tracked positions" };

  const confirmTicks = Math.max(1, Number(ctx.config.pnl.confirmTicks ?? 2));
  try {
    const result = await getMyPositions(ctx, { force: true, silent: true }).catch(() => null);
    if (!result?.positions?.length) return { skipped: true };
    for (const p of result.positions) {
      await confirmPeak(telegramId, p.position, p.pnl_pct, confirmTicks);

      const exit = await updatePnlAndCheckExits(telegramId, p.position, p, ctx.config.management);
      const closeRule = exit ? null : await getDeterministicCloseRule(ctx, p);
      let signal = null, reason = null, rule = "exit";
      if (exit) { signal = exit.action; reason = exit.reason; }
      else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

      const { fire } = await registerExitSignal(telegramId, p.position, signal, confirmTicks);
      if (!signal || !fire) continue;

      log("state", `[${telegramId}] [PnL poll] ${signal} confirmed (${confirmTicks} ticks): ${p.pair} — ${reason} — closing directly`);
      _positionActionBusy.add(telegramId);
      try {
        const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
        const rpt = await executeManagementActions(ctx, [p], actMap, {});
        log("state", `[${telegramId}] [PnL poll] ${p.pair}: ${rpt || "closed"}`);
      } catch (e) {
        log("cron_error", `[${telegramId}] Poll-triggered close failed: ${e.message}`);
      } finally {
        _positionActionBusy.delete(telegramId);
      }
      break; // one action per tick
    }
    return { ok: true };
  } catch (error) {
    log("cron_error", `[${telegramId}] PnL poll failed: ${error.message}`);
    return { error: error.message };
  }
}

/** One tick of the opportunity poller — catches strong pools between screening cycles. */
async function processOpportunityPollJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  if (!ctx.config.opportunity.enabled) return { skipped: true, reason: "opportunity poll disabled" };
  if (_screeningBusy.has(telegramId) || _managementBusy.has(telegramId)) return { skipped: true, reason: "busy" };
  const oppCooldownMs = 5 * 60 * 1000;
  const lastTriggered = _screeningLastTriggered.get(telegramId) || 0;
  if (Date.now() - lastTriggered < oppCooldownMs) return { skipped: true, reason: "cooldown" };

  try {
    const [positions, balance] = await Promise.all([
      getMyPositions(ctx, { force: true, silent: true }).catch(() => null),
      getWalletBalances(ctx).catch(() => null),
    ]);
    if (!positions || (positions.total_positions ?? 0) >= ctx.config.risk.maxPositions) return { skipped: true };
    const minRequired = ctx.config.management.deployAmountSol + ctx.config.management.gasReserve;
    if (!ctx.dryRun && (!balance || balance.sol < minRequired)) return { skipped: true, reason: "insufficient SOL" };

    const top = await getTopCandidates(ctx, { limit: ctx.config.opportunity.limit }).catch(() => null);
    const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(ctx, b, ctx.config.opportunity) - degenScore(ctx, a, ctx.config.opportunity));
    if (!candidates.length) return { skipped: true, reason: "no candidates" };

    const minScore = ctx.config.opportunity.minScore;
    const bonus = Number(ctx.config.opportunity.smartWalletScoreBonus ?? 0);
    const floor = minScore - bonus;

    let trigger = null;
    for (const c of candidates) {
      const s = degenScore(ctx, c, ctx.config.opportunity);
      if (s < floor) break;
      if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
      if (bonus <= 0) continue;
      const smart = (await checkSmartWalletsOnPool(telegramId, { pool_address: c.pool }).catch(() => null))?.in_pool || [];
      if (smart.length > 0) { trigger = { c, s, smart }; break; }
    }
    if (!trigger) return { skipped: true, reason: "no qualifying candidate" };

    const smartTag = trigger.smart.length
      ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
      : "";
    log("cron", `[${telegramId}] [Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
    runScreeningCycle(ctx, { silent: true }).catch((e) => log("cron_error", `[${telegramId}] Opportunity-triggered screening failed: ${e.message}`));
    return { triggered: true, pool: trigger.c.name };
  } catch (error) {
    log("cron_error", `[${telegramId}] Opportunity poll failed: ${error.message}`);
    return { error: error.message };
  }
}

/** Daily morning briefing (1:00 AM UTC), skips if already sent today for this user. */
async function processBriefingJob(job) {
  const { telegramId } = job.data;
  const ctx = await loadActiveUserContext(telegramId);
  if (!ctx) return { skipped: true };
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = await getLastBriefingDate(telegramId);
  if (lastSent === todayUtc) return { skipped: true, reason: "already sent today" };

  log("cron", `[${telegramId}] Sending morning briefing`);
  try {
    const briefing = await generateBriefing(telegramId);
    await sendHTML(telegramId, briefing);
    await setLastBriefingDate(telegramId);
    return { sent: true };
  } catch (error) {
    log("cron_error", `[${telegramId}] Morning briefing failed: ${error.message}`);
    return { error: error.message };
  }
}

export const managementWorker = new Worker(QUEUE_NAMES.MANAGEMENT, processManagementJob, { connection, concurrency: WORKER_CONCURRENCY });
export const screeningWorker = new Worker(QUEUE_NAMES.SCREENING, processScreeningJob, { connection, concurrency: WORKER_CONCURRENCY });
export const healthCheckWorker = new Worker(QUEUE_NAMES.HEALTHCHECK, processHealthCheckJob, { connection, concurrency: WORKER_CONCURRENCY });
export const pnlPollWorker = new Worker(QUEUE_NAMES.PNL_POLL, processPnlPollJob, { connection, concurrency: WORKER_CONCURRENCY * 4 });
export const opportunityPollWorker = new Worker(QUEUE_NAMES.OPPORTUNITY_POLL, processOpportunityPollJob, { connection, concurrency: WORKER_CONCURRENCY });
export const briefingWorker = new Worker(QUEUE_NAMES.BRIEFING, processBriefingJob, { connection, concurrency: WORKER_CONCURRENCY });

const ALL_WORKERS = [managementWorker, screeningWorker, healthCheckWorker, pnlPollWorker, opportunityPollWorker, briefingWorker];

for (const worker of ALL_WORKERS) {
  worker.on("failed", (job, error) => {
    log("queue_error", `[${job?.data?.telegramId}] ${worker.name} job ${job?.id} failed: ${error.message}`);
  });
  worker.on("error", (error) => {
    log("queue_error", `${worker.name} worker error: ${error.message}`);
  });
}

export async function closeAllWorkers() {
  await Promise.all(ALL_WORKERS.map((worker) => worker.close()));
}

// Exported for reuse by index.js's Telegram business-command handler (/screen, /deploy, etc.)
export { runManagementCycle, runScreeningCycle };
