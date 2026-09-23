import crypto from "crypto";
import fs from "fs";
import { log } from "./logger.js";
import { prisma } from "./db/client.js";
import { getUserConfig, getUserSecrets } from "./user-config-service.js";
import { repoPath } from "./repo-root.js";

const PACKAGE_JSON_PATH = repoPath("package.json");
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

const _heartbeatTimers = new Map(); // telegramId -> timer

function sanitizeText(text, maxLen = 400) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const AGENT_VERSION = getVersion();

async function readCache(telegramId) {
  const row = await prisma.hiveMindCache.findUnique({ where: { telegramId } });
  return row || { agentId: null, pullMode: "auto", sharedLessons: [], presets: [], pulledAt: null };
}

async function writeCache(telegramId, patch) {
  await prisma.hiveMindCache.upsert({
    where: { telegramId },
    update: patch,
    create: { telegramId, ...patch },
  });
}

function getBaseUrl(userConfig) {
  return sanitizeText(userConfig?.hiveMind?.url || "", 500) || "";
}

function getApiKey(userSecrets) {
  return sanitizeText(userSecrets?.hiveMindApiKey || "", 300) || "";
}

function getPullMode(userConfig) {
  const mode = sanitizeText(userConfig?.hiveMind?.pullMode || "auto", 20) || "auto";
  return mode === "manual" ? "manual" : "auto";
}

export function getHiveMindPullMode(userConfig) {
  return getPullMode(userConfig);
}

export function isHiveMindEnabled(userConfig, userSecrets) {
  return !!(getBaseUrl(userConfig) && getApiKey(userSecrets));
}

/** Get (or lazily generate) this user's HiveMind agent id. */
export async function ensureAgentId(telegramId) {
  const cache = await readCache(telegramId);
  if (cache.agentId) return cache.agentId;

  const agentId = `agt_${crypto.randomBytes(12).toString("hex")}`;
  await writeCache(telegramId, { agentId });
  log("hivemind", `[${telegramId}] Generated agentId ${agentId}`);
  return agentId;
}

function buildUrl(baseUrl, pathname, query = {}) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function requestJson(userConfig, userSecrets, pathname, { method = "GET", body = null, query = {} } = {}) {
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  const response = await fetch(buildUrl(getBaseUrl(userConfig), pathname, query), {
    method,
    headers: {
      accept: "application/json",
      "x-api-key": getApiKey(userSecrets),
      ...(body != null ? { "content-type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HiveMind ${response.status}`);
  }
  return payload;
}

function normalizeSharedLesson(lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  return {
    id: lesson.id || lesson.lessonId || `shared_${Date.now()}`,
    rule,
    tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
    role: sanitizeText(lesson.role || "", 20) || null,
    outcome: sanitizeText(lesson.outcome || "shared", 20) || "shared",
    sourceType: sanitizeText(lesson.sourceType || lesson.source || "shared", 24) || "shared",
    score: Number.isFinite(Number(lesson.score)) ? Number(lesson.score) : null,
    created_at: lesson.created_at || lesson.createdAt || new Date().toISOString(),
  };
}

export async function getSharedLessonsForPrompt(telegramId, { agentType = "GENERAL", maxLessons = 6 } = {}) {
  const role = String(agentType || "GENERAL").toUpperCase();
  const cache = await readCache(telegramId);
  const shared = (cache.sharedLessons || [])
    .map(normalizeSharedLesson)
    .filter(Boolean)
    .filter((lesson) => !lesson.role || lesson.role === role || role === "GENERAL")
    .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
    .slice(0, maxLessons);

  if (!shared.length) return null;
  return shared
    .map((lesson) => `[HIVEMIND${lesson.score != null ? ` score=${lesson.score}` : ""}] ${lesson.rule}`)
    .join("\n");
}

export async function registerHiveMindAgent(telegramId, userConfig, userSecrets, { reason = "heartbeat" } = {}) {
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  try {
    const agentId = await ensureAgentId(telegramId);
    return await requestJson(userConfig, userSecrets, "/api/hivemind/agents/register", {
      method: "POST",
      body: {
        agentId,
        version: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        reason,
        capabilities: {
          telegram: true,
          lpagent: !!userSecrets?.lpAgentApiKey,
          dryRun: false,
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `[${telegramId}] Agent register failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindLessons(telegramId, userConfig, userSecrets, limit = 12) {
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  try {
    const agentId = await ensureAgentId(telegramId);
    const payload = await requestJson(userConfig, userSecrets, "/api/hivemind/lessons/pull", {
      query: { agentId, limit },
    });
    const sharedLessons = Array.isArray(payload?.lessons)
      ? payload.lessons.map(normalizeSharedLesson).filter(Boolean)
      : [];
    await writeCache(telegramId, { sharedLessons, pulledAt: new Date() });
    return sharedLessons;
  } catch (error) {
    log("hivemind_warn", `[${telegramId}] Lesson pull failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindPresets(telegramId, userConfig, userSecrets) {
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  try {
    const agentId = await ensureAgentId(telegramId);
    const payload = await requestJson(userConfig, userSecrets, "/api/hivemind/presets/pull", {
      query: { agentId },
    });
    const presets = Array.isArray(payload?.presets) ? payload.presets : [];
    await writeCache(telegramId, { presets, pulledAt: new Date() });
    return presets;
  } catch (error) {
    log("hivemind_warn", `[${telegramId}] Preset pull failed: ${error.message}`);
    return null;
  }
}

/** Fetch this user's config+secrets and bootstrap their HiveMind participation. */
export async function bootstrapHiveMind(telegramId) {
  const userConfig = await getUserConfig(telegramId);
  const userSecrets = await getUserSecrets(telegramId);
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  const agentId = await ensureAgentId(telegramId);
  const tasks = [registerHiveMindAgent(telegramId, userConfig, userSecrets, { reason: "startup" })];
  if (getPullMode(userConfig) === "auto") {
    tasks.push(pullHiveMindLessons(telegramId, userConfig, userSecrets), pullHiveMindPresets(telegramId, userConfig, userSecrets));
  }
  await Promise.allSettled(tasks);
  return { enabled: true, agentId, pullMode: getPullMode(userConfig) };
}

/** Start (or no-op if already running) a per-user HiveMind heartbeat. */
export function startHiveMindBackgroundSync(telegramId) {
  if (_heartbeatTimers.has(telegramId)) return _heartbeatTimers.get(telegramId);
  const timer = setInterval(async () => {
    const userConfig = await getUserConfig(telegramId);
    const userSecrets = await getUserSecrets(telegramId);
    if (!isHiveMindEnabled(userConfig, userSecrets)) return;
    const tasks = [registerHiveMindAgent(telegramId, userConfig, userSecrets, { reason: "heartbeat" })];
    if (getPullMode(userConfig) === "auto") {
      tasks.push(pullHiveMindLessons(telegramId, userConfig, userSecrets), pullHiveMindPresets(telegramId, userConfig, userSecrets));
    }
    await Promise.allSettled(tasks);
  }, HEARTBEAT_INTERVAL_MS);
  _heartbeatTimers.set(telegramId, timer);
  return timer;
}

export function stopHiveMindBackgroundSync(telegramId) {
  const timer = _heartbeatTimers.get(telegramId);
  if (timer) {
    clearInterval(timer);
    _heartbeatTimers.delete(telegramId);
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildMarketFields(source) {
  const market = {
    entryMcap: numberOrNull(source?.entry_mcap),
    entryTvl: numberOrNull(source?.entry_tvl),
    entryVolume: numberOrNull(source?.entry_volume),
    exitMcap: numberOrNull(source?.exit_mcap),
    exitTvl: numberOrNull(source?.exit_tvl),
    exitVolume: numberOrNull(source?.exit_volume),
  };
  return Object.values(market).some((value) => value != null) ? market : null;
}

function buildLessonEvent(agentId, lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  const sourceType = sanitizeText(lesson.sourceType || inferLessonSourceType(lesson), 24) || "manual";
  const market = buildMarketFields(lesson);
  const context = sanitizeText(lesson?.context, 600);
  return {
    eventId: `lesson:${agentId}:${lesson.id || crypto.randomUUID()}`,
    agentId,
    version: AGENT_VERSION,
    timestamp: lesson.created_at || new Date().toISOString(),
    lesson: {
      id: lesson.id || null,
      rule,
      tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
      role: sanitizeText(lesson.role || "", 20) || null,
      outcome: sanitizeText(lesson.outcome || "manual", 20) || "manual",
      sourceType,
      confidence: Number.isFinite(Number(lesson.confidence)) ? Number(lesson.confidence) : null,
      pool: sanitizeText(lesson.pool || "", 64) || null,
      pinned: !!lesson.pinned,
      context: context || null,
      market,
      metrics: {
        pnlPct: Number.isFinite(Number(lesson.pnl_pct)) ? Number(lesson.pnl_pct) : null,
        feesUsd: Number.isFinite(Number(lesson.fees_earned_usd)) ? Number(lesson.fees_earned_usd) : null,
        initialValueUsd: Number.isFinite(Number(lesson.initial_value_usd)) ? Number(lesson.initial_value_usd) : null,
        rangeEfficiency: Number.isFinite(Number(lesson.range_efficiency)) ? Number(lesson.range_efficiency) : null,
        closeReason: sanitizeText(lesson.close_reason || "", 160) || null,
      },
    },
  };
}

function inferLessonSourceType(lesson) {
  const tags = Array.isArray(lesson?.tags) ? lesson.tags.map((tag) => String(tag).toLowerCase()) : [];
  const rule = String(lesson?.rule || "").toLowerCase();
  if (tags.includes("self_tune") || tags.includes("config_change") || rule.startsWith("[self-tuned]")) {
    return "config_change";
  }
  if (lesson?.outcome === "manual") {
    return "manual";
  }
  return "performance";
}

export async function pushHiveLesson(telegramId, lesson) {
  const userConfig = await getUserConfig(telegramId);
  const userSecrets = await getUserSecrets(telegramId);
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  const agentId = await ensureAgentId(telegramId);
  const body = buildLessonEvent(agentId, lesson);
  if (!body) return null;
  try {
    return await requestJson(userConfig, userSecrets, "/api/hivemind/lessons/push", {
      method: "POST",
      body,
    });
  } catch (error) {
    log("hivemind_warn", `[${telegramId}] Lesson push failed: ${error.message}`);
    return null;
  }
}

function shouldCountInAdjustedWinRate(closeReason) {
  const text = String(closeReason || "").toLowerCase();
  return !(
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

export async function pushHivePerformanceEvent(telegramId, perf) {
  const userConfig = await getUserConfig(telegramId);
  const userSecrets = await getUserSecrets(telegramId);
  if (!isHiveMindEnabled(userConfig, userSecrets)) return null;
  const agentId = await ensureAgentId(telegramId);
  try {
    return await requestJson(userConfig, userSecrets, "/api/hivemind/performance/push", {
      method: "POST",
      body: {
        eventId: sanitizeText(perf.eventId, 200) || `close:${agentId}:${perf.position || perf.pool}:${perf.recorded_at || Date.now()}`,
        agentId,
        version: AGENT_VERSION,
        timestamp: perf.recorded_at || new Date().toISOString(),
        event: {
          pool: sanitizeText(perf.pool, 64) || null,
          poolName: sanitizeText(perf.pool_name, 80) || null,
          baseMint: sanitizeText(perf.base_mint, 64) || null,
          strategy: sanitizeText(perf.strategy, 32) || null,
          closeReason: sanitizeText(perf.close_reason, 200) || "unknown",
          pnlUsd: Number(perf.pnl_usd || 0),
          pnlPct: Number(perf.pnl_pct || 0),
          feesUsd: Number(perf.fees_earned_usd || 0),
          feesSol: Number(perf.fees_earned_sol || 0),
          minutesHeld: Number(perf.minutes_held || 0),
          countInAdjustedWinRate: shouldCountInAdjustedWinRate(perf.close_reason),
          market: buildMarketFields(perf),
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `[${telegramId}] Performance push failed: ${error.message}`);
    return null;
  }
}
