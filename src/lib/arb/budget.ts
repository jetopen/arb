/**
 * Token-bucket RPM limiter for the rate-limited resource (deBridge chain/estimation calls).
 * Latency-bound in practice (live-probed: 0×429 at 50 concurrent), but this caps sustained rate
 * defensively and lets a scan batch stop early + resume on the next tick.
 */
export class RpmBudget {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private last: number;

  constructor(rpm: number, now: number = Date.now()) {
    this.capacity = rpm;
    this.refillPerMs = rpm / 60_000;
    this.tokens = rpm;
    this.last = now;
  }

  private refill(now: number) {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
      this.last = now;
    }
  }

  /** Try to spend n tokens; returns false (spending nothing) if insufficient. */
  tryAcquire(n = 1, now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  available(now: number = Date.now()): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }
}
