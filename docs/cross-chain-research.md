# Broad Cross-Chain Scanner — Research (2026-06-14)

Research toward expanding beyond dePort deAssets. All findings hit live endpoints. TL;DR:
**the generic "scan all 25k tokens" target is the wrong one (bot-saturated + identity risk);
the verified high-ROI, small-capital-friendly target is Symbiosis Octopools, which publishes a
ranked LIVE positive-spread feed for free.**

## 1. The reframe (from the user's own verified notes)

Generic same-token-across-chains arb (USDC on chain A vs B) is **bot-dominated** — 5 addresses do
>50% of volume; 242k arbs / $868M/yr (arXiv 2501.17335). Manual/automated edge survives only on the
**newest / thinnest / least-covered venues**. So "scan everything" ≠ valuable. Target the esoteric venues.

## 2. Symbiosis Octopools — VERIFIED LIVE, highest ROI ⭐

Symbiosis runs cross-chain "Octopools": sTokens minted 1:1 but **AMM-priced**, so same-asset wraps
diverge. Their free, no-auth API does the hard part for us.

- **`GET https://api.symbiosis.finance/crosschain/v1/positive-spread-routes`** — a ranked LIVE arb feed.
  **56 routes live now**, +9 to +87 bps. Current top (verified):
  | spread | route |
  |---|---|
  | +87.03 bps | G @Base → wG |
  | +78.77 bps | APE @Eth → APE @HyperEVM |
  | +62.65 bps | SIS @Arb → SIS @Linea |
  | +15.47 bps | BTCB @BSC → WBTC @Merlin |
  | +11.22 bps | WRBTC @Rootstock → WBTC @Merlin |
  | +9.75 bps | USDC @143 → USDC.ETH @7000 |
  (5 of the 56 are BTC-family wrapped-vs-wrapped — the sWBTC/sBTCB/sWRBTC Octopool skew.)
- **`POST /v2/quote`** — executable net output. Live: 0.1 BTCB → 0.10034646 WBTC = **+34.65 bps** net of fees.
  **Small clips beat the listed (sized) bps** (+34 vs +15) — exactly the small-capital edge wanted.
- Octopools live on Symbiosis chain `13863860`; pool state via `/v1/pools` (`cash`/`liability`/
  `imbalanceBps`, Wombat-style — no getReserves). BTC Octopool `0xBf084Ee3E5C73129167167Bd5DB9FE8513d8F7e0`,
  cross-verified on-chain (basket skew 0.19 vs 1.45 sWBTC despite all legs 1:1 BTC-backed).
- Other paths: `/v1/tokens`, `/v1/pools`, `/v1/chains`, `/v1/fees`. Use the HTTP API, not the Caldera RPC (it IP-blocked after ~6 calls).

**Why this is the build:** a thin integration over an API that already computes + ranks executable
spreads. Lowest effort, verified live edges, favors small capital.

## 3. Hyperliquid HyperCore ↔ HyperEVM — second-tier, real but fiddlier

Orderbook (HyperCore) vs AMM (HyperEVM) gap. Verified:
- **HyperEVM side readable on-chain**: Hyperswap V3 WHYPE/USDT0 0.05% pool
  `0x337b56d87a6185cd46af3ac2cdf03cbc37070c30`, `slot0()` → **HYPE = $60.43**, ~$1M depth. Stable = USDT0
  `0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb`. (Intra-HyperEVM V2≈V3, no gap there.)
- **HyperCore side** (`POST https://api.hyperliquid.xyz/info`): works, BUT the spot universe has
  **multiple "HYPE"-named tokens** (@107, @207, @232, @255 at wildly different px) — canonical-pair
  selection is a real gotcha (also LHYPE `0x5748…` ≠ HYPE). Needs care; more work than Symbiosis.

## 4. DefiLlama dead-pool discovery — a candidate feed, not a signal

`GET https://api.llama.fi/overview/dexs` → 1,155 DEXs, **516 with <$100 24h vol** (Serum, Saddle, IDEX
Classic…). Caveat (your note, confirmed): **low volume often = untracked adapter, not a dead pool** —
must confirm on-chain (last swap ts + reserves). Discovery layer, not ready edges.

## 5. Generic CoinGecko-universe scanner — feasible plumbing, lower ROI

- **Identity**: CoinGecko `/coins/list?include_platform=true` = 17,446 coins, **3,165 multi-chain**, one
  2.7MB call. The master token→{chain:address} table. `/asset_platforms` maps slug→chainId.
- **Move leg**: deBridge DLN `create-tx` (quote-only, ~20 chains, 4bps+4bps+fixFee, 2-3s) primary;
  LI.FI `/v1/quote` (75 chains, **75 req/2hr** unauth) fallback; CCTP near-free for native USDC.
- **Top movers**: CoinGecko `top_gainers_losers` is PRO-only; use `/coins/markets`
  (`price_change_percentage=24h`) + client-side filter.
- **Biggest risk**: same CoinGecko `id` ≠ fungible/bridgeable — it collapses non-mutually-fungible
  wrapped variants → **phantom arbs**. Must gate every candidate on a real executable DLN/LI.FI quote.
  Plus saturation. → lower ROI than Symbiosis; if built, it's a *candidate generator gated by quotes*.

## 6. Note: a LayerZero OFT tracker is already being added to this repo

`/layerzero` page + `/api/lz/ofts` + `/api/lz/liquidity` + `src/lib/layerzero/` appeared in the tree
(matches uyar121 method #1: LayerZero/Stargate). The Symbiosis scanner complements it as another
esoteric-venue module.

## Recommendation

1. **Build the Symbiosis Octopool scanner first** — highest ROI, verified live edges, small-capital-favorable, free API. New `src/lib/symbiosis/*` + `/api/arb/symbiosis` + a page/tab, reusing the existing store + table/drawer UI. Poll `positive-spread-routes`, enrich with `/v2/quote` for executable net + small-clip sizing, persist to Supabase, rank.
2. **Then (optional) Hyperliquid HyperCore↔HyperEVM** — real edge, but resolve the canonical-HYPE-pair gotcha first.
3. **Defer the generic CoinGecko-universe scanner** — saturated + identity risk; only worth it as a quote-gated candidate generator later.
4. **DefiLlama discovery** — wire as a background "watchlist" feed, not a live arb signal.
