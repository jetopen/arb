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
 *  - 5xx and 429 → transient (upstream overload / hiccup).
 *  - any non-HTTP throw (network, timeout, abort, JSON parse) → transient (no status to prove it permanent).
 *  - a 4xx (bad pair / bad params / TOKEN_PAIR_NOT_TRADABLE / INVALID_QUERY_PARAMETERS) → permanent.
 */
export function isTransientQuoteError(e: unknown): boolean {
  if (e instanceof QuoteHttpError) return e.status >= 500 || e.status === 429;
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) return false;
  return true;
}
