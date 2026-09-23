/**
 * Pure/ctx-based helper functions for the management & screening cycles,
 * ported from the old single-tenant index.js so queue/workers.js's job
 * processors can reuse them per-user.
 */

import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";
import { degenScore } from "../tools/screening.js";
import { executeTool } from "../tools/executor.js";
import { agentLoop } from "../agent.js";

export async function getDeterministicCloseRule(ctx, position) {
  const tracked = await getTrackedPosition(ctx.telegramId, position.position);
  const managementConfig = ctx.config.management;
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amountSol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `[${ctx.telegramId}] Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (position.ta_exit_signal?.should_close) {
    return {
      action: "CLOSE",
      rule: "TA",
      reason: position.ta_exit_signal.reason || "technical analysis exit",
    };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

export function getLoneCandidateSkipReason(ctx, { pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const degen = degenScore(ctx, pool, ctx.config.opportunity);
  const degenStrong = degen >= (ctx.config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  if (Number.isFinite(globalFeesSol) && globalFeesSol < ctx.config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${ctx.config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > ctx.config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${ctx.config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > ctx.config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${ctx.config.screening.maxBotHoldersPct}%`;
  }
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${ctx.config.screening.loneCandidateMinDegen ?? 50})`;
  }
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${ctx.config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

export function computeBinsBelow(ctx, volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = ctx.config.strategy.minBinsBelow;
  const hi = ctx.config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function buildSmartMoneySummary(ctx, pools = []) {
  if (!ctx.config.onChainIntelligence?.enabled) {
    return "SMART MONEY SUMMARY\nOFF";
  }
  const rows = [];
  for (const pool of pools) {
    const sm = pool?.onchain_signal?.smart_money;
    if (!sm?.available) continue;
    const buy = Number(sm.netBuyUsd);
    const sell = Number(sm.netSellUsd);
    const net = (Number.isFinite(buy) ? buy : 0) - (Number.isFinite(sell) ? sell : 0);
    rows.push({
      name: pool?.name || pool?.pool || "unknown",
      buy,
      sell,
      net,
      source: sm.source || "unknown",
    });
  }
  if (!rows.length) {
    return "SMART MONEY SUMMARY\nNo smart money flow data available this cycle.";
  }
  const lines = rows.slice(0, 3).map((row) => {
    const sign = row.net >= 0 ? "+" : "-";
    return `- ${row.name}: buy=${formatUsd(row.buy)} | sell=${formatUsd(row.sell)} | net=${sign}${formatUsd(Math.abs(row.net))} (${row.source})`;
  });
  return ["SMART MONEY SUMMARY", ...lines].join("\n");
}

/**
 * Execute deterministic CLOSE/CLAIM actions directly via executeTool (no LLM),
 * and hand INSTRUCTION positions (free-text conditions) to the MANAGER LLM.
 * Returns a one-line-per-position result string.
 */
export async function executeManagementActions(ctx, actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `[${ctx.telegramId}] Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      await liveMessage?.toolStart("close_position");
      const res = await executeTool(ctx, "close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool(ctx, "claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  if (instructionPositions.length > 0) {
    log("cron", `[${ctx.telegramId}] Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${ctx.config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(ctx, `
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, ctx.config.llm.maxSteps, [], "MANAGER", ctx.config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}
