import { getCircuitBreaker } from "../utils/resilience/circuit-breaker.js";
import { withRetry, isRetryableError } from "../utils/resilience/with-retry.js";

export function getAgentMeridianBase(ctx) {
  return String(ctx.secrets?.agentMeridianApiUrl || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

export function getAgentMeridianHeaders(ctx, { json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (ctx.secrets?.publicApiKey) headers["x-api-key"] = ctx.secrets.publicApiKey;
  return headers;
}

export function getAgentIdForRequests(ctx) {
  return ctx.config?.hiveMind?.agentId || "agent-local";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isCircuitFailure(error) {
  if (!error) return false;
  const status = Number(error?.status || 0);
  if (isRetryableStatus(status)) return true;
  return isRetryableError(error);
}

const agentMeridianBreaker = getCircuitBreaker("agent-meridian-api", {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxSuccesses: 1,
  isFailure: isCircuitFailure,
});

function retryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}

async function agentMeridianJsonOnce(ctx, pathname, options = {}, timeoutMs = null) {
  const res = await agentMeridianBreaker.execute(() =>
    withRetry(
      () => fetchWithTimeout(`${getAgentMeridianBase(ctx)}${pathname}`, options, timeoutMs),
      {
        maxRetries: 1,
        initialDelayMs: 500,
        maxDelayMs: 1500,
        shouldRetry: isRetryableError,
      },
    )
  );
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload?.error || `${pathname} ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return payload;
}

export async function agentMeridianJson(ctx, pathname, options = {}) {
  const { retry, ...fetchOptions } = options;
  if (!retry) {
    return agentMeridianJsonOnce(ctx, pathname, fetchOptions);
  }

  const maxElapsedMs = Number(retry.maxElapsedMs || 30_000);
  const maxAttempts = Number(retry.maxAttempts || 10);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - startedAt < maxElapsedMs && attempt < maxAttempts) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, maxElapsedMs - elapsedMs);
    try {
      return await agentMeridianJsonOnce(
        ctx,
        pathname,
        fetchOptions,
        Math.min(Number(retry.perAttemptTimeoutMs || 10_000), remainingMs),
      );
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      if (!isRetryableStatus(status) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const waitMs = Math.min(retryDelayMs(error, attempt), Math.max(0, remainingMs - 1));
      if (waitMs <= 0) break;
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError || new Error(`${pathname} retry budget exhausted`);
}
