import { describe, it, expect } from "vitest";
import { QuoteHttpError, isTransientQuoteError } from "../quotes/quote-error";

describe("isTransientQuoteError", () => {
  it("classifies 5xx and 429 HTTP errors as transient (upstream overload)", () => {
    expect(isTransientQuoteError(new QuoteHttpError(500))).toBe(true);
    expect(isTransientQuoteError(new QuoteHttpError(503))).toBe(true);
    expect(isTransientQuoteError(new QuoteHttpError(429))).toBe(true);
  });

  it("classifies 4xx HTTP errors as permanent (real no-route)", () => {
    expect(isTransientQuoteError(new QuoteHttpError(400))).toBe(false);
    expect(isTransientQuoteError(new QuoteHttpError(404))).toBe(false);
    expect(isTransientQuoteError(new QuoteHttpError(422))).toBe(false);
  });

  // Regression: undici's fetch rejects with a bare TypeError('fetch failed') on any network/DNS/reset
  // failure. This MUST be transient — the old code treated it as permanent and 6h-demoted live routes.
  it("classifies a network TypeError('fetch failed') as transient", () => {
    expect(isTransientQuoteError(new TypeError("fetch failed"))).toBe(true);
  });

  it("classifies a JSON-parse SyntaxError (truncated body) as transient", () => {
    expect(isTransientQuoteError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
  });

  it("classifies a generic Error / timeout / abort as transient (no status to prove permanence)", () => {
    expect(isTransientQuoteError(new Error("timeout"))).toBe(true);
    expect(isTransientQuoteError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTransientQuoteError("some string throw")).toBe(true);
  });
});
