/**
 * Error thrown by the quote fetchers (deBridge estimation, Jupiter) carrying the HTTP status, so the
 * scanner can tell a TRANSIENT upstream failure (5xx / 429 / network) from a PERMANENT no-route (4xx).
 * Without this distinction a single flaky 500 on a brand-new route (Flow/Sei estimation is visibly
 * intermittent) demotes a genuinely-live route for the full 6h dead-route penalty — suppressing real
 * opportunities. See store.markScanned: transient failures get a short backoff, not the 6h penalty.
 */
export class QuoteHttpError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `quote http ${status}`);
    this.name = "QuoteHttpError";
    this.status = status;
  }
}

/**
 * True when a quote failure is likely TRANSIENT (worth a short retry) rather than a permanent no-route.
 *
 * ALLOWLIST semantics: only a definitive HTTP answer proves a route is permanently dead. A 4xx (bad pair /
 * bad params / TOKEN_PAIR_NOT_TRADABLE / INVALID_QUERY_PARAMETERS) is the one permanent class; a 5xx / 429 is
 * upstream overload; EVERYTHING ELSE is transient.
 *
 * Why default-transient (this is a fix, not a style choice): Node 22's fetch (undici) rejects with a plain
 * `TypeError('fetch failed')` on any DNS / connection / reset failure, and `res.json()` throws `SyntaxError`
 * on a truncated body — both are transient network hiccups. The old code special-cased TypeError/SyntaxError
 * as PERMANENT, so a passing network blip on a genuinely-live route (Flow/Sei estimation is intermittently
 * flaky) took the full 6h dead-route penalty instead of the 10m transient retry — silently suppressing real
 * opportunities. Default-transient is safe: a truly dead route re-fails next scan and its 4xx demotes it then;
 * a merely-flaky one recovers on the short retry. A code-level throw (a real bug in our parser) would fail
 * uniformly across every route and surface loudly via the loop's error/telemetry alerting, not hide here.
 */
export function isTransientQuoteError(e: unknown): boolean {
  if (e instanceof QuoteHttpError) return e.status >= 500 || e.status === 429;
  return true;
}
