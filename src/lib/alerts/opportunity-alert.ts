import type { Opportunity } from "../types";
import { chainName } from "../deport/registry";
import type { DiscordEmbed } from "./providers/discord";

/** Max alerts dispatched per scan batch — a Discord webhook rate-limit + first-run flood guard. Extras
 *  beyond the cap are NOT marked sent, so they get another chance on the next batch (no silent drop). */
export const ALERT_BATCH_CAP = 10;

/** Parse ARB_ALERT_MIN_SPREAD_PCT into a finite number, or null when unset/blank/non-numeric (the
 *  gross-spread threshold is then disabled and only net-profitable routes alert). */
export function parseAlertMinSpread(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Alert when the route is net-profitable, OR (if a threshold is set) its gross spread clears it. */
export function shouldAlert(opp: Opportunity, minSpreadPct: number | null): boolean {
  if (opp.edge.profitable) return true;
  if (minSpreadPct != null && opp.edge.grossSpreadPct >= minSpreadPct) return true;
  return false;
}

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;

/** PURE: build a Discord embed describing a profitable / high-spread opportunity. */
export function formatOpportunityEmbed(opp: Opportunity): DiscordEmbed {
  const verified = opp.verification?.verified === true;
  const fields: NonNullable<DiscordEmbed["fields"]> = [
    { name: "Route", value: `${chainName(opp.buyChainId)} → ${chainName(opp.sellChainId)}`, inline: true },
    { name: "Gross spread", value: fmtPct(opp.edge.grossSpreadPct), inline: true },
    { name: "Net (after costs)", value: `${fmtUsd(opp.edge.netUsd)} (${fmtPct(opp.edge.netEdgePct)})`, inline: true },
    { name: "Probe size", value: fmtUsd(opp.tierUsd), inline: true },
    { name: "dePort fee", value: fmtUsd(opp.edge.deportFeeUsd), inline: true },
    { name: "Verified", value: verified ? "✅ yes" : (opp.verification?.rejectReason ? `— (${opp.verification.rejectReason})` : "—"), inline: true },
  ];
  const legs = opp.lockPath.map((l) => `${chainName(l.chainId)}: \`${l.address}\``).join("\n");
  if (legs) fields.push({ name: "Legs", value: legs.slice(0, 1024) });
  return {
    title: `${opp.edge.profitable ? "💰" : "📈"} ${opp.symbol ?? "?"} — ${fmtPct(opp.edge.grossSpreadPct)} spread`,
    color: opp.edge.profitable ? 0x22c55e : 0xf59e0b, // green when net-profitable, amber for high-gross-only
    fields,
    timestamp: new Date(opp.computedAt || Date.now()).toISOString(),
  };
}
