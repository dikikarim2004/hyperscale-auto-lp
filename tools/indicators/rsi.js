function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function calculateRSI(closes, period = 14) {
  const size = Math.max(2, Number(period) || 14);
  if (!Array.isArray(closes) || closes.length < size + 1) return null;

  const values = closes.map(toFiniteNumber).filter((n) => n != null);
  if (values.length < size + 1) return null;

  const recent = values.slice(-(size + 1));
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i] - recent[i - 1];
    if (change > 0) gain += change;
    else loss += Math.abs(change);
  }

  const avgGain = gain / size;
  const avgLoss = loss / size;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number(rsi.toFixed(4));
}
