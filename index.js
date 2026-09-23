/**
 * Multi-tenant bootstrap. This process:
 *  1. Boots each active user's HiveMind participation.
 *  2. Registers BullMQ recurring cycles (management/screening/healthcheck/
 *     pnl-poll/opportunity-poll/briefing) for every active user and starts
 *     the workers that process them (queue/workers.js).
 *  3. Wires tools/executor.js's cron-restarter hook so `/config` changes to
 *     schedule/pnl/opportunity settings reschedule that user's jobs immediately.
 *  4. Starts the Telegram long-poll loop, handling business commands
 *     (positions/pool/close/closeall/set/setcfg/screen/candidates/deploy/
 *     briefing/hive + free-form chat) that telegram.js forwards here after
 *     handling its own built-in account commands (/start, /config, /exportkey, ...).
 *
 * NOT ported from the old single-tenant index.js (documented, not
 * fabricated): the interactive TTY REPL and the inline-button /settings menu
 * — see queue/workers.js's file header for why.
 */

import "./envcrypt.js";
import { log } from "./logger.js";
import { REPO_ROOT } from "./repo-root.js";
import { listActiveUsers } from "./user-config-service.js";
import { buildUserContext } from "./tools/context.js";
import { scheduleAllActiveUsers, rescheduleUserCycles } from "./queue/queues.js";
import { closeAllWorkers, runScreeningCycle } from "./queue/workers.js";
import { connection as redisConnection } from "./queue/redis.js";
import { registerCronRestarter, executeTool } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendHTML,
  createLiveMessage,
} from "./telegram.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { setPositionInstruction } from "./state.js";
import { generateBriefing } from "./briefing.js";
import { agentLoop } from "./agent.js";
import { computeDeployAmount } from "./user-config-service.js";
import {
  ensureAgentId,
  bootstrapHiveMind,
  startHiveMindBackgroundSync,
  isHiveMindEnabled,
  getHiveMindPullMode,
  registerHiveMindAgent,
  pullHiveMindLessons,
  pullHiveMindPresets,
} from "./hivemind.js";
import { getLoneCandidateSkipReason } from "./queue/cycle-helpers.js";

log("startup", "BIGDEAL multi-tenant agent starting...");
log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);

// ─── Per-user in-memory state (business commands only — cycle state lives in queue/workers.js) ─
const _latestCandidates = new Map(); // telegramId -> { candidates, updatedAt }
const _sessionHistory = new Map();   // telegramId -> [{role, content}, ...]
const _busy = new Set();             // telegramId currently running a free-form/agent request
const _telegramQueue = new Map();    // telegramId -> queued raw text messages
const MAX_HISTORY = 20;

function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function appendHistory(telegramId, userMsg, assistantMsg) {
  const history = _sessionHistory.get(telegramId) || [];
  history.push({ role: "user", content: userMsg }, { role: "assistant", content: assistantMsg });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  _sessionHistory.set(telegramId, history);
}

function setLatestCandidates(telegramId, candidates = []) {
  _latestCandidates.set(telegramId, { candidates: Array.isArray(candidates) ? candidates : [], updatedAt: new Date().toISOString() });
}

function getLatestCandidates(telegramId) {
  return _latestCandidates.get(telegramId)?.candidates || [];
}

function describeLatestCandidates(telegramId, limit = 5) {
  const entry = _latestCandidates.get(telegramId);
  if (!entry || !entry.candidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = entry.candidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = new Date(entry.updatedAt).toLocaleString("en-US", { hour12: false });
  return `Latest candidates (${entry.candidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

async function runDeterministicScreen(ctx, limit = 5) {
  const top = await getTopCandidates(ctx, { limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(ctx.telegramId, candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3).map((entry) => `- ${entry.name}: ${entry.reason}`).join("\n");
  return examples ? `No candidates available.\nFiltered examples:\n${examples}` : "No candidates available right now.";
}

function computeBinsBelowLocal(ctx, volatility) {
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  const lo = ctx.config.strategy.minBinsBelow;
  const hi = ctx.config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (v / 5) * (hi - lo))));
}

async function deployLatestCandidate(ctx, index) {
  const candidates = getLatestCandidates(ctx.telegramId);
  const candidate = candidates[index];
  if (!candidate) throw new Error("Invalid candidate index. Run /screen first.");
  if (candidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool(ctx.telegramId, { pool_address: candidate.pool }),
      mint ? getTokenNarrative(ctx, { mint }) : Promise.resolve(null),
      mint ? getTokenInfo(ctx, { query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(ctx, context);
    if (skipReason) {
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount(ctx.config, (await getWalletBalances(ctx)).sol);
  const binsBelow = computeBinsBelowLocal(ctx, candidate.volatility);
  const result = await executeTool(ctx, "deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: ctx.config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) throw new Error(result.error || "Deploy failed");
  return { result, candidate, deployAmount, binsBelow };
}

async function drainTelegramQueue(telegramId) {
  const queue = _telegramQueue.get(telegramId);
  while (queue && queue.length > 0 && !_busy.has(telegramId)) {
    const queued = queue.shift();
    await handleBusinessCommand(queued, telegramId);
  }
}

async function handleHiveCommand(ctx, isManualPull) {
  const enabled = isHiveMindEnabled(ctx.config, ctx.secrets);
  const agentId = await ensureAgentId(ctx.telegramId);
  if (!enabled) {
    await sendMessage(ctx.telegramId, `HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
    return;
  }
  const pullMode = getHiveMindPullMode(ctx.config);
  const [registerResult, lessons, presets] = await Promise.all([
    registerHiveMindAgent(ctx.telegramId, ctx.config, ctx.secrets, { reason: isManualPull ? "telegram_pull" : "telegram_status" }),
    (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(ctx.telegramId, ctx.config, ctx.secrets, 12) : Promise.resolve(null),
    (pullMode === "auto" || isManualPull) ? pullHiveMindPresets(ctx.telegramId, ctx.config, ctx.secrets) : Promise.resolve(null),
  ]);
  await sendMessage(ctx.telegramId, [
    "HiveMind: enabled",
    `Agent ID: ${agentId}`,
    `URL: ${ctx.config.hiveMind.url}`,
    `Pull mode: ${pullMode}`,
    `Register: ${registerResult ? "ok" : "warn"}`,
    `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
    `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
    isManualPull ? "Manual pull: completed" : null,
  ].filter(Boolean).join("\n")).catch(() => {});
}

/**
 * Business commands forwarded here by telegram.js after its own built-in
 * account commands (/start, /help, /status, /wallet, /positions [basic],
 * /config, /dryrun, /pause, /resume, /exportkey) have already been handled.
 */
async function handleBusinessCommand(msg, telegramId) {
  const text = String(msg.text || "").trim();
  if (!text) return;

  if (_busy.has(telegramId)) {
    const queue = _telegramQueue.get(telegramId) || [];
    if (queue.length < 5) {
      queue.push(msg);
      _telegramQueue.set(telegramId, queue);
      sendMessage(telegramId, `⏳ Queued (${queue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage(telegramId, "Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  let ctx;
  try {
    ctx = await buildUserContext(telegramId);
  } catch (error) {
    await sendMessage(telegramId, `Error: ${error.message}`).catch(() => {});
    return;
  }

  if (text === "/briefing") {
    try {
      await sendHTML(telegramId, await generateBriefing(telegramId));
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions(ctx, { force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(telegramId, "Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(telegramId, [
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${ctx.config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${ctx.config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions(ctx, { force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(telegramId, "Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(telegramId, `Closing ${pos.pair}...`);
      const result = await closePosition(ctx, { position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(telegramId, `✅ Closed ${pos.pair}\nPnL: ${ctx.config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(telegramId, `❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions(ctx, { force: true });
      if (!positions.length) { await sendMessage(telegramId, "No open positions."); return; }
      await sendMessage(telegramId, `Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition(ctx, { position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(telegramId, `Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions(ctx, { force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage(telegramId, "Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await setPositionInstruction(telegramId, pos.position, note);
      await sendMessage(telegramId, `✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(telegramId, await runDeterministicScreen(ctx, 5)).catch(() => {});
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(telegramId, describeLatestCandidates(telegramId, 5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(ctx, idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${ctx.config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage(telegramId, [
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) { await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      await handleHiveCommand(ctx, text === "/hive pull");
    } catch (e) { await sendMessage(telegramId, `HiveMind error: ${e.message}`).catch(() => {}); }
    return;
  }

  // ── Free-form chat / callback data we don't recognize as a slash command ──
  _busy.add(telegramId);
  let liveMessage = null;
  try {
    log("telegram", `[${telegramId}] Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? ctx.config.llm.screeningModel : ctx.config.llm.generalModel;
    const sessionHistory = _sessionHistory.get(telegramId) || [];
    liveMessage = await createLiveMessage(telegramId, "🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(ctx, text, ctx.config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(telegramId, text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(telegramId, stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(telegramId, `Error: ${e.message}`).catch(() => {});
  } finally {
    _busy.delete(telegramId);
    drainTelegramQueue(telegramId).catch(() => {});
  }
}

// ═══════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════
let _shuttingDown = false;

async function bootstrapActiveUsersHiveMind() {
  const users = await listActiveUsers();
  for (const user of users) {
    try {
      await ensureAgentId(user.telegramId);
      await bootstrapHiveMind(user.telegramId);
      startHiveMindBackgroundSync(user.telegramId);
    } catch (error) {
      log("hivemind_warn", `[${user.telegramId}] Bootstrap failed: ${error.message}`);
    }
  }
  log("startup", `HiveMind bootstrapped for ${users.length} active user(s)`);
}

async function main() {
  await bootstrapActiveUsersHiveMind();
  await scheduleAllActiveUsers();
  registerCronRestarter(rescheduleUserCycles);
  startPolling(handleBusinessCommand);
  log("startup", "Multi-tenant agent ready — BullMQ workers + Telegram polling active.");
}

main().catch((error) => {
  log("startup_error", `Fatal startup error: ${error.message}`);
  process.exit(1);
});

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  await withTimeout(closeAllWorkers(), 10_000);
  await withTimeout(redisConnection.quit(), 5_000);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Exported for scripts/tests that want to trigger a one-off screening cycle for a user.
export { runScreeningCycle };
