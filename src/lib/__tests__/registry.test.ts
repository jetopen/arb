import { describe, it, expect, afterEach } from "vitest";
import {
  EVM_DEPORT_CHAINS,
  getChainByInternalId,
  getChainByEvmId,
  internalToEvmChainId,
  isEvmDeportChain,
  deBridgeGate,
  getRpcUrl,
  MULTICALL3_ADDRESS,
} from "../deport/registry";

const DEFAULT_GATE = "0x43dE2d77BF8027e25dBD179B491e8d64f38398aA";
const BASE_GATE = "0xc1656B63D9EEBa6d114f6bE19565177893e5bCBF";

describe("deport registry", () => {
  afterEach(() => {
    delete process.env.RPC_URL_42161;
    delete process.env.RPC_URL_1;
  });

  it("keys chains by internal id and exposes the real EVM chain id", () => {
    // Cronos: internal id != EVM id (the crux of the normalization bug we guard against)
    expect(getChainByInternalId(100000019)?.evmChainId).toBe(25);
    expect(getChainByInternalId(100000023)?.evmChainId).toBe(5000);
    expect(getChainByInternalId(100000022)?.evmChainId).toBe(999); // HyperEVM (not 998)
    // identity chains
    expect(getChainByInternalId(42161)?.evmChainId).toBe(42161);
  });

  it("internalToEvmChainId maps internal->evm and passes through unknown ids", () => {
    expect(internalToEvmChainId(100000019)).toBe(25);
    expect(internalToEvmChainId(8453)).toBe(8453);
    expect(internalToEvmChainId(7565164)).toBe(7565164); // Solana: not in Phase 1 set -> passthrough, flagged by isEvmDeportChain
  });

  it("isEvmDeportChain only accepts Phase 1 EVM chains", () => {
    expect(isEvmDeportChain(1)).toBe(true);
    expect(isEvmDeportChain(100000019)).toBe(true);
    expect(isEvmDeportChain(7565164)).toBe(false); // Solana
    expect(isEvmDeportChain(100000026)).toBe(false); // Tron
  });

  it("deBridgeGate returns Base's distinct gate, default elsewhere", () => {
    expect(deBridgeGate(8453)).toBe(BASE_GATE);
    expect(deBridgeGate(1)).toBe(DEFAULT_GATE);
    expect(deBridgeGate(100000019)).toBe(DEFAULT_GATE);
  });

  it("getRpcUrl prefers env override (keyed by EVM chain id) over default", () => {
    expect(getRpcUrl(42161)).toContain("publicnode");
    process.env.RPC_URL_42161 = "https://my-arb-rpc.example";
    expect(getRpcUrl(42161)).toBe("https://my-arb-rpc.example");
  });

  it("getByEvmId round-trips and Multicall3 address is the canonical one", () => {
    expect(getChainByEvmId(999)?.name).toBe("HyperEVM");
    expect(MULTICALL3_ADDRESS).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
  });

  it("every chain has a gate, rpc, and native metadata", () => {
    for (const c of EVM_DEPORT_CHAINS) {
      expect(c.gate).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(c.defaultRpcUrl).toMatch(/^https:\/\//);
      expect(c.nativeSymbol.length).toBeGreaterThan(0);
      expect(c.nativeDecimals).toBeGreaterThan(0);
    }
  });
});
