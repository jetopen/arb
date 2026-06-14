import { describe, it, expect } from "vitest";
import { normalizeOrder } from "../api-client";

const sampleRawOrder = {
  orderId: { stringValue: "0xabc123" },
  creationTimestamp: 1700000000,
  state: "Fulfilled",
  externalCallState: "Completed",
  createEventTransactionHash: { stringValue: "0xtxhash" },
  fulfilledDstEventMetadata: {
    transactionHash: { stringValue: "0xdsttx" },
  },
  giveOfferWithMetadata: {
    chainId: { bigIntegerValue: 1 },
    tokenAddress: { stringValue: "0xusdc" },
    amount: { bigIntegerValue: 1000000 },
    metadata: {
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoURI: "https://example.com/usdc.png",
    },
  },
  takeOfferWithMetadata: {
    chainId: { bigIntegerValue: 56 },
    tokenAddress: { stringValue: "0xusdt" },
    amount: { bigIntegerValue: 999000000000000000000n },
    metadata: {
      symbol: "USDT",
      name: "Tether USD",
      decimals: 18,
      logoURI: "https://example.com/usdt.png",
    },
  },
  finalPercentFee: { bigIntegerValue: 50000 },
  fixFee: { bigIntegerValue: 1000000000000000 },
  orderMetadata: { operatingExpensesAmount: "500000" },
};

describe("normalizeOrder", () => {
  it("extracts orderId", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.orderId).toBe("0xabc123");
  });

  it("extracts txHash", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.txHash).toBe("0xtxhash");
  });

  it("extracts dstTxHash", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.dstTxHash).toBe("0xdsttx");
  });

  it("extracts chain IDs", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.fromChainId).toBe(1);
    expect(result.toChainId).toBe(56);
  });

  it("extracts token symbols", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.fromTokenSymbol).toBe("USDC");
    expect(result.toTokenSymbol).toBe("USDT");
  });

  it("extracts amounts as strings", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.fromAmount).toBe("1000000");
  });

  it("maps status correctly", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.status).toBe("Executed");
  });

  it("extracts timestamp", () => {
    const result = normalizeOrder(sampleRawOrder);
    expect(result.timestamp).toBe(1700000000);
  });

  it("handles missing dstTxHash", () => {
    const raw = { ...sampleRawOrder, fulfilledDstEventMetadata: null };
    const result = normalizeOrder(raw);
    expect(result.dstTxHash).toBeNull();
  });

  it("handles empty object gracefully", () => {
    const result = normalizeOrder({});
    expect(result.orderId).toBe("");
    expect(result.fromChainId).toBe(0);
    expect(result.status).toBe("Executing");
  });
});
