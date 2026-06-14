import { describe, it, expect } from "vitest";
import { pickLogo } from "./logos";

describe("pickLogo", () => {
  const tokenList = new Map<string, { logoURI?: string }>([
    ["0x4c9edd5852cd905f086c759e8383e09bff1e68b3", { logoURI: "https://logos.example/usde.png" }],
    ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", { logoURI: undefined }],
  ]);

  it("returns the logoURI for a matching address", () => {
    expect(pickLogo(tokenList, "0x4c9edd5852cd905f086c759e8383e09bff1e68b3")).toBe(
      "https://logos.example/usde.png"
    );
  });

  it("matches the address case-insensitively", () => {
    expect(pickLogo(tokenList, "0x4C9EDD5852CD905F086C759E8383E09BFF1E68B3")).toBe(
      "https://logos.example/usde.png"
    );
  });

  it("returns null when the address is not in the list", () => {
    expect(pickLogo(tokenList, "0x0000000000000000000000000000000000000000")).toBeNull();
  });

  it("returns null when the matched entry has no logoURI", () => {
    expect(pickLogo(tokenList, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBeNull();
  });
});
