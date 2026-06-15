# Esoteric Native-Token Arb Discovery — Methodology & Replication Playbook (2026-06-15)

How the "find live arbitrage on `defillama.com/chains/<category>` DEXs" run was actually conducted, written so it can be **replayed from a single prompt**. The worked example was the **Bitcoin Sidechains** category (15 chains), asset class = each chain's **bridged native/governance token** (CORE, MERL, HEMI, SYS…), excluding BTC/WBTC variants.

**TL;DR — the method is a two-layer, adversarially-verified fan-out:**
1. **Scope the surface authoritatively** (the DefiLlama category list is NOT what cached data or the DEX-volume API implies — it must be pulled from the rendered page).
2. **Pin the asset class with the user** before spending any tokens (native vs BTC-variant vs stable → completely different work).
3. Run a **`resolve → price → analyze → verify` pipeline, one independent lane per chain**, where each candidate spread is killed by **3 diverse adversarial lenses** (stale / fungibility / execution) before it survives.
4. **The finding is usually negative, and that's the value** — the screen converts dozens of headline "spreads" into a ranked list of *why each is fake*. **Inverse-spread law: the bigger the headline gap, the deader the token** (INTR 56%, SYS 13%, RIF 12.6%, GOATED 10.9% were all traps; the only net-positive was B2 at +0.38%).

---

## 1. When to use this

Trigger when the ask is some form of: *"find live arbitrage opportunities on [a DefiLlama chain / chain-category / DEX surface]."* It is a **research/discovery** task, not a code change — the deliverable is a ranked candidate list + a reusable trap screen, not a feature (mechanizing it is a separate follow-on).

It is purpose-built for **esoteric, thin venues** (new/small chains, long-tail tokens). It is the wrong tool for liquid majors (bot-saturated, no manual edge) — see `cross-chain-research.md` for why "scan everything" fails.

---

## 2. Architecture: two layers + a barrier

Two workflows run **in parallel**, because the question has two halves that need different data:

| Layer | Answers | Data source | Tool |
|---|---|---|---|
| **Quantitative** (price-pull) | *Do the prices actually diverge right now, and can I fill size?* | CoinGecko ticker depth, DexScreener pools, direct CEX tickers | a `Workflow` fan-out |
| **Qualitative** (deep-research) | *Can I actually move the asset between venues? (CEX deposit/withdrawal open? bridge live? fungible?)* | web search + fetch, sourced & 3-vote verified | the `deep-research` skill |

Neither alone is sufficient: a real price gap you can't settle is worthless, and a perfect settlement path with no gap is worthless. **Merge both before concluding.** The quantitative layer is the spine of this doc; the qualitative layer is just `Skill(deep-research)` with the same brief.

---

## 3. Phase 0 — Scope the discovery surface (do NOT skip; this is where the worked run made its one real error)

The DefiLlama category membership is **not** obvious. Three sources disagree:

- ❌ **Cached repo JSON** (`chains.json`, `dexs_response.json`) — stale snapshots; led the first pass to *invent* a 10-chain list that wrongly included Botanix & Citrea and **missed Hemi** (the 3rd-largest DEX chain in the category).
- ❌ **`/overview/dexs` `allChains`** — that's the *DEX-volume universe* (172 chains), not the category.
- ✅ **The rendered category page** — the authority. It lists exactly the chains in the category with TVL + 24h DEX volume.

### Endpoints that work

```
# Category membership (AUTHORITATIVE). Plain WebFetch gets HTTP 403 (Cloudflare).
# Use the JS-rendering reader instead:
mcp__z-web-reader__webReader  url=https://defillama.com/chains/bitcoin-sidechains  no_cache=true
# -> returns the full table: Name | Protocols | DeFi TVL | 24h DEXs Volume | ...

# Per-chain DEX breakdown (plain WebFetch is fine on the API host):
https://api.llama.fi/overview/dexs/<chainSlug>?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true
# -> per-DEX total24h / total7d / change_7d. Reveals thin/dead DEXs.

# Sanity list of all DEX-tracked chains:
https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true
```

**Output of Phase 0:** the exact chain list + each chain's top DEXs and 24h volume. Volume tiers tell you what you're dealing with — e.g. Rootstock $866k (liquid, bot-contested) vs Merlin $96 / Bitlayer $0 ("dead DEX, live pool" candidates). **Lesson: always derive the list from the rendered category page, then diff against what you think you know.**

---

## 4. Phase 1 — Pin the asset class with the user (one `AskUserQuestion`, before any fan-out)

"Find arbitrage on these DEXs" is under-specified. Two forks change *everything downstream*:

1. **Deliverable:** one-shot research report **vs** a continuous scanner module. (Snapshot research first is almost always right — you don't mechanize before confirming edge exists.)
2. **Arb mechanism / asset class:** native/governance token **vs** BTC-pegged variants (WBTC/solvBTC…) **vs** cross-DEX same-token **vs** DEX-vs-CEX. These hit different tokens, venues, and traps.

Ask both in a single `AskUserQuestion` with a recommended default. **The worked run's answer — "native/governance tokens, NOT BTC variants" — is what made it tractable**; without it you'd boil the ocean.

---

## 5. Phase 2 — The pipeline (the heart of the method)

One independent lane per chain, `pipeline()` (NOT a barrier — chains don't depend on each other; lane A can be analyzing while lane B is still resolving):

```
resolve  →  price  →  analyze        [per-chain, parallel lanes]
                                    ──barrier──
        gate: looksReal && maxSpread ≥ 1.5%, top 8
                                    ──verify──
   3 adversarial lenses per survivor (stale / fungibility / execution)
```

Every stage agent is forced to return **structured JSON via a schema** (no parsing, model retries on mismatch).

### 5a. `resolve` — identify the real token, kill impostors
Input: chain + a hint (known ticker, CoinGecko-id guess, impostor warnings). Output: `{hasLiveToken, ticker, coingeckoId, homeChainAddress, bridgedAddresses[], isEvm, impostorNotes, confidence}`.
The whole job is **disambiguation** — same-ticker impostors are the #1 error:
- GOAT → the real ticker is **GOATED** (GOAT Network); "Goatseus Maximus" GOAT on Solana is a different large-cap.
- MERL on Solana ($269M fake CLMM "liquidity", $4/24h vol) ≠ Merlin-chain MERL.
- Botanix has **no token by design**; Citrea/Libre tokens needed live-tradeable confirmation.
Set `hasLiveToken=false` and stop the lane when there's no real non-BTC token.

### 5b. `price` — pull every venue
For the resolved token, gather **CEX + on-chain DEX** prices. The single most valuable call:

```
https://api.coingecko.com/api/v3/coins/<id>/tickers?depth=true&order=volume_desc
```
Per market it gives: `market.name`, `base/target`, `converted_last.usd`, `converted_volume.usd`,
`bid_ask_spread_percentage`, `trust_score`, **`is_stale`, `is_anomaly`**, and with `depth=true` the
**`cost_to_move_up_usd` / `cost_to_move_down_usd`** (the ±2% orderbook depth — this is your fill-size cap).

Plus on-chain pools (catches thin sidechain-DEX drift that CoinGecko misses):
```
https://api.dexscreener.com/latest/dex/tokens/<contractAddress>   # priceUsd, liquidity.usd, volume.h24, txns.h24 per pair, all chains
https://api.dexscreener.com/latest/dex/search?q=<ticker>          # resolution / discovery
# GeckoTerminal for pools DexScreener doesn't index; direct CEX tickers (Gate/MEXC/KuCoin/Bybit/Bitget) for precision.
```
**Force the agent to include the outliers**, not just the top-6 by volume: every `is_stale`/`is_anomaly` market, the single lowest- and highest-price venue, and all home-chain pools *even at $0 volume* (a real-TVL/zero-volume pool that drifted is the whole point). Non-EVM tokens (Stacks, Interlay, Libre) won't be on DexScreener — use their native DEX APIs / CoinGecko DEX tickers and flag the limitation.

### 5c. `analyze` — turn prices into a capturable edge
Output `{maxSpreadPct, cheapVenue, expensiveVenue, fillSizeUsd, executionPath, feesEstimateUsd, netEdgePct, traps[], looksReal}` under the operator's real constraints ($100–$5k, manual, no bots):
- **Discard data artifacts** (stale+anomaly with no liquidity; pool with ~$0 vol AND ~$0 liq) — but keep real-TVL/idle-volume pools.
- `fillSizeUsd` bounded by the **thinner** side's depth (`cost_to_move`) before slippage eats the edge.
- `feesEstimateUsd` = swap + bridge + gas + CEX withdrawal; **flag where a flat fee destroys the edge at small size** (the binding constraint for manual operators).
- `netEdgePct` after fees + slippage at `fillSizeUsd`. **This, not gross, is the verdict number.**

### 5d. `verify` — adversarial, 3 diverse lenses, default-to-refuted
Only candidates that are `looksReal && maxSpreadPct ≥ 1.5%` get here (gate). Each gets **3 lenses run in parallel**, each told to **default to `refuted=true`** unless it clearly survives:
1. **Stale-data** — is the cheap/expensive price an unrefreshed/`is_anomaly` ticker, an **aggregator/broker quote that just routes to the other venue** (this killed MERL: BitKan routes to OKX), or a $0-volume pool quote?
2. **Fungibility** — is it the *same asset* on both sides, and can value move between them? Catches same-ticker-different-contract, non-redeemable bridged reps, and **quote-currency depeg** (RIF was priced in USDrif, itself <$1 → the 12.6% "gap" was a unit illusion).
3. **Execution** — can a manual operator fill the size and complete the round trip *now*? CEX deposit AND withdrawal open for this chain? bridge live? pool deep enough net of fees?

Survives only if **< 2 of 3 refute**. Diverse lenses beat 3 identical skeptics — each catches a failure mode the others can't. (Worked run: every candidate that reached verify was refuted ≥2/3; the surface was genuinely empty.)

---

## 6. The 10-trap screen (the reusable artifact)

Every false positive across 16 tokens fell into one of these. **Run any candidate through this list before believing it:**

| # | Trap | Tell | Example |
|---|---|---|---|
| 1 | Aggregator/broker phantom | "cheap" venue is a router/aggregator | MERL / BitKan→OKX |
| 2 | Quote-currency depeg | pool quoted in a local stable <$1 | RIF / USDrif |
| 3 | Same-brand, different deployment | same ticker, non-fungible contracts | GOATED Raydium SPL; legacy MAP vs MAPO |
| 4 | Chain-mismatch fungibility | same token, different networks → bridge is the cost | HEMI ETH-pool vs BSC-pool; CTR |
| 5 | Stale / halted book | frozen quote, suspended deposits | SYS Gate −47%; SAVM Bilaxy |
| 6 | Kimchi / FX premium | KRW/THB pair behind Korean/Thai KYC | STX Upbit; BB/MAPO/BOB Bithumb |
| 7 | Depth mirage | real price, $2–30 deep (`cost_to_move`) | SYS ($25 cap), SAVM ($1.85), INTR ($19 pool) |
| 8 | Flat-fee domination | net% > 0 but absolute $ < fees | MAPO, SYS, B2 below ~$1k |
| 9 | Single venue / no exit | only one live market — can't arb one side | INTR (every CEX delisted) |
| 10 | CoinGecko decimals/cache corruption | price 100–1000× off on-chain | LIBRE (1093×) |

This extends the `esoteric-arb-targets` memory note ("CoinGecko same-id ≠ fungible", "$0 volume often = untracked-but-active adapter, not dead").

---

## 7. Workflow orchestration skeleton

The exact control flow (JS, runs in the `Workflow` tool). Reuse verbatim; only swap the `CHAINS` array and hints. Full scripts:
`workflows/scripts/btc-sidechain-native-arb-prices-*.js` (batch 1 + batch 2).

```js
// schemas: RESOLVE / PRICE / ANALYZE / VERDICT  (force structured output)
phase('Resolve')
const analyzed = await pipeline(
  CHAINS,
  (c)    => agent(resolvePrompt(c),            { phase:'Resolve', schema: RESOLVE_SCHEMA }),
  (r,c)  => (!r||!r.hasLiveToken||!r.coingeckoId) ? {skipped:true,chain:c.chain,resolve:r}
            : agent(pricePrompt(r),            { phase:'Price',   schema: PRICE_SCHEMA }).then(p=>({resolve:r,price:p})),
  (x,c)  => (!x||x.skipped||!x.price) ? x
            : agent(analyzePrompt(x.resolve,x.price), { phase:'Analyze', schema: ANALYZE_SCHEMA }).then(a=>({...x,analysis:a})),
)
const valid = analyzed.filter(x=>x&&!x.skipped&&x.analysis)
const candidates = valid.filter(x=>x.analysis.looksReal && x.analysis.maxSpreadPct>=1.5)
                        .sort((a,b)=>b.analysis.maxSpreadPct-a.analysis.maxSpreadPct).slice(0,8)
phase('Verify')
const verified = await parallel(candidates.map(x => () =>
  parallel([0,1,2].map(i => () => agent(verifyPrompt(x,i), { phase:'Verify', schema: VERDICT_SCHEMA })))
    .then(v => ({ ...x, refutes: v.filter(z=>z&&z.refuted).length, survives: v.filter(z=>z&&z.refuted).length<2 }))
))
return { resolvedTokens, noToken, verifiedCandidates: verified, allAnalyzed }
```
Notes: `pipeline` not `parallel` for the lanes (no cross-chain dependency → no wasted wall-clock). The barrier is only at the gate→verify boundary (verify focuses on the top-N across all chains, which genuinely needs all `analyze` results). `.catch(()=>({skipped:true…}))` so one dead chain can't sink the run. ~21–31 agents / run.

---

## 8. Copy-paste prompt templates

### 8a. Kickoff (what to send me)
```
Find live, executable arbitrage opportunities in the <ASSET CLASS> of the chains on
https://defillama.com/chains/<CATEGORY>.  Asset class = <native/governance tokens | BTC-pegged variants | bridged stables>, explicitly NOT <exclusions>.
For each: map every venue (the chain's own DEXs, CEX orderbooks, bridged reps on liquid chains), find price dislocations, and PRIORITIZE the "dead DEX / live pool" signal (real TVL + ~0 recent volume = drifted price) — but verify it's not an untracked-but-active adapter.
Operator profile: MANUAL, no bots, $100–$5,000 clips; flag where a flat bridge/withdrawal fee destroys the edge at small size.
Explicitly call out illusory gaps: same-ticker-different-token, phantom fungibility, stale/aggregator quotes, kimchi premiums, depth mirages.
Deliver a ranked list of the strongest LIVE candidates with venues, spreads, fill size, execution path, fees, and the binding risk.
```

### 8b. To force the full two-layer treatment
Add: `Run it as two parallel workflows — a quantitative live-price fan-out (CoinGecko ticker depth + DexScreener) and the deep-research skill for CEX deposit/withdrawal + bridge status — then merge.` (With ultracode on, this happens by default.)

### 8c. Per-stage agent prompts
Lifted verbatim from `resolvePrompt / pricePrompt / analyzePrompt / verifyPrompt` in the workflow scripts above — reuse those functions; they already encode the data sources, the "include the outliers" rule, the fee logic, and the default-to-refuted lenses.

---

## 9. Reading the output

- **Rank by `netEdgePct`, never `maxSpreadPct`.** Gross spread is a lure.
- **A negative result is a complete answer.** "No capturable edge; here's why each headline gap is fake" + the trap taxonomy is the deliverable.
- **Where edge actually lives** (the standing conclusion): not in snapshot native-token scans — the liquid tokens are CEX-arbed tight, the illiquid ones untradeable. The only residue is **transient drift on genuinely thin home-chain pools** (MerlinSwap, Satsuma/Citrea, Curve HEMI), which needs **continuous polling + a same-chain exit** (no bridge fee) — i.e. a *monitor*, not a scan. This is consistent with the project's verified thesis: Symbiosis Octopools + Hyperliquid HyperCore↔HyperEVM are the real venues (`cross-chain-research.md`, `esoteric-arb-targets` memory).

---

## 10. Pitfalls & lessons (from this run)

1. **Scope from the rendered category page, then diff your assumptions** — the cached-data scoping missed Hemi (biggest uncovered DEX chain) and added two non-category chains. Cost a whole second batch.
2. **Cached repo JSON is a snapshot — never trust it for "what's live."** Re-pull.
3. **CoinGecko free tier rate-limits** under parallel load — instruct agents to fall back to DexScreener + direct CEX tickers on 429. WebFetch caches per-URL 15 min, which helps.
4. **`depth=true` is the unlock** — without `cost_to_move`, you can't separate a real edge from a depth mirage (trap #7), which was the single most common false positive.
5. **Diverse adversarial lenses > redundant skeptics** — stale/fungibility/execution each caught kills the others missed.
6. **Pin the asset class first.** The clarifying `AskUserQuestion` (Phase 1) was worth more than any single agent.

---

## 11. 8-step replication checklist

1. Pull the category membership from the **rendered** DefiLlama page (`z-web-reader`, not WebFetch). Diff vs assumptions.
2. Pull per-chain DEX volumes (`/overview/dexs/<chain>`); note thin/dead venues.
3. `AskUserQuestion`: deliverable (research vs module) + asset class. Get the default approved.
4. Launch the **quantitative** `resolve→price→analyze→verify` Workflow (skeleton §7) over the chains.
5. Launch the **`deep-research`** skill with the same brief in parallel.
6. Read both full outputs (the notification truncates — `Read` the `.output` file).
7. Merge; rank by `netEdgePct`; run every survivor through the 10-trap screen (§6).
8. Deliver: master table + the standing "where edge actually lives" conclusion. If anything survives, spec the thin-pool **monitor** (not a scan) as the follow-on.

---

## 12. Worked example — Bitcoin Sidechains results (2026-06-15)

The run this playbook is distilled from. Asset class = native/governance tokens, BTC-variants excluded. Two quantitative workflows, ~52 agents total. The qualitative `deep-research` layer did not return a completion (orphaned/terminated before merge) — the quantitative result was already conclusive, so it was not blocking.

**Category membership (15 chains, from the rendered page):** Rootstock, Stacks, Hemi, BOB, CORE, Merlin, Rollux, BSquared, MAP Protocol, BounceBit, GOAT, Bitlayer, SatoshiVM, Interlay, Libre. Scoping correction made mid-run: cached data had wrongly included **Botanix** (no token by design; network winding down, withdrawal deadline 2026-07-09) and **Citrea**, and had **missed Hemi** (3rd-largest DEX chain in the category, $284k/24h) — caught only by re-pulling the rendered page (lesson §10.1).

**Master table — ranked by `netEdgePct` (the verdict number), not gross:**

| # | Chain | Token | Gross | Net | Status / trap |
|---|---|---|---:|---:|---|
| 1 | BSquared | B2 | 0.93% | **+0.38%** | ⚠️ Only positive; ~$5 on $1.5k, fee-bound below ~$1k |
| 2 | Core | CORE | 0.71% | +0.3% | ❌ Near-efficient noise |
| 3 | Rollux | SYS | 13.0% | +3%* | ❌ *$25 fill cap (depth $27.70) → ~$1 absolute. Toy. |
| 4 | Hemi | HEMI | 2.13% | −0.3% | ❌ Trap #3/#4 chain-mismatch + `is_anomaly` headline |
| 5 | Stacks | STX | 1.37% | −0.6% | ❌ Trap #6 kimchi premium (Upbit KRW) |
| 6 | BounceBit | BB | 0.91% | −0.6% | ❌ CEX-efficient |
| 7 | BOB | BOB | 0.45% | −1.55% | ❌ goBOB phantom; 1.57% bid-ask |
| 8 | Rootstock | RIF | 12.6% | −2.5% | ❌ Trap #2 USDrif depeg unit-illusion |
| 9 | MAP Protocol | MAPO | 1.25% | −3.5% | ❌ Trap #8 flat-fee; legacy MAP non-fungible |
| 10 | Merlin | MERL | 2.0% | — | ❌ **Refuted 3/3** — Trap #1 BitKan aggregator routes to OKX |
| 11 | Bitlayer | BTR | 0.76% | −0.4% | ❌ Widest print stale+anomaly |
| 12 | GOAT | GOATED | 10.9% | −5% | ❌ Trap #3 phantom Solana SPL (non-fungible) |
| 13 | SatoshiVM | SAVM | 9.8% | −45% | ❌ Trap #5/#7 dead Bilaxy book ($1.85 depth) |
| 14 | Libre | LIBRE | 2.8% | −100% | ❌ Trap #10 abandoned microcap ($168 liq, 1093× CoinGecko) |
| 15 | Interlay | INTR | 56.4% | −100% | ❌ Trap #9 no exit venue (every CEX delisted; $19 pool) |
| — | *Botanix* | *—* | — | — | *Out of category; no token by design; winding down* |
| — | *Citrea* | *CTR* | *1.37%* | *+0.1%* | *Out of category; Trap #4 Base-rep vs native phantom* |

**Verdict: no capturable manual arbitrage in any Bitcoin-sidechain native token as of 2026-06-15.** Liquid tokens (CORE, HEMI, BB, STX, SYS) are CEX-arbed tighter than fees; illiquid ones are untradeable or artifact-ridden. The **inverse-spread law held perfectly** — every double-digit headline (INTR 56% → SYS 13% → RIF 12.6% → GOATED 10.9% → SAVM 9.8%) was a trap, and they clustered on exactly the thinnest tokens.

**Standing conclusion (carry forward):** native-token snapshot scanning on BTC sidechains is a dead end — consistent with the project's verified thesis that the real venues are **Symbiosis Octopools** + **Hyperliquid HyperCore↔HyperEVM** (`cross-chain-research.md`). The only structural residue is transient drift on genuinely thin home-chain pools (MerlinSwap MERL/WBTC ~$168k TVL/$189 vol, Curve HEMI/WETH, Satsuma on Citrea), which is capturable only by a **continuous monitor with a same-chain exit** (no bridge fee) — not by a one-shot scan.
