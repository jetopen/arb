import { describe, it, expect } from "vitest";
import { AlertEngine, formatAlertMessage } from "../alerts/engine";
import type { AlertEvent } from "../alerts/engine";
import type { NormalizedMessage } from "../types";

const makeMessage = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  orderId: "0xorder1",
  txHash: "0xtxhash1",
  dstTxHash: null,
  fromChainId: 1,
  toChainId: 56,
  fromTokenAddress: "0xusdc",
  toTokenAddress: "0xusdt",
  fromAmount: "1000000",
  toAmount: "999000000000000000000",
  fromTokenSymbol: "USDC",
  toTokenSymbol: "USDT",
  fromTokenDecimals: 6,
  toTokenDecimals: 18,
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

describe("AlertEngine", () => {
  it("does not fire on first check (initial baseline)", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    engine.register((_e: AlertEvent) => { fired.push("1"); });
    engine.checkForNewMessages([makeMessage()]);
    expect(fired).toHaveLength(0);
  });

  it("fires when a newer message arrives", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.checkForNewMessages([
      makeMessage({ orderId: "0xnew1", timestamp: 200 }),
      makeMessage({ timestamp: 100 }),
    ]);

    expect(fired).toEqual(["0xnew1"]);
  });

  it("does not fire for old messages", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 200 })]);
    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);

    expect(fired).toHaveLength(0);
  });

  it("fires multiple handlers", () => {
    const engine = new AlertEngine();
    const handler1: string[] = [];
    const handler2: string[] = [];
    engine.register((e: AlertEvent) => { handler1.push(e.message.orderId); });
    engine.register((e: AlertEvent) => { handler2.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.checkForNewMessages([
      makeMessage({ orderId: "0xfired", timestamp: 200 }),
    ]);

    expect(handler1).toEqual(["0xfired"]);
    expect(handler2).toEqual(["0xfired"]);
  });

  it("does not fire when disabled", () => {
    const engine = new AlertEngine();
    engine.setEnabled(false);
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.checkForNewMessages([
      makeMessage({ orderId: "0xshouldnot", timestamp: 200 }),
    ]);

    expect(fired).toHaveLength(0);
  });

  it("handles empty messages array", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.checkForNewMessages([]);

    expect(fired).toHaveLength(0);
  });

  it("unregister stops handler from being called", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    const handler = (e: AlertEvent) => { fired.push(e.message.orderId); };

    engine.register(handler);
    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.unregister(handler);
    engine.checkForNewMessages([
      makeMessage({ orderId: "0xafter", timestamp: 200 }),
    ]);

    expect(fired).toHaveLength(0);
  });

  it("reset clears baseline timestamp", () => {
    const engine = new AlertEngine();
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    engine.reset();
    engine.checkForNewMessages([makeMessage({ timestamp: 200 })]);
    expect(fired).toHaveLength(0);
  });

  it("handler errors do not crash engine", () => {
    const engine = new AlertEngine();
    engine.register(() => {
      throw new Error("boom");
    });
    const fired: string[] = [];
    engine.register((e: AlertEvent) => { fired.push(e.message.orderId); });

    engine.checkForNewMessages([makeMessage({ timestamp: 100 })]);
    expect(() => {
      engine.checkForNewMessages([
        makeMessage({ orderId: "0xsurvives", timestamp: 200 }),
      ]);
    }).not.toThrow();
    expect(fired).toEqual(["0xsurvives"]);
  });
});

describe("formatAlertMessage", () => {
  it("formats message with chain names and token symbols", () => {
    const msg = makeMessage();
    const result = formatAlertMessage(msg);
    expect(result).toContain("Ethereum");
    expect(result).toContain("BNB Chain");
    expect(result).toContain("USDC");
    expect(result).toContain("USDT");
    expect(result).toContain("Executed");
  });
});
