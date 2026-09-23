/**
 * signal-tracker.js — Stages screening signals for later attribution.
 * In-memory only, namespaced per telegramId so concurrent users' screening
 * cycles never cross-contaminate. Deploy-time persistence is not currently
 * wired, so staged signals are short-lived context rather than durable data.
 */

import { log } from "./logger.js";

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map(); // key: `${telegramId}:${poolAddress}`
const _stagedByBaseMint = new Map(); // key: `${telegramId}:${baseMint}`
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(value) {
  return value ? String(value).trim() : null;
}

function cleanupStale() {
  const now = Date.now();
  for (const [key, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(key);
      if (data.base_mint && _stagedByBaseMint.get(`${data.telegramId}:${data.base_mint}`) === key) {
        _stagedByBaseMint.delete(`${data.telegramId}:${data.base_mint}`);
      }
    }
  }
}

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param {string} telegramId
 * @param {string} poolAddress
 * @param {object} signals — { organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, hive_consensus, volatility }
 */
export function stageSignals(telegramId, poolAddress, signals) {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;
  const key = `${telegramId}:${poolKey}`;

  const baseMint = normalizeKey(signals?.base_mint || signals?.baseMint);
  _staged.set(key, {
    ...signals,
    telegramId,
    base_mint: baseMint || signals?.base_mint || null,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _stagedByBaseMint.set(`${telegramId}:${baseMint}`, key);
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param {string} telegramId
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(telegramId, poolAddress, baseMint = null) {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let key = poolKey ? `${telegramId}:${poolKey}` : null;
  let data = key ? _staged.get(key) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    key = baseKey ? _stagedByBaseMint.get(`${telegramId}:${baseKey}`) : null;
    data = key ? _staged.get(key) : null;
  }

  if (!data) return null;
  _staged.delete(key);
  if (data.base_mint && _stagedByBaseMint.get(`${telegramId}:${data.base_mint}`) === key) {
    _stagedByBaseMint.delete(`${telegramId}:${data.base_mint}`);
  }
  const { staged_at, telegramId: _tg, ...signals } = data;
  log("signals", `[${telegramId}] Retrieved staged signals for ${poolKey?.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses for a user (for debugging).
 */
export function getStagedPools(telegramId) {
  cleanupStale();
  const prefix = `${telegramId}:`;
  return [..._staged.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

