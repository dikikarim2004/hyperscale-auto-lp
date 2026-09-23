function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ema(values, period) {
  const p = Math.max(1, Number(period) || 1);
  if (!Array.isArray(values) || values.length < p) return null;
  const k = 2 / (p + 1);
  let current = values[0];
  for (let i = 1; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

export function calculateMACD(closes, { fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = {}) {
  if (!Array.isArray(closes)) return null;
  const values = closes.map(toFiniteNumber).filter((n) => n != null);
  const slow = Math.max(2, Number(slowPeriod) || 26);
  const fast = Math.max(2, Number(fastPeriod) || 12);
  const signal = Math.max(2, Number(signalPeriod) || 9);
  if (values.length < slow + signal) return null;

  const macdSeries = [];
  for (let i = slow - 1; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const fastEma = ema(slice.slice(-Math.max(fast, 1) * 4), fast) ?? ema(slice, fast);
    const slowEma = ema(slice.slice(-Math.max(slow, 1) * 4), slow) ?? ema(slice, slow);
    if (fastEma == null || slowEma == null) continue;
    macdSeries.push(fastEma - slowEma);
  }
  if (macdSeries.length < signal) return null;

  const macd = macdSeries[macdSeries.length - 1];
  const signalValue = ema(macdSeries, signal);
  if (signalValue == null) return null;

  return {
    macd: Number(macd.toFixed(6)),
    signal: Number(signalValue.toFixed(6)),
    histogram: Number((macd - signalValue).toFixed(6)),
    previousHistogram: macdSeries.length > signal
      ? Number((macdSeries[macdSeries.length - 2] - (ema(macdSeries.slice(0, -1), signal) ?? signalValue)).toFixed(6))
      : null,
  };
}
