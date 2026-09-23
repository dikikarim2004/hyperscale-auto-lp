import { log } from "../../logger.js";
import { calculateATR } from "../indicators/atr.js";
import { fetchOhlcvCandlesForMint } from "../ohlcv.js";

function clampDynamicStopLossPct(value, minStopLossPct, maxStopLossPct) {
  const lower = Math.min(Number(minStopLossPct), Number(maxStopLossPct));
  const upper = Math.max(Number(minStopLossPct), Number(maxStopLossPct));
  return Math.max(lower, Math.min(upper, value));
}

export function calculateDynamicStopLossPct({ currentPrice, atr, multiplier = 1.5, minStopLossPct = -5, maxStopLossPct = -30 } = {}) {
  const price = Number(currentPrice);
  const atrValue = Number(atr);
  const atrMul = Number(multiplier);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(atrValue) || atrValue <= 0 || !Number.isFinite(atrMul) || atrMul <= 0) {
    return null;
  }
  const rawPct = -((atrValue * atrMul) / price) * 100;
  return Number(clampDynamicStopLossPct(rawPct, minStopLossPct, maxStopLossPct).toFixed(4));
}

export async function evaluateDynamicStopLoss(ctx, { mint, currentPnlPct } = {}) {
  const rm = ctx.config.riskManagement || {};
  if (!mint || currentPnlPct == null) {
    return {
      enabled: true,
      should_close: false,
      dynamic_stop_loss_pct: null,
      reason: "mint/currentPnlPct missing",
    };
  }

  try {
    const ohlcv = await fetchOhlcvCandlesForMint(ctx, {
      mint,
      interval: rm.atrInterval || "15_MINUTE",
      candles: rm.atrCandles || 120,
    });

    if (!ohlcv.candles.length) {
      return {
        enabled: true,
        should_close: false,
        dynamic_stop_loss_pct: null,
        unavailable: true,
        reason: ohlcv.unavailableReason || "OHLCV unavailable",
      };
    }

    const atr = calculateATR(ohlcv.candles, rm.atrPeriod || 14);
    const currentPrice = Number(ohlcv.candles[ohlcv.candles.length - 1]?.close);
    const dynamicStopLossPct = calculateDynamicStopLossPct({
      currentPrice,
      atr,
      multiplier: rm.stopLossATRMultiplier ?? 1.5,
      minStopLossPct: rm.minStopLossPct ?? -5,
      maxStopLossPct: rm.maxStopLossPct ?? -30,
    });

    if (dynamicStopLossPct == null) {
      return {
        enabled: true,
        should_close: false,
        dynamic_stop_loss_pct: null,
        unavailable: true,
        reason: "ATR unavailable",
      };
    }

    const pnl = Number(currentPnlPct);
    const shouldClose = Number.isFinite(pnl) && pnl <= dynamicStopLossPct;
    return {
      enabled: true,
      should_close: shouldClose,
      dynamic_stop_loss_pct: dynamicStopLossPct,
      current_pnl_pct: Number.isFinite(pnl) ? Number(pnl.toFixed(4)) : null,
      atr,
      current_price: Number.isFinite(currentPrice) ? Number(currentPrice.toFixed(8)) : null,
      reason: shouldClose
        ? `Dynamic ATR stop-loss hit: pnl ${pnl.toFixed(2)}% <= ${dynamicStopLossPct.toFixed(2)}%`
        : `Dynamic ATR stop-loss safe: pnl ${pnl.toFixed(2)}% > ${dynamicStopLossPct.toFixed(2)}%`,
      source: {
        interval: ohlcv.interval,
        candles: ohlcv.candles.length,
      },
    };
  } catch (error) {
    log("risk", `Dynamic stop-loss evaluation failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return {
      enabled: true,
      should_close: false,
      dynamic_stop_loss_pct: null,
      unavailable: true,
      reason: `Dynamic stop-loss unavailable: ${error.message}`,
    };
  }
}
