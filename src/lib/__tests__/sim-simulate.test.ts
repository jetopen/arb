import { describe, it, expect } from "vitest";
import { verdict } from "../sim/simulate";
import type { LegSim, ClaimPrecheck } from "../sim/types";

const leg = (status: LegSim["status"]): LegSim => ({ status });
const claim = (status: ClaimPrecheck["status"]): ClaimPrecheck => ({ status });

describe("simulate verdict (the executable honesty rules)", () => {
  it("true when every simulatable leg passes — skipped legs are unknown, not blocking", () => {
    expect(verdict([leg("pass"), leg("pass"), leg("skipped")], claim("pass"))).toBe(true);
    expect(verdict([leg("pass"), leg("skipped"), leg("skipped")], claim("skipped"))).toBe(true);
  });

  it("false when any leg reverts or the claim fails", () => {
    expect(verdict([leg("pass"), leg("revert"), leg("skipped")], claim("pass"))).toBe(false);
    expect(verdict([leg("pass"), leg("pass"), leg("pass")], claim("fail"))).toBe(false);
    expect(verdict([leg("revert"), leg("pass")], claim("pass"))).toBe(false); // one revert outweighs passes
  });

  it("null when nothing on the route could be simulated (all skipped)", () => {
    expect(verdict([leg("skipped"), leg("skipped"), leg("skipped")], claim("skipped"))).toBe(null);
  });
});
