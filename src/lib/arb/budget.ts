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

  /**
   * Return up to n unspent tokens to the bucket — e.g. a scan unit reserves 2 quotes up front but spends 0
   * (guard bail) or 1 (first-leg failure), so the remainder must be refunded or the sustained rate collapses
   * to a fraction of the cap. Never exceeds capacity; a non-positive n is a no-op.
   */
  release(n: number, now: number = Date.now()): void {
    if (n <= 0) return;
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens + n);
  }

  available(now: number = Date.now()): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }
}
