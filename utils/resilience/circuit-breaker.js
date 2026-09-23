export class CircuitBreaker {
  constructor({
    name = "default",
    failureThreshold = 3,
    resetTimeoutMs = 30000,
    halfOpenMaxSuccesses = 1,
    isFailure = null,
  } = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3);
    this.resetTimeoutMs = Math.max(1000, Number(resetTimeoutMs) || 30000);
    this.halfOpenMaxSuccesses = Math.max(1, Number(halfOpenMaxSuccesses) || 1);
    this.isFailure = typeof isFailure === "function" ? isFailure : (() => true);

    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.nextAttemptAt = 0;
  }

  canAttempt(now = Date.now()) {
    if (this.state !== "OPEN") return true;
    return now >= this.nextAttemptAt;
  }

  moveToHalfOpen(now = Date.now()) {
    this.state = "HALF_OPEN";
    this.halfOpenSuccesses = 0;
    this.nextAttemptAt = now + this.resetTimeoutMs;
  }

  moveToOpen(now = Date.now()) {
    this.state = "OPEN";
    this.nextAttemptAt = now + this.resetTimeoutMs;
    this.halfOpenSuccesses = 0;
  }

  moveToClosed() {
    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.nextAttemptAt = 0;
  }

  async execute(fn) {
    const now = Date.now();
    if (this.state === "OPEN") {
      if (!this.canAttempt(now)) {
        const waitMs = Math.max(0, this.nextAttemptAt - now);
        const error = new Error(`Circuit ${this.name} is OPEN`);
        error.code = "CIRCUIT_OPEN";
        error.circuit = this.name;
        error.retryInMs = waitMs;
        throw error;
      }
      this.moveToHalfOpen(now);
    }

    try {
      const result = await fn();
      if (this.state === "HALF_OPEN") {
        this.halfOpenSuccesses += 1;
        if (this.halfOpenSuccesses >= this.halfOpenMaxSuccesses) {
          this.moveToClosed();
        }
      } else {
        this.failures = 0;
      }
      return result;
    } catch (error) {
      const shouldCountFailure = this.isFailure(error);
      if (!shouldCountFailure) {
        throw error;
      }

      if (this.state === "HALF_OPEN") {
        this.moveToOpen();
        throw error;
      }

      this.failures += 1;
      if (this.failures >= this.failureThreshold) {
        this.moveToOpen();
      }
      throw error;
    }
  }
}

const breakerRegistry = new Map();

export function getCircuitBreaker(name, options = {}) {
  if (!name) throw new Error("Circuit breaker name is required");
  if (!breakerRegistry.has(name)) {
    breakerRegistry.set(name, new CircuitBreaker({ name, ...options }));
  }
  return breakerRegistry.get(name);
}
