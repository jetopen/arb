import { describe, it, expect } from "vitest";
import { exportToCSV, exportToJSON } from "../export";
import type { NormalizedMessage } from "../types";

const makeMessage = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  orderId: "0xorder1",
  txHash: "0xtxhash123456789",
  dstTxHash: null,
  fromChainId: 1,
  toChainId: 56,
  fromTokenAddress: "0xusdc",
  toTokenAddress: "0xusdt",
  fromAmount: "1000000",
  toAmount: "999000",
  fromTokenSymbol: "USDC",
  toTokenSymbol: "USDT",
  fromTokenDecimals: 6,
  toTokenDecimals: 6,
  fromTokenName: "USD Coin",
  toTokenName: "Tether USD",
  fromTokenLogo: "",
  toTokenLogo: "",
  fee: "50000",
  fixFee: "1000",
  operatingExpenses: "200",
  status: "Executed",
  timestamp: 1700000000,
  state: "Fulfilled",
  externalCallState: "Completed",
  ...overrides,
});

describe("exportToCSV", () => {
  it("generates CSV with correct headers", () => {
    const csv = exportToCSV([]);
    const firstLine = csv.split("\n")[0];
    expect(firstLine).toContain("Order ID");
    expect(firstLine).toContain("Tx Hash");
    expect(firstLine).toContain("From Chain");
    expect(firstLine).toContain("To Chain");
    expect(firstLine).toContain("Status");
  });

  it("generates data rows for messages", () => {
    const csv = exportToCSV([makeMessage()]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[1]).toContain("0xorder1");
    expect(lines[1]).toContain("Ethereum");
    expect(lines[1]).toContain("BNB Chain");
    expect(lines[1]).toContain("Executed");
  });

  it("escapes fields with commas", () => {
    const csv = exportToCSV([makeMessage({ fromTokenSymbol: "USD, Coin" })]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toContain('"USD, Coin"');
  });

  it("handles multiple messages", () => {
    const csv = exportToCSV([
      makeMessage({ orderId: "0x1" }),
      makeMessage({ orderId: "0x2" }),
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
  });
});

describe("exportToJSON", () => {
  it("generates valid JSON array", () => {
    const json = exportToJSON([makeMessage()]);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("preserves all message fields", () => {
    const msg = makeMessage();
    const json = exportToJSON([msg]);
    const parsed = JSON.parse(json);
    expect(parsed[0].orderId).toBe(msg.orderId);
    expect(parsed[0].txHash).toBe(msg.txHash);
    expect(parsed[0].fromChainId).toBe(msg.fromChainId);
    expect(parsed[0].status).toBe(msg.status);
  });

  it("handles empty array", () => {
    const json = exportToJSON([]);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(0);
  });
});
