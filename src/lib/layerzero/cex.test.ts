import { describe, it, expect } from "vitest";
import { parseGate, parseMexc, parseBitget } from "./cex";

// --- Gate.io: GET /spot/tickers?currency_pair=BTC_USDT ---
// Listed: JSON array, price on [0].last (string).
const GATE_LISTED = [
  {
    currency_pair: "USDT_USDT",
    last: "1.0001",
    lowest_ask: "1.0002",
    highest_bid: "1.0000",
    change_percentage: "0.01",
    base_volume: "12345.67",
    quote_volume: "12345.67",
    high_24h: "1.0010",
    low_24h: "0.9990",
  },
];
// Not listed: Gate returns an empty array for an unknown pair.
const GATE_NOT_LISTED: unknown[] = [];

// --- MEXC: GET /ticker/price?symbol=BTCUSDT ---
const MEXC_LISTED = { symbol: "USDTUSDT", price: "1.0000" };
// Not listed: MEXC returns an error envelope with a numeric code.
const MEXC_NOT_LISTED = { code: 700002, msg: "Signature for this request is not valid." };

// --- Bitget: GET /spot/market/tickers?symbol=BTCUSDT ---
const BITGET_LISTED = {
  code: "00000",
  msg: "success",
  requestTime: 1700000000000,
  data: [
    {
      symbol: "USDTUSDT",
      lastPr: "0.9999",
      open: "1.0000",
      high24h: "1.0005",
      low24h: "0.9995",
      change24h: "-0.0001",
      baseVolume: "1000000",
      quoteVolume: "1000000",
    },
  ],
};
// Not listed: success envelope but empty data array.
const BITGET_NOT_LISTED = { code: "00000", msg: "success", requestTime: 1700000000000, data: [] };

describe("parseGate", () => {
  it("returns the last price for a listed pair", () => {
    expect(parseGate(GATE_LISTED)).toBeCloseTo(1.0001);
  });
  it("returns null for an empty array (not listed)", () => {
    expect(parseGate(GATE_NOT_LISTED)).toBeNull();
  });
  it("returns null for non-array / malformed input", () => {
    expect(parseGate(null)).toBeNull();
    expect(parseGate({})).toBeNull();
    expect(parseGate([{ last: "not-a-number" }])).toBeNull();
  });
});

describe("parseMexc", () => {
  it("returns the price for a listed symbol", () => {
    expect(parseMexc(MEXC_LISTED)).toBeCloseTo(1.0);
  });
  it("returns null for an error envelope with a code (not listed)", () => {
    expect(parseMexc(MEXC_NOT_LISTED)).toBeNull();
  });
  it("returns null for missing / malformed price", () => {
    expect(parseMexc(null)).toBeNull();
    expect(parseMexc({})).toBeNull();
    expect(parseMexc({ price: "" })).toBeNull();
  });
});

describe("parseBitget", () => {
  it("returns lastPr for a listed symbol", () => {
    expect(parseBitget(BITGET_LISTED)).toBeCloseTo(0.9999);
  });
  it("returns null for an empty data array (not listed)", () => {
    expect(parseBitget(BITGET_NOT_LISTED)).toBeNull();
  });
  it("returns null for non-object / malformed input", () => {
    expect(parseBitget(null)).toBeNull();
    expect(parseBitget({})).toBeNull();
    expect(parseBitget({ data: [{ lastPr: "oops" }] })).toBeNull();
  });
});
