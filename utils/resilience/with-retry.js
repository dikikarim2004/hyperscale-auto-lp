function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStatus(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.code);
  return Number.isFinite(status) ? status : null;
}

export function isRetryableError(error) {
  const status = parseStatus(error);
  if (status != null) {
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500) return true;
  }
  const code = String(error?.code || "").toUpperCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND"].includes(code)) {
    return true;
  }
  const message = String(error?.message || "").toLowerCase();
  if (/timeout|timed out|temporarily unavailable|rate limit|too many requests/.test(message)) {
    return true;
  }
  return false;
}

export async function withRetry(fn, {
  maxRetries = 3,
  initialDelayMs = 1000,
  maxDelayMs = 10000,
  shouldRetry = isRetryableError,
  onRetry = null,
} = {}) {
  const retries = Math.max(0, Number(maxRetries) || 0);
  const startDelay = Math.max(0, Number(initialDelayMs) || 0);
  const capDelay = Math.max(startDelay, Number(maxDelayMs) || startDelay);

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }
      const delayMs = Math.min(capDelay, startDelay * 2 ** attempt);
      if (typeof onRetry === "function") {
        try { onRetry({ attempt: attempt + 1, delayMs, error }); } catch { /* ignore */ }
      }
      if (delayMs > 0) await sleep(delayMs);
      attempt += 1;
    }
  }
}
