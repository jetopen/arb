# cross-venue-scanner

A manual-arb **screener** that mirrors the [@uyar121](https://x.com/uyar121) method: find a
sharply-moving micro-cap, look at every venue it trades on, and surface the **cross-venue
price gap** — the kind that opens when a thin token's price desyncs across obscure CEXes/DEXes
and *stays* open because no bot bridges them.

This is deliberately **not** a structural-mechanism arb. Those (bridge 1:1 redemption,
orderbook↔AMM like Hyperliquid) turned out to be either *stranded* (no reachable counter-venue)
or *bot-saturated* (a sub-2s gas race). The edge here is **informational/operational**, not speed.

## What it does
1. Pulls CoinGecko top **movers** (|24h| in the ±10–60% band, micro/small-cap, real volume).
2. For each, pulls `/coins/{id}/tickers?depth=true` — every venue's price, spread, 24h volume,
   and `cost_to_move_up/down_usd` (USD to move price ±2% = real depth).
3. Gates out dead/stale/wide/thin markets, then computes the **buy-cheap / sell-rich** gap
   across the surviving venues, net of an assumed round-trip cost, with the **tradable size**
   (limited by the thinner side's depth).
4. Ranks and flags candidates; labels each CEX↔CEX / CEX↔DEX / DEX↔DEX.

## What it does NOT do (your job — the trap that kills most of these)
CoinGecko cannot tell you if the asset is actually **movable** between the two venues. Before
trading any flag, confirm:
- the **buy** venue allows **withdrawal** on a network the **sell** venue accepts for **deposit**;
- it's the **same canonical asset** (not a same-ticker different token);
- withdrawal + network fees < net gap at your size;
- prices are **fresh** (movers reprice fast — re-pull right before acting).

## Run
```
node cross-venue-scanner/scan.mjs
```
No deps, no auth (Node 18+ global `fetch`). Rate-limit-spaced for CoinGecko's free tier.
Tunable thresholds are in the `CONFIG` block at the top of `scan.mjs`.

## Caveats
- Free CoinGecko `converted_last.usd` can lag a fast move; the depth fields are point-in-time.
- `trust_score` is often `null` on small exchanges, so it's not used as a hard filter — the
  vol/spread/depth gates and `is_stale`/`is_anomaly` flags do the quality screening instead.
