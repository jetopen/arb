import { describe, expect, it } from "vitest";
import {
  cexFlagsFor,
  computeSpreadPct,
  formatPrice,
  formatUsd,
  itemKey,
  logoFor,
} from "./token-card";
import { toCsv, toJson, type LzExportRow } from "./export-button";
import type { LzOftToken, LzOftDeployment } from "@/lib/layerzero/types";

function dep(chainKey: string, tradeAddress: string, over: Partial<LzOftDeployment> = {}): LzOftDeployment {
  return {
    chainKey,
    chainName: chainKey,
    evmChainId: 1,
    address: tradeAddress,
    tradeAddress,
    localDecimals: 18,
    type: "OFT",
    isAdapter: false,
    explorerUrl: null,
    ...over,
  };
}

function token(symbol: string, deployments: LzOftDeployment[], over: Partial<LzOftToken> = {}): LzOftToken {
  return { symbol, name: symbol, sharedDecimals: 6, endpointVersion: "v2", deployments, ...over };
}

describe("itemKey", () => {
  it("joins chainKey and tradeAddress", () => {
    expect(itemKey(dep("ethereum", "0xABC"))).toBe("ethereum:0xABC");
  });
});

describe("formatUsd / formatPrice", () => {
  it("formats usd magnitudes", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(2_500_000)).toBe("$2.50M");
    expect(formatUsd(1_500)).toBe("$1.5K");
    expect(formatUsd(42)).toBe("$42");
  });
  it("keeps precision for sub-dollar prices", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(1234.5)).toBe("$1,234.5");
    expect(formatPrice(0.0001234)).toBe("$0.000123");
  });
});

describe("computeSpreadPct", () => {
  const t = token("AAA", [dep("ethereum", "0x1"), dep("base", "0x2"), dep("arbitrum", "0x3")]);
  it("returns null when no price map", () => {
    expect(computeSpreadPct(t, null)).toBeNull();
    expect(computeSpreadPct(t, undefined)).toBeNull();
  });
  it("returns null with fewer than two priced chains", () => {
    expect(computeSpreadPct(t, { "ethereum:0x1": 1 })).toBeNull();
    expect(computeSpreadPct(t, { "ethereum:0x1": 1, "base:0x2": null })).toBeNull();
  });
  it("computes (max-min)/min as a percent over priced chains", () => {
    const spread = computeSpreadPct(t, {
      "ethereum:0x1": 1.0,
      "base:0x2": 1.1,
      "arbitrum:0x3": 1.05,
    });
    expect(spread).toBeCloseTo(10, 5); // (1.1-1.0)/1.0 = 10%
  });
  it("ignores non-positive prices", () => {
    expect(
      computeSpreadPct(t, { "ethereum:0x1": 0, "base:0x2": 2, "arbitrum:0x3": 4 })
    ).toBeCloseTo(100, 5);
  });
});

describe("cexFlagsFor (tolerant of response shapes)", () => {
  const sym = "GUSD";
  it("returns [] when no data / no entry", () => {
    expect(cexFlagsFor(sym, null)).toEqual([]);
    expect(cexFlagsFor(sym, {})).toEqual([]);
    expect(cexFlagsFor(sym, { OTHER: { gate: true } })).toEqual([]);
  });
  it("reads boolean flags", () => {
    const v = cexFlagsFor(sym, { GUSD: { gate: true, mexc: false, bitget: true } });
    expect(v.map((x) => x.key)).toEqual(["gate", "bitget"]);
  });
  it("treats url strings and objects as listed", () => {
    const v = cexFlagsFor(sym, { GUSD: { gate: "https://gate.io/x", mexc: { pair: "GUSD_USDT" } } });
    expect(v.map((x) => x.key).sort()).toEqual(["gate", "mexc"]);
  });
  it("matches symbol case-insensitively", () => {
    expect(cexFlagsFor("gusd", { GUSD: { gate: true } }).map((x) => x.key)).toEqual(["gate"]);
  });
});

describe("logoFor (tolerant lookup)", () => {
  const t = token("AAA", [dep("ethereum", "0x1"), dep("base", "0x2")]);
  it("returns null with no data", () => {
    expect(logoFor(t, null)).toBeNull();
    expect(logoFor(t, {})).toBeNull();
  });
  it("prefers a chain-keyed logo", () => {
    expect(logoFor(t, { "base:0x2": "http://logo/b.png" })).toBe("http://logo/b.png");
  });
  it("falls back to a symbol-keyed logo", () => {
    expect(logoFor(t, { AAA: "http://logo/a.png" })).toBe("http://logo/a.png");
  });
});

describe("export toCsv / toJson", () => {
  const rows: LzExportRow[] = [
    {
      symbol: "AAA",
      chainName: "Ethereum",
      address: "0xADDR",
      tradeAddress: "0xTRADE",
      liquidityUsd: 1000,
      priceUsd: 1.23,
    },
    {
      symbol: "B,B", // forces CSV quoting
      chainName: "Base",
      address: "0xB",
      tradeAddress: "0xB",
      liquidityUsd: null,
      priceUsd: null,
    },
  ];

  it("emits a header + one line per row, with nulls as empty", () => {
    const csv = toCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("symbol,chainName,address,tradeAddress,liquidityUsd,priceUsd");
    expect(lines[1]).toBe("AAA,Ethereum,0xADDR,0xTRADE,1000,1.23");
    // comma in field is quoted; null numerics are empty cells
    expect(lines[2]).toBe('"B,B",Base,0xB,0xB,,');
  });

  it("round-trips JSON", () => {
    expect(JSON.parse(toJson(rows))).toEqual(rows);
  });
});
