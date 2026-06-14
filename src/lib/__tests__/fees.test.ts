import { describe, it, expect } from "vitest";
import { feeWeiToUsd, docFeeToUsd, DOC_FIXED_FEE_NATIVE } from "../deport/fees";

describe("dePort fees", () => {
  it("feeWeiToUsd converts native wei to USD", () => {
    // 0.001 ETH at $2000 = $2
    expect(feeWeiToUsd(1_000_000_000_000_000n, 18, 2000)).toBeCloseTo(2, 6);
    // 0.005 BNB at $600 = $3
    expect(feeWeiToUsd(5_000_000_000_000_000n, 18, 600)).toBeCloseTo(3, 6);
  });

  it("docFeeToUsd uses the documented native fee table", () => {
    // Ethereum doc fee 0.001 ETH at $2500 = $2.5
    expect(docFeeToUsd(1, 2500)).toBeCloseTo(2.5, 6);
    // Polygon 0.5 POL at $0.4 = $0.2
    expect(docFeeToUsd(137, 0.4)).toBeCloseTo(0.2, 6);
    // unknown chain -> 0
    expect(docFeeToUsd(999999, 1000)).toBe(0);
  });

  it("doc table covers every Phase 1 EVM dePort chain", () => {
    for (const id of [1, 10, 56, 137, 8453, 42161, 43114, 59144, 100000019, 100000023, 100000022]) {
      expect(DOC_FIXED_FEE_NATIVE[id]).toBeGreaterThan(0);
    }
  });
});
