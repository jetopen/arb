import { describe, it, expect, afterEach, vi } from "vitest";
import { buildDebridgeSwapTx } from "../sim/build/build-debridge";
import { buildJupiterSwapTx } from "../sim/build/build-jupiter";

afterEach(() => vi.unstubAllGlobals());

describe("buildDebridgeSwapTx", () => {
  it("requests /v1.0/chain/transaction with sender+recipient+slippage and parses tx.{to,data,value}", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ tx: { to: "0xRouter", data: "0xdead", value: "0x0" }, estimation: { tokenOut: { amount: "777" } } }),
        } as Response;
      })
    );
    const built = await buildDebridgeSwapTx({
      internalChainId: 42161,
      tokenIn: "0xUSDC",
      tokenOut: "0xTKN",
      amountIn: "1000000",
      sender: "0xSender",
      slippageBps: 100,
    });
    expect(built).toEqual({ to: "0xRouter", data: "0xdead", value: "0x0", amountOut: "777" });
    expect(calls[0]).toContain("/v1.0/chain/transaction");
    expect(calls[0]).toContain("chainId=42161");
    expect(calls[0]).toContain("senderAddress=0xSender");
    expect(calls[0]).toContain("tokenOutRecipient=0xSender");
    expect(calls[0]).toContain("slippage=1"); // 100 bps → "1" (percent)
  });

  it("uses slippage=auto when no slippage is given", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ tx: { to: "0xR", data: "0x1" } }) } as Response;
      })
    );
    await buildDebridgeSwapTx({ internalChainId: 1, tokenIn: "0xa", tokenOut: "0xb", amountIn: "1", sender: "0xs" });
    expect(calls[0]).toContain("slippage=auto");
  });

  it("throws a QuoteHttpError on a non-2xx response (caller treats 4xx as 'no build' → skipped)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }) as Response));
    await expect(
      buildDebridgeSwapTx({ internalChainId: 1, tokenIn: "0xa", tokenOut: "0xb", amountIn: "1", sender: "0xs" })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("buildJupiterSwapTx", () => {
  it("GETs /quote then POSTs /swap with the quoteResponse + userPublicKey, returning swapTransaction", async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, method: init?.method, body: init?.body as string | undefined });
        if (url.includes("/quote")) return { ok: true, status: 200, json: async () => ({ outAmount: "5", routePlan: [] }) } as Response;
        return { ok: true, status: 200, json: async () => ({ swapTransaction: "BASE64TX" }) } as Response;
      })
    );
    const tx = await buildJupiterSwapTx({ tokenIn: "MINTA", tokenOut: "MINTB", amountIn: "1000000", userPublicKey: "HOLDER" });
    expect(tx).toBe("BASE64TX");
    expect(seen[0].url).toContain("/quote");
    expect(seen[1].url).toContain("/swap");
    expect(seen[1].method).toBe("POST");
    expect(seen[1].body).toContain("HOLDER"); // userPublicKey threaded into the swap request
  });

  it("throws when /swap omits swapTransaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/quote")) return { ok: true, status: 200, json: async () => ({ outAmount: "5" }) } as Response;
        return { ok: true, status: 200, json: async () => ({}) } as Response; // no swapTransaction
      })
    );
    await expect(buildJupiterSwapTx({ tokenIn: "A", tokenOut: "B", amountIn: "1", userPublicKey: "H" })).rejects.toThrow();
  });
});
