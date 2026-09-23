function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBar(item) {
  if (!item || typeof item !== "object") return null;
  const high = toFiniteNumber(item.high);
  const low = toFiniteNumber(item.low);
  const close = toFiniteNumber(item.close);
  if (high == null || low == null || close == null) return null;
  return { high, low, close };
}

export function calculateATR(ohlcv, period = 14) {
  const p = Math.max(2, Number(period) || 14);
  const bars = Array.isArray(ohlcv) ? ohlcv.map(normalizeBar).filter(Boolean) : [];
  if (bars.length < p + 1) return null;

  const recent = bars.slice(-(p + 1));
  const trueRanges = [];
  for (let i = 1; i < recent.length; i++) {
    const cur = recent[i];
    const prev = recent[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trueRanges.push(tr);
  }
  if (trueRanges.length < p) return null;
  const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
  return Number(atr.toFixed(8));
}
