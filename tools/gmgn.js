import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { log } from "../logger.js";
import { getCircuitBreaker } from "../utils/resilience/circuit-breaker.js";
import { isRetryableError } from "../utils/resilience/with-retry.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;
let gmgnPaceQueue = Promise.resolve();
const gmgnBreaker = getCircuitBreaker("gmgn-api", {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxSuccesses: 1,
  isFailure: isRetryableError,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chained onto gmgnPaceQueue so concurrent callers wait their turn instead of racing
// past a shared check-then-set timestamp (which let bursts slip past the rate limit).
function paceGmgnRequest(ctx) {
  const turn = gmgnPaceQueue.then(async () => {
    const delayMs = Math.max(0, Number(ctx.config?.gmgn?.requestDelayMs ?? 2500));
    if (delayMs) {
      const elapsed = Date.now() - lastGmgnRequestAt;
      if (elapsed < delayMs) await sleep(delayMs - elapsed);
    }
    lastGmgnRequestAt = Date.now();
  });
  gmgnPaceQueue = turn.catch(() => {});
  return turn;
}

function getApiKey(ctx) {
  const key = ctx.secrets?.gmgnApiKey;
  if (!key) throw new Error("GMGN API key belum diset — atur lewat /config.");
  return key;
}

export function hasGmgnApiKey(ctx) {
  return !!ctx.secrets?.gmgnApiKey;
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(ctx, pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(ctx.config?.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(ctx.config?.gmgn?.maxRetries ?? 2));
  return gmgnBreaker.execute(async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await paceGmgnRequest(ctx);
      const res = await fetch(url, {
        method,
        headers: {
          "X-APIKEY": getApiKey(ctx),
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : null,
      });
      const text = await res.text().catch(() => "");
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
      const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
      if (res.ok) return payload;
      if (rateLimited && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoffMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : /temporarily banned/i.test(String(message))
            ? 60000
            : Math.min(30000, 3000 * Math.pow(2, attempt));
        await sleep(backoffMs);
        continue;
      }
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    throw new Error(`GMGN ${pathname} failed`);
  });
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(data, keys = []) {
  for (const key of keys) {
    const value = num(data?.[key]);
    if (value != null) return value;
  }
  return null;
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.data?.data?.list)) return payload.data.data.list;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(ctx, mint) {
  if (!mint || !hasGmgnApiKey(ctx)) return null;
  try {
    const payload = await gmgnFetch(ctx, "/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

export async function getGmgnTokenIntel(ctx, mint) {
  if (!mint || !hasGmgnApiKey(ctx)) {
    return {
      available: false,
      reason: "GMGN key missing or mint missing",
    };
  }

  try {
    const payload = await gmgnFetch(ctx, "/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") {
      return {
        available: false,
        reason: "GMGN token info unavailable",
      };
    }

    return {
      available: true,
      holderCount: pickNumber(info, ["holder_count", "holders", "holderCount"]),
      top10ConcentrationPct: pickNumber(info, ["top10_holder_pct", "top10_holders_pct", "top10Concentration", "top10_pct"]),
      top50ConcentrationPct: pickNumber(info, ["top50_holder_pct", "top50_holders_pct", "top50Concentration", "top50_pct"]),
      devHoldingsPct: pickNumber(info, ["dev_holdings_pct", "dev_holding_pct", "devHoldingsPct", "dev_pct"]),
      source: "gmgn:/v1/token/info",
    };
  } catch (error) {
    log("gmgn", `token intel lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return {
      available: false,
      reason: error.message,
    };
  }
}

export async function getGmgnSmartMoneyFlow(ctx, mint, { timeWindowMinutes = 5 } = {}) {
  if (!mint || !hasGmgnApiKey(ctx)) {
    return {
      available: false,
      reason: "GMGN key missing or mint missing",
    };
  }

  const windowMin = Math.max(1, Number(timeWindowMinutes) || 5);
  const fromMs = Date.now() - (windowMin * 60 * 1000);
  const mintNormalized = normalizeAddress(mint);

  // Primary source: GMGN smart money trade feed.
  // Endpoint reference: /v1/user/smartmoney (GMGN OpenAPI client in gmgn-skills).
  try {
    const payload = await gmgnFetch(ctx, "/v1/user/smartmoney", {
      params: { chain: "sol", limit: 200 },
    });
    const rows = pickArray(payload);
    let netBuyUsd = 0;
    let netSellUsd = 0;
    let matchedTrades = 0;

    for (const row of rows) {
      const tokenAddress = normalizeAddress(
        row?.base_address || row?.token_address || row?.address || row?.mint
      );
      if (!tokenAddress || tokenAddress !== mintNormalized) continue;

      const rawTs = pickNumber(row, ["timestamp", "time", "ts", "created_at"]);
      // GMGN feeds may return seconds or milliseconds.
      const tsMs = rawTs != null && rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs;
      if (!Number.isFinite(tsMs) || tsMs < fromMs) continue;

      const amountUsd = pickNumber(row, ["amount_usd", "usd_value", "volume_usd", "amountUsd"]);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) continue;

      const side = String(row?.side || row?.direction || "").toLowerCase();
      if (side === "buy") {
        netBuyUsd += amountUsd;
        matchedTrades += 1;
      } else if (side === "sell") {
        netSellUsd += amountUsd;
        matchedTrades += 1;
      }
    }

    if (matchedTrades > 0) {
      return {
        available: true,
        source: "gmgn:/v1/user/smartmoney",
        timeWindowMinutes: windowMin,
        matchedTrades,
        netBuyUsd: Number(netBuyUsd.toFixed(2)),
        netSellUsd: Number(netSellUsd.toFixed(2)),
      };
    }

    log("gmgn", `smart money feed returned no recent trades for ${mintNormalized.slice(0, 8)} (window=${windowMin}m)`);
  } catch (error) {
    log("gmgn", `smart money feed failed for ${mintNormalized.slice(0, 8)}: ${error.message}`);
  }

  // Fallback source: smart_degen trader aggregates for this token.
  // Endpoint reference: /v1/market/token_top_traders.
  try {
    const payload = await gmgnFetch(ctx, "/v1/market/token_top_traders", {
      params: {
        chain: "sol",
        address: mint,
        tag: "smart_degen",
        order_by: "buy_volume_cur",
        direction: "desc",
        limit: 100,
      },
    });
    const rows = pickArray(payload);
    let netBuyUsd = 0;
    let netSellUsd = 0;
    let matchedTraders = 0;

    for (const row of rows) {
      const buy = pickNumber(row, ["buy_volume_cur", "buy_volume", "buyVolume", "buy_usd"]);
      const sell = pickNumber(row, ["sell_volume_cur", "sell_volume", "sellVolume", "sell_usd"]);
      if (!Number.isFinite(buy) && !Number.isFinite(sell)) continue;
      if (Number.isFinite(buy) && buy > 0) netBuyUsd += buy;
      if (Number.isFinite(sell) && sell > 0) netSellUsd += sell;
      matchedTraders += 1;
    }

    if (matchedTraders > 0) {
      return {
        available: true,
        source: "gmgn:/v1/market/token_top_traders?tag=smart_degen",
        timeWindowMinutes: windowMin,
        matchedTraders,
        netBuyUsd: Number(netBuyUsd.toFixed(2)),
        netSellUsd: Number(netSellUsd.toFixed(2)),
        note: "fallback aggregate from smart_degen top traders",
      };
    }
  } catch (error) {
    log("gmgn", `smart money fallback failed for ${mintNormalized.slice(0, 8)}: ${error.message}`);
  }

  return {
    available: false,
    reason: `smart money flow unavailable for ${mintNormalized.slice(0, 8)} (window=${windowMin}m)`,
    netBuyUsd: null,
    netSellUsd: null,
  };
}

// ─── Smart money wallet addresses for a token ───────────────────
// Same smart_degen top-traders feed as the getGmgnSmartMoneyFlow fallback, but
// returns individual wallet addresses instead of aggregated volume — used to
// auto-fill the "smart wallets on pool" signal from GMGN (no manual tracking needed).
export async function getGmgnSmartMoneyWallets(ctx, mint, { limit = 20 } = {}) {
  if (!mint || !hasGmgnApiKey(ctx)) {
    return { available: false, reason: "GMGN key missing or mint missing", wallets: [] };
  }

  const mintNormalized = normalizeAddress(mint);

  try {
    const payload = await gmgnFetch(ctx, "/v1/market/token_top_traders", {
      params: {
        chain: "sol",
        address: mint,
        tag: "smart_degen",
        order_by: "buy_volume_cur",
        direction: "desc",
        limit,
      },
    });
    const rows = pickArray(payload);
    const wallets = [];

    for (const row of rows) {
      const address = normalizeAddress(
        row?.wallet_address || row?.address || row?.wallet || row?.maker_address || row?.trader_address
      );
      if (!address) continue;
      wallets.push({
        address,
        netBuyUsd: pickNumber(row, ["buy_volume_cur", "buy_volume", "buyVolume", "buy_usd"]) ?? 0,
        netSellUsd: pickNumber(row, ["sell_volume_cur", "sell_volume", "sellVolume", "sell_usd"]) ?? 0,
      });
    }

    return {
      available: wallets.length > 0,
      source: "gmgn:/v1/market/token_top_traders?tag=smart_degen",
      wallets,
    };
  } catch (error) {
    log("gmgn", `smart money wallet list failed for ${mintNormalized.slice(0, 8)}: ${error.message}`);
    return { available: false, reason: error.message, wallets: [] };
  }
}
