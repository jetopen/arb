import { describe, it, expect } from "vitest";
import { parseGtToken } from "./price";

describe("parseGtToken", () => {
  it("extracts all metrics when present (strings -> numbers)", () => {
    const raw = {
      data: {
        attributes: {
          price_usd: "1.0003",
          total_reserve_in_usd: "12345678.9",
          volume_usd: { h24: "987654.32" },
          fdv_usd: "4500000000",
        },
      },
    };
    expect(parseGtToken(raw)).toEqual({
      priceUsd: 1.0003,
      liquidityUsd: 12345678.9,
      volumeH24Usd: 987654.32,
      fdvUsd: 4500000000,
    });
  });

  it("returns nulls for missing fields / absent attributes", () => {
    expect(parseGtToken({ data: { attributes: {} } })).toEqual({
      priceUsd: null,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
    // partially present: only price + volume.h24
    expect(
      parseGtToken({
        data: { attributes: { price_usd: "2.5", volume_usd: {} } },
      })
    ).toEqual({
      priceUsd: 2.5,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
  });

  it("maps NaN / garbage / non-object input to nulls", () => {
    expect(
      parseGtToken({
        data: {
          attributes: {
            price_usd: "not-a-number",
            total_reserve_in_usd: "abc",
            volume_usd: { h24: {} },
            fdv_usd: NaN,
          },
        },
      })
    ).toEqual({
      priceUsd: null,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
    // structurally garbage inputs degrade to all-null, never throw
    expect(parseGtToken(null)).toEqual({
      priceUsd: null,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
    expect(parseGtToken({})).toEqual({
      priceUsd: null,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
    expect(parseGtToken("garbage")).toEqual({
      priceUsd: null,
      liquidityUsd: null,
      volumeH24Usd: null,
      fdvUsd: null,
    });
  });
});
