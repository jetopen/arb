# Cross-Chain Arbitrage Scanner — dePort lock-graph (deBridge)

> Goal: surface **real, executable cross-chain arbitrage** rooted in deBridge **dePort's
> lock-and-mint architecture** — ranked, liquidity-aware, real price impact, real redemption
> costs. No oracle prices, no simulation, no naive symbol-matching.

## 1. How to run the app (verified)

```powershell
cd C:\Users\netha\Documents\arb
npm run dev     # http://localhost:3001 (3000 is occupied)
npm test        # Vitest
npm run build
```
`.env.local` exists. Routes today: `/`, `/analytics`, `/tokens`, `/settings`. Modified
Next.js 16.2.7 — read `node_modules/next/dist/docs/` before writing server/route code.

## 2. The core insight — dePort is path/origin-dependent (this drives everything)

dePort locks a native token in `deBridgeGate` on its home chain and mints a **deAsset** on the
target chain. A deAsset's identity is **`debridgeId = getDebridgeId(nativeChainId, nativeTokenAddress)`**.

**Consequence (the nuance that must never be violated):** the *same nominal token*, locked from
*different native chains*, mints **distinct, non-fungible deAsset contracts** — even on the same
destination chain.

- `TokenA(native=Ethereum)` → deAsset on BSC at address **X**
- `TokenA(native=Arbitrum)` → deAsset on BSC at address **Y**
- **X ≠ Y.** Each redeems 1:1 *only* back to its own origin. They are different assets.

Therefore assets are **never grouped by symbol**. They are grouped by **`debridgeId`
(= lock origin)**. This is where the arbitrage actually lives.

## 3. The lock-graph (foundation)

A **family** = one `debridgeId` = { native root on its home chain } ∪ { deAsset representations,
each `{chain → contract address}` }. Every member of a family is redeemable 1:1 to the native
root via dePort. Same-symbol tokens with different origins are **different families**.

### Building it (validated mechanism)
- `getNativeInfo(address token) → (uint256 nativeChainId, bytes nativeAddress)` on `deBridgeGate`
  is the reverse-lookup: deAsset → its lock origin. Returns zero/empty for non-deBridge tokens,
  so it doubles as the **filter** for "genuine dePort deAsset."
- The token-list API exposes only `isNative` (no origin) → the graph **must** come from on-chain.
- **Enumerate via Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`, same on all EVM
  chains): batch `getNativeInfo` over each chain's `isNative:false` tokens. ~7 multicalls/chain →
  ~130 calls for all 16 EVM chains. deAsset sets change slowly → cache hard.
- `nativeChainId` is returned in **deBridge's internal chain-id space** (Ethereum 1, Solana
  7565164, Tron 100000026, Sei 100000027, …) — map via `supported-chains-info`.
- Forward path (optional optimization): `getDebridgeId` + CREATE2 via `DeBridgeTokenDeployer`
  (`0x8244…A464`, all EVM) gives deterministic deAsset addresses to discover reps not in token-lists.

### Contract addresses (known/deterministic)
- `deBridgeGate`: `0x43dE2d77BF8027e25dBD179B491e8d64f38398aA` (most EVM); Base
  `0xc1656B63D9EEBa6d114f6bE19565177893e5bCBF`; Tron `TTGA4XQ419jodtFSMFiwYqfgG2uSLRBsnn`.
- `DeBridgeTokenDeployer`: `0x8244d6Ffe0695B30b2bAD424683Ee3bc534Ea464` (all EVM).

## 4. Pricing & costs (real, executable — validated live)

- **DEX leg (per chain)** — `GET https://dln.debridge.finance/v1.0/chain/estimation`
  → `comparedAggregators[]` (1inch/0x/KyberSwap/OKX…) with `amount` + **`priceDrop` (bps impact)**,
  best `tokenOut.amount`, `recommendedSlippage`, `estimatedTransactionFee` (gas).
  ✅ live: $10k USDC→WETH on Arbitrum = 1inch best, 0 bps.
- **dePort redemption leg (the settlement rail the user wants)** — lock/mint or burn/claim, 1:1.
  Cost = flat native fee `getDebridgeChainAssetFixedFee(debridgeId, chainId)` (live; doc table as
  fallback: ~0.001 ETH ETH/Arb/Base/OP, 0.005 BNB, 0.015 SOL, 4 TRX…) + claim gas.
- (DLN `create-tx` cross-chain quote — a *different* solver rail — kept only as an optional
  "alternative execution" comparison, not the anchor.)

## 5. Arbitrage model (dePort-native)

Within a family (all members 1:1 redeemable to the native root):
1. **Redemption arb** — `marketPrice(deAsset @ chain X)` vs `marketPrice(native root @ home)`,
   both real `chain/estimation` DEX quotes, minus dePort move cost (fee + gas, both legs). If the
   deAsset trades below native − cost → buy deAsset → dePort-redeem to native → sell. (And the
   mint direction.)
2. **Cross-representation arb** — two deAsset reps of the *same family* on chains X, Y priced
   differently → route via the native hub (X → native → Y), summing dePort costs.

Output per opportunity: notional tier, gross spread %, itemized costs (DEX impact + dePort fee +
gas, both legs), **net edge %**, **net $**, the exact lock path, freshness. Rank by net edge.

Notionals scanned in tiers ($1k/$10k/$50k) since impact scales with size. Base = USDC.

(Optionally, clearly-labeled "soft" signal: cross-*family* same-underlying mispricings — NOT
1:1 redeemable, liquidity-only. Secondary, never mixed with redemption-anchored families.)

## 6. Scale → cycling background scanner

19 deBridge chains × thousands of tokens × pairs × tiers ≫ rate limits. So:
- Build/refresh lock-graph (cached, slow-changing).
- Prioritized work queue of `(family, chainX, chainY, tier)` — priority by liquidity, deAsset
  age, recent profitability.
- Budgeted scanner: N quotes/tick within an RPM budget (app has `DEBRIDGE_API_KEY`), backoff,
  TTL cache. Coverage achieved by **cycling**; UI shows freshness + coverage.

## 7. Coverage & honesty (shown in UI)

- **EVM dePort lock-graph first**: 16 EVM chains. **Solana & Tron** use different deAsset
  mechanics (SPL PDA / Tron VM) → Phase 3; flagged "not yet scanned," never silently dropped.
- The other ~19 chains in `chains.ts` aren't deBridge-quotable → "no executable data."
- Quotes are **real but time-sensitive**; `recommendedSlippage` shown. **Screener, not auto-executor.**
- Both-leg gas + dePort fee always subtracted.

## 8. Build plan (TDD; Supabase persistence — confirmed)

**Chain-id reconciliation (must-do first):** map app `chains.ts` ↔ deBridge internal chain ids
(add Tron `100000026`, Sei `100000027`, etc.; `dlnChainId`, `deBridgeGateAddress`, `dePortSupported`).

### Phase 1 — dePort lock-graph + real ranked view (EVM)
- `src/lib/onchain/multicall.ts` — Multicall3 client (eth_call batching) + per-chain RPC config. **Tests.**
- `src/lib/deport/graph.ts` — `getNativeInfo` enumeration → families keyed by debridgeId; origin
  normalization; cache. **Tests** (mock multicall).
- `src/lib/quotes/debridge.ts` — `chain/estimation` client (parse best route, impact, gas). **Tests (MSW).**
- `src/lib/deport/fees.ts` — `getDebridgeChainAssetFixedFee` live read + doc-table fallback. **Tests.**
- `src/lib/arb/edge.ts` — redemption + cross-rep net-edge math. **Tests.**
- `src/lib/arb/scanner.ts` — family × chain-pair × tier → executable edge. **Tests.**
- `src/app/api/arb/opportunities/route.ts` (GET ranked) + `src/app/api/arb/scan/route.ts` (budgeted batch).
- `src/app/arbitrage/page.tsx` + nav link: ranked table (Family/Origin │ Buy chain@price │ Sell
  chain@price │ Tier │ Gross % │ Costs │ **Net %** │ **Net $** │ Lock path │ Freshness), detail
  drawer (full cost + lock path), honest banner. Reuse existing table/loading/empty/error.

### Phase 2 — Comprehensive + Supabase
- Supabase schema: `families`, `deassets`, `opportunities`, `scan_runs`, `work_queue` (+ history/trends).
- `src/lib/arb/queue.ts` prioritized queue; cycling scanner (script and/or self-kicking route).
- `ScanStatus` UI (coverage / freshness / RPM budget). Opportunity history & “repeatedly profitable” view.

### Phase 3 — Non-EVM + depth
- Solana (SPL deAsset PDAs) + Tron lock-graph. Liquidity-depth gating. Optional DLN-route comparison.

## 9. Status of decisions
- Persistence: **Supabase** ✅ (confirmed).
- Sequencing: **Phase 1 first** recommended (real ranked view fast, then comprehensive) — awaiting confirm.
- Base USDC + tiers $1k/$10k/$50k (recommended).
