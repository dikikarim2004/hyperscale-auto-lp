import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { calculateRSI } from "./indicators/rsi.js";
import { calculateMACD } from "./indicators/macd.js";
import { findSupportResistance } from "./indicators/support-resistance.js";

const DEFAULT_INTERVAL = "5_MINUTE";
const DEFAULT_CANDLES = 120;
const NEAR_LEVEL_PCT = 0.02;

function normalizeInterval(interval) {
  const raw = String(interval || "").trim().toUpperCase();
  if (raw === "15_MINUTE") return raw;
  return DEFAULT_INTERVAL;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBar(item) {
  if (!item || typeof item !== "object") return null;
  const open = toFiniteNumber(item.open);
  const high = toFiniteNumber(item.high);
  const low = toFiniteNumber(item.low);
  const close = toFiniteNumber(item.close);
  const volume = toFiniteNumber(item.volume ?? item.baseVolume ?? item.quoteVolume);
  const timestamp = Number(item.ts ?? item.time ?? item.timestamp ?? 0) || null;
  if (open == null || high == null || low == null || close == null) return null;
  return { timestamp, open, high, low, close, volume };
}

function extractCandles(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.candles,
    payload.data?.candles,
    payload.series?.candles,
    payload.result?.candles,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const bars = candidate.map(normalizeBar).filter(Boolean);
    if (bars.length > 0) return bars;
  }
  return [];
}

async function fetchChartCandles(ctx, mint, { interval = DEFAULT_INTERVAL, candles = DEFAULT_CANDLES } = {}) {
  const normalizedInterval = normalizeInterval(interval);
  const count = Math.max(40, Number(candles) || DEFAULT_CANDLES);
  const qs = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(count),
  });
  const payload = await agentMeridianJson(ctx, `/chart-indicators/${mint}?${qs.toString()}`, {
    headers: getAgentMeridianHeaders(ctx),
  });

  const bars = extractCandles(payload);
  if (bars.length === 0) {
    return {
      mint,
      interval: normalizedInterval,
      candles: [],
      unavailableReason: "TODO: endpoint chart-indicators belum mengembalikan array candle OHLCV penuh",
    };
  }

  return {
    mint,
    interval: normalizedInterval,
    candles: bars,
    unavailableReason: null,
  };
}

export async function fetchOhlcvCandlesForMint(ctx, { mint, interval = DEFAULT_INTERVAL, candles = DEFAULT_CANDLES } = {}) {
  if (!mint) {
    return {
      mint: null,
      interval: normalizeInterval(interval),
      candles: [],
      unavailableReason: "mint is required",
    };
  }
  return fetchChartCandles(ctx, mint, { interval, candles });
}

function buildEntryAnalysis(candles, taConfig) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume).filter((v) => Number.isFinite(v));
  const latest = candles[candles.length - 1] || null;
  const previous = candles[candles.length - 2] || null;

  const rsi = calculateRSI(closes, taConfig.rsi.period);
  const macd = calculateMACD(closes, {
    fastPeriod: taConfig.macd.fastPeriod,
    slowPeriod: taConfig.macd.slowPeriod,
    signalPeriod: taConfig.macd.signalPeriod,
  });
  const levels = taConfig.supportResistance.enabled
    ? findSupportResistance(candles, taConfig.supportResistance.windowPeriods)
    : { support: null, resistance: null };

  const close = latest?.close ?? null;
  const nearSupport = close != null && levels.support != null
    ? Math.abs(close - levels.support) / Math.max(levels.support, 1e-9) <= NEAR_LEVEL_PCT
    : false;
  const macdBullishCross = macd?.histogram != null && macd?.previousHistogram != null
    ? macd.previousHistogram <= 0 && macd.histogram > 0
    : false;

  let volumeSpike = false;
  if (latest?.volume != null && volumes.length >= 6) {
    const baseline = volumes.slice(0, -1);
    const avg = baseline.reduce((s, v) => s + v, 0) / Math.max(baseline.length, 1);
    if (avg > 0) {
      volumeSpike = latest.volume >= avg * Number(taConfig.volume.spikeMultiplier || 2);
    }
  }

  let scoreBonus = 0;
  if (rsi != null && rsi < Number(taConfig.rsi.oversoldThreshold ?? 30)) scoreBonus += 10;
  if (nearSupport) scoreBonus += 10;
  if (macdBullishCross) scoreBonus += 5;
  if (volumeSpike) scoreBonus += 5;

  return {
    score_bonus: scoreBonus,
    signals: {
      rsi,
      close,
      support: levels.support,
      resistance: levels.resistance,
      near_support: nearSupport,
      macd,
      macd_bullish_cross: macdBullishCross,
      volume_spike: volumeSpike,
    },
    source: {
      candles: candles.length,
      timeframe: taConfig.interval,
    },
  };
}

function buildExitAnalysis(candles, taConfig) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume).filter((v) => Number.isFinite(v));
  const latest = candles[candles.length - 1] || null;
  const previous = candles[candles.length - 2] || null;
  const rsi = calculateRSI(closes, taConfig.rsi.period);
  const levels = taConfig.supportResistance.enabled
    ? findSupportResistance(candles, taConfig.supportResistance.windowPeriods)
    : { support: null, resistance: null };

  const close = latest?.close ?? null;
  const prevClose = previous?.close ?? null;
  const breakdownSupport = close != null && prevClose != null && levels.support != null
    ? prevClose >= levels.support && close < levels.support
    : false;

  let volumeDecline = false;
  if (latest?.volume != null && volumes.length >= 6) {
    const baseline = volumes.slice(0, -1);
    const avg = baseline.reduce((s, v) => s + v, 0) / Math.max(baseline.length, 1);
    if (avg > 0) {
      volumeDecline = latest.volume <= avg * Number(taConfig.volume.declineThreshold || 0.5);
    }
  }

  const reasons = [];
  if (rsi != null && rsi > Number(taConfig.rsi.overboughtThreshold ?? 70)) {
    reasons.push(`RSI ${rsi.toFixed(2)} > overbought ${taConfig.rsi.overboughtThreshold}`);
  }
  if (breakdownSupport) reasons.push("breakdown support");
  if (volumeDecline) reasons.push("volume decline / exhaustion");

  return {
    should_close: reasons.length > 0,
    reason: reasons.join("; "),
    signals: {
      rsi,
      close,
      support: levels.support,
      resistance: levels.resistance,
      breakdown_support: breakdownSupport,
      volume_decline: volumeDecline,
    },
    source: {
      candles: candles.length,
      timeframe: taConfig.interval,
    },
  };
}

function getTechnicalConfig(ctx) {
  const ta = ctx.config.technicalAnalysis || {};
  return {
    enabled: !!ta.enabled,
    interval: normalizeInterval(ta.interval),
    candles: Math.max(40, Number(ta.candles) || DEFAULT_CANDLES),
    rsi: {
      period: Math.max(2, Number(ta.rsi?.period) || 14),
      overboughtThreshold: Number(ta.rsi?.overboughtThreshold ?? 70),
      oversoldThreshold: Number(ta.rsi?.oversoldThreshold ?? 30),
    },
    macd: {
      fastPeriod: Math.max(2, Number(ta.macd?.fastPeriod) || 12),
      slowPeriod: Math.max(2, Number(ta.macd?.slowPeriod) || 26),
      signalPeriod: Math.max(2, Number(ta.macd?.signalPeriod) || 9),
    },
    volume: {
      spikeMultiplier: Number(ta.volume?.spikeMultiplier ?? 2.0),
      declineThreshold: Number(ta.volume?.declineThreshold ?? 0.5),
    },
    supportResistance: {
      enabled: ta.supportResistance?.enabled !== false,
      windowPeriods: Math.max(5, Number(ta.supportResistance?.windowPeriods) || 20),
    },
  };
}

export async function evaluateTechnicalEntrySignal(ctx, { mint } = {}) {
  const taConfig = getTechnicalConfig(ctx);
  if (!taConfig.enabled || !mint) {
    return { enabled: false, score_bonus: 0, reason: "technical analysis disabled or mint missing" };
  }

  try {
    const ohlcv = await fetchChartCandles(ctx, mint, {
      interval: taConfig.interval,
      candles: taConfig.candles,
    });
    if (!ohlcv.candles.length) {
      return {
        enabled: true,
        score_bonus: 0,
        unavailable: true,
        reason: ohlcv.unavailableReason,
      };
    }
    return {
      enabled: true,
      ...buildEntryAnalysis(ohlcv.candles, taConfig),
    };
  } catch (error) {
    log("ta", `TA entry evaluation failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return {
      enabled: true,
      score_bonus: 0,
      unavailable: true,
      reason: `TA unavailable: ${error.message}`,
    };
  }
}

export async function evaluateTechnicalExitSignal(ctx, { mint } = {}) {
  const taConfig = getTechnicalConfig(ctx);
  if (!taConfig.enabled || !mint) {
    return { enabled: false, should_close: false, reason: "technical analysis disabled or mint missing" };
  }

  try {
    const ohlcv = await fetchChartCandles(ctx, mint, {
      interval: taConfig.interval,
      candles: taConfig.candles,
    });
    if (!ohlcv.candles.length) {
      return {
        enabled: true,
        should_close: false,
        unavailable: true,
        reason: ohlcv.unavailableReason,
      };
    }
    return {
      enabled: true,
      ...buildExitAnalysis(ohlcv.candles, taConfig),
    };
  } catch (error) {
    log("ta", `TA exit evaluation failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return {
      enabled: true,
      should_close: false,
      unavailable: true,
      reason: `TA unavailable: ${error.message}`,
    };
  }
}
