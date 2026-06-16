import { describe, it, expect, vi } from "vitest";
import { shouldAlert, formatOpportunityEmbed, parseAlertMinSpread, ALERT_BATCH_CAP } from "../alerts/opportunity-alert";
import { sendDiscordAlert } from "../alerts/providers/discord";
import type { Opportunity } from "../types";

function opp(over: Partial<Omit<Opportunity, "edge">> & { edge?: Partial<Opportunity["edge"]> } = {}): Opportunity {
  const { edge, ...rest } = over;
  return {
    id: "0xfam:42161:56:1000:redemption",
    debridgeId: "0xfam",
    kind: "redemption",
    symbol: "KAKA",
    buyChainId: 42161,
    sellChainId: 56,
    nativeChainId: 56,
    tierUsd: 1000,
    edge: {
      grossSpreadPct: 1.2,
      dexImpactBuyBps: 0,
      dexImpactSellBps: 0,
      deportFeeUsd: 4,
      gasBuyUsd: 0,
      gasSellUsd: 0,
      netUsd: -5,
      netEdgePct: -0.5,
      netUsdConservative: -6,
      profitable: false,
      ...edge,
    },
    verification: null,
    lockPath: [
      { chainId: 42161, address: "0xbuy", role: "buy with USDC" },
      { chainId: 56, address: "0xsell", role: "dePort 1:1, sell for USDC" },
    ],
    computedAt: 1_700_000_000_000,
    ...rest,
  };
}

describe("parseAlertMinSpread", () => {
  it("parses numbers; unset/blank/non-numeric → null (threshold off)", () => {
    expect(parseAlertMinSpread(undefined)).toBeNull();
    expect(parseAlertMinSpread("")).toBeNull();
    expect(parseAlertMinSpread("abc")).toBeNull();
    expect(parseAlertMinSpread("2")).toBe(2);
    expect(parseAlertMinSpread("0")).toBe(0);
    expect(parseAlertMinSpread("1.5")).toBe(1.5);
  });
});

describe("shouldAlert", () => {
  it("always alerts a net-profitable route regardless of threshold", () => {
    expect(shouldAlert(opp({ edge: { profitable: true } }), null)).toBe(true);
    expect(shouldAlert(opp({ edge: { profitable: true, grossSpreadPct: -50 } }), 5)).toBe(true);
  });
  it("alerts a non-profitable route only when gross spread clears a set threshold", () => {
    expect(shouldAlert(opp({ edge: { profitable: false, grossSpreadPct: 1.2 } }), null)).toBe(false); // no threshold
    expect(shouldAlert(opp({ edge: { profitable: false, grossSpreadPct: 1.2 } }), 2)).toBe(false); // below
    expect(shouldAlert(opp({ edge: { profitable: false, grossSpreadPct: 2.0 } }), 2)).toBe(true); // == threshold
    expect(shouldAlert(opp({ edge: { profitable: false, grossSpreadPct: 3.0 } }), 2)).toBe(true); // above
  });
});

describe("formatOpportunityEmbed", () => {
  it("green embed for a profitable opp with route/spread/net/verified/legs", () => {
    const e = formatOpportunityEmbed(
      opp({
        symbol: "KAKA",
        edge: { profitable: true, grossSpreadPct: 2.5, netUsd: 18, netEdgePct: 1.8 },
        verification: { verified: true, sourcesAgreed: ["jupiter", "geckoterminal"], quoteDisagreementBps: 5, liquidityUsd: 1e6 },
      })
    );
    expect(e.color).toBe(0x22c55e);
    expect(e.title).toContain("KAKA");
    expect(e.title).toContain("+2.500%");
    const names = (e.fields ?? []).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Route", "Gross spread", "Net (after costs)", "Verified", "Legs"]));
    expect(e.fields?.find((f) => f.name === "Verified")?.value).toContain("yes");
  });
  it("amber embed + reject reason for a non-profitable high-spread opp", () => {
    const e = formatOpportunityEmbed(
      opp({
        edge: { profitable: false, grossSpreadPct: 3 },
        verification: { verified: false, sourcesAgreed: [], quoteDisagreementBps: null, liquidityUsd: 100, rejectReason: "liquidity $100 < tier $1000" },
      })
    );
    expect(e.color).toBe(0xf59e0b);
    expect(e.fields?.find((f) => f.name === "Verified")?.value).toContain("liquidity");
  });
});

describe("sendDiscordAlert", () => {
  it("returns false on empty url without calling fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendDiscordAlert("", { content: "x" })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("POSTs and returns true on ok", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    expect(await sendDiscordAlert("https://discord/webhook", { embeds: [{ title: "t" }] })).toBe(true);
    expect(spy).toHaveBeenCalledWith("https://discord/webhook", expect.objectContaining({ method: "POST" }));
    spy.mockRestore();
  });
  it("returns false when fetch throws", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("net"));
    expect(await sendDiscordAlert("https://x", {})).toBe(false);
    spy.mockRestore();
  });
});

describe("ALERT_BATCH_CAP", () => {
  it("is a sane positive cap", () => {
    expect(ALERT_BATCH_CAP).toBeGreaterThan(0);
    expect(ALERT_BATCH_CAP).toBeLessThanOrEqual(25);
  });
});
