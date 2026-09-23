function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBar(bar) {
  if (!bar || typeof bar !== "object") return null;
  const low = toFiniteNumber(bar.low);
  const high = toFiniteNumber(bar.high);
  const close = toFiniteNumber(bar.close);
  if (low == null || high == null || close == null) return null;
  return { low, high, close };
}

export function findSupportResistance(ohlcv, window = 20) {
  const bars = Array.isArray(ohlcv) ? ohlcv.map(normalizeBar).filter(Boolean) : [];
  const size = Math.max(5, Number(window) || 20);
  if (bars.length < size) return { support: null, resistance: null };

  const recent = bars.slice(-size);
  const currentPrice = recent[recent.length - 1].close;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { support: null, resistance: null };

  let support = null;
  let resistance = null;

  for (const bar of recent) {
    if (bar.low <= currentPrice) {
      if (support == null || Math.abs(currentPrice - bar.low) < Math.abs(currentPrice - support)) {
        support = bar.low;
      }
    }
    if (bar.high >= currentPrice) {
      if (resistance == null || Math.abs(bar.high - currentPrice) < Math.abs(resistance - currentPrice)) {
        resistance = bar.high;
      }
    }
  }

  return {
    support: support != null ? Number(support.toFixed(8)) : null,
    resistance: resistance != null ? Number(resistance.toFixed(8)) : null,
  };
}
