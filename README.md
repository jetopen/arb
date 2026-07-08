# arb-next — dePort cross-chain redemption arbitrage scanner

A solo-operator scanner that hunts **redemption arbitrage** across [deBridge](https://debridge.finance)'s **dePort** lock-and-mint bridge, with a live dashboard, an always-on background scanner, and a set of adversarial "does this edge actually exist?" backtests.

- **UI:** [arb-scanner-gamma.vercel.app](https://arb-scanner-gamma.vercel.app) (Next.js on Vercel)
- **Scanner:** a continuous GitHub Actions loop
- **Storage:** Supabase (Postgres)
- **Cost:** ~$0/month (public repo → unlimited Actions minutes; Vercel + Supabase free tiers)

> Heads-up (see [`AGENTS.md`](AGENTS.md)): this repo pins a **pre-release Next.js** whose APIs/conventions can differ from what you'd expect — check `node_modules/next/dist/docs/` before writing framework code.

---

## What it does

dePort mints a **wrapped "deAsset" representation** of a token on every destination chain, redeemable **1:1 by value** against the native token via the bridge. When the wrapped rep trades at a different price than the native token, there's a redemption arb:

```
buy TOKEN cheap on chain A  →  bridge 1:1 via dePort  →  sell the deTOKEN rep on chain B
```

The scanner builds the full graph of dePort **families** (a native token) and their **reps** (its wrapped representations across chains), then continuously prices **both legs** of every candidate route in both directions across a ladder of trade sizes ($10 → $100), scoring net edge after fees and price impact, and cross-checking survivors against independent sources before badging them.

### Status & findings (be honest with yourself)

The scanner works correctly, and the correct conclusion is that **the dePort redemption surface is a real liquidity ceiling**: of ~700 families, only ~75 have *ever* produced a two-sided quote, and the structurally-findable edges are all sub-$1.50 at executable size. This has been confirmed three independent ways — index data (GeckoTerminal/DexScreener), DEX aggregators (0x `0/896`, 1inch `0/616`), and raw on-chain event logs (HyperSync `0/507`, 502 of which have **zero** on-chain activity). The `backtest:*` scripts are the reproducible evidence. Treat this as a **monitoring + research tool**, not a money printer.

---

## Architecture

```
                         ┌─────────────────────────────────────────────┐
   dePort event index ──▶│  Graph build (src/lib/deport)               │
   + on-chain reads      │  families × reps × chains  (6h snapshot TTL) │
                         └───────────────┬─────────────────────────────┘
                                         │ enumerate: family × rep × direction × tier
                                         ▼
                         ┌─────────────────────────────────────────────┐
                         │  Work queue (Supabase)                      │
                         │  HOT lane (proven routes, fast refresh)     │
                         │  COLD lane (discovery sweep of dead reps)   │
                         │  dead-route backoff · RPM budget · leasing  │
                         └───────────────┬─────────────────────────────┘
                                         │ dequeue batch
                                         ▼
   quote sources ──────▶ ┌─────────────────────────────────────────────┐
   Kyber (primary scan)  │  scanUnit (src/lib/arb/scanner.ts)          │
   deBridge (6 chains)   │  liquidity prefilter → buy leg → rescale     │
   Jupiter (Solana)      │                                             │
                         │  → sell leg → edge → verify → simulate        │
   verify sources ─────▶ │                                             │
   Kyber / GeckoTerminal │  Verification: independent price + liquidity │
   0x (fallback)         │  cross-check; badges verified / routable     │
                         └───────────────┬─────────────────────────────┘
                                         │ opportunities
                                         ▼
                  Supabase  ◀──▶  Next.js API routes  ◀──▶  Dashboard + Discord/Telegram alerts
```

**Key mechanisms**

- **Two-lane queue** — a HOT lane keeps proven routes fresh inside the UI's read window; a COLD lane sweeps the ~8.7k mostly-dead reps with leftover budget. Dead routes get exponential backoff (6h·2ⁿ, capped 72h); *transient* failures (5xx/429/network) get a short 10-min retry and never count as dead.
- **RPM budget** — a shared token bucket (`ARB_SCAN_RPM`) throttles all aggregator calls.
- **Liquidity prefilter** — a cached GeckoTerminal check skips reps with no indexed pool for zero quote spend (fail-open; can't hide a live route).
- **Verification** — profitable candidates are only badged when an *independent* source corroborates both price and liquidity, killing phantom edges. Independence is source-aware: Kyber-scanned chains cross-check against deBridge estimation, others against KyberSwap or GeckoTerminal, all with a 0x routability fallback.
- **Quote routing** (`src/lib/quotes/scan-quote.ts`) — KyberSwap (key-free) is the primary scan source on its 10 chains; deBridge estimation covers the rest (HyperEVM/Sei/Flow/Monad/MegaETH/Tron); Jupiter handles Solana; an optional 1inch rung rescues isolated Kyber blips (needs `ONEINCH_API_KEY`).

---

## Tech stack

| Area | Tech |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling / UI | Tailwind CSS 4, Recharts, lucide-react |
| Data fetching | SWR |
| Chain reads | viem (EVM), bs58 (Solana/Tron address codecs) |
| Storage | Supabase (`@supabase/supabase-js`) — falls back to in-memory without creds |
| Validation | Zod |
| Runtime / tooling | tsx (script runner), Vitest, Playwright, ESLint |

Chains covered by the dePort graph include the EVM majors (Ethereum, Optimism, BNB, Polygon, Base, Arbitrum, Avalanche, Linea) and newer L1/L2s (HyperEVM/Hyperliquid, Monad, Sei, Mantle, Cronos, Flow, MegaETH, Story, Injective), plus **Solana** and **Tron** as quote-only.

---

## Project structure

```
src/
  app/                       Next.js App Router
    page.tsx                 landing
    arbitrage/               main opportunities dashboard
    tokens/  analytics/  settings/
    layerzero/  symbiosis/   adjacent research surfaces (OFT tracker, Symbiosis)
    api/                     route handlers (arb, lz, health, stats, …)
  lib/
    arb/                     scanner, scan-service, queue budget, optimizer, prefilter
    deport/                  chain registry, graph build, fees, address codecs
    quotes/                  deBridge, jupiter, kyberswap, zerox, 1inch, native-price
    liquidity/               GeckoTerminal client
    hypersync/               Envio on-chain activity client (research; dormant)
    layerzero/               LayerZero OFT tracker
    sim/                     tx simulation (eth_call state-override)
    db/                      Supabase + in-memory Store
    alerts/                  Discord / Telegram / webhook notifications
scripts/                     scan-once, scan-loop, backtest-*, probes
supabase/migrations/         SQL schema + RPCs (0001 … 0015)
.github/workflows/           scan.yml (scanner loop), ci.yml
```

---

## Getting started

**Prerequisites:** Node 22.x, npm.

```bash
npm install
cp .env.local.example .env.local   # if present; otherwise create .env.local (see below)
npm run dev                        # http://localhost:3000
```

Without Supabase credentials the app runs against an **in-memory store** — fine for local UI work, but the scanner won't persist between runs.

### Run the scanner locally

```bash
npm run scan:once     # one batch, then exit
npm run scan:loop     # continuous loop (what production runs)
```

Both need `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to persist. Optional API keys improve quote/verify coverage (see below).

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `start` | production build / serve |
| `npm run scan:once` | run one scan batch and exit (cron-style) |
| `npm run scan:loop` | continuous self-restarting scan loop (production worker) |
| `npm run backtest:0x` | measure dead-route recovery via the 0x aggregator |
| `npm run backtest:1inch` | same, via 1inch (dormant module) |
| `npm run backtest:hypersync` | sweep raw on-chain Transfer activity for dead reps (Envio HyperSync) |
| `npm run test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

The `backtest:*` scripts are **read-only** and gated on their respective API keys — they answer "does quote source X (or on-chain activity) surface any edge the scanner is missing?" with a hard number.

---

## Configuration

Set these in `.env.local` (local) or as **GitHub Actions secrets / vars** (scanner) and **Vercel env** (UI). `.env.local` is gitignored — never commit keys.

**Required to persist (scanner + server-side reads)**

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (selects the Postgres store) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |

**Optional API keys** (each degrades gracefully if absent)

| Var | Purpose |
|---|---|
| `DEBRIDGE_API_KEY` | higher deBridge estimation rate limits (residual chains + verify cross-check) |
| `ZEROX_API_KEY` | 0x routability fallback in the verifier (`verified(0x)`) |
| `JUPITER_API_KEY` | Jupiter pro API for Solana quotes (else free lite tier) |
| `ONEINCH_API_KEY` | enables the optional 1inch last-resort scan fallback (also used by its backtest) |
| `ONEINCH_API_KEY` | 1inch — **backtest only**, not wired into scanning |
| `ENVIO_API_TOKEN` | HyperSync activity sweep — **backtest only** (get one at [envio.dev/app/api-tokens](https://envio.dev/app/api-tokens)) |
| `SOLANA_RPC_URL`, `TRON_RPC_URL`, `RPC_URL_<chainId>` | on-chain reads / simulation |

**Alerts (optional)**

| Var | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | server-side opportunity alerts |
| `ARB_ALERT_MIN_SPREAD_PCT` | alert threshold (else only net-profitable rows) |
| `NEXT_PUBLIC_TELEGRAM_BOT_TOKEN` / `_CHAT_ID` / `NEXT_PUBLIC_WEBHOOK_URL` | client-side alert routing |

**Selected tuning knobs** (sensible defaults; full set: `grep -rho 'process\.env\.[A-Z_]*' src scripts`)

| Var | Default | Purpose |
|---|---|---|
| `ARB_SCAN_N` | 24 / 48 | units dequeued per batch |
| `ARB_SCAN_RPM` | 120 | shared aggregator rate budget (all sources; Kyber adds its own RPS throttle) |
| `ARB_SCAN_CONCURRENCY` | 8 | parallel scan workers |
| `ARB_SCAN_KYBER` | on | `false` reverts the scan source to deBridge on all EVM chains |
| `ARB_KYBER_RPS` | 5 | Kyber per-source burst-smoothing throttle |
| `ARB_SCAN_1INCH_FALLBACK` | on (needs key) | `false` disables the 1inch last-resort rung |
| `ARB_SCAN_SLIPPAGE_FLOOR_BPS` | 50 | conservative-haircut floor for sources returning no slippage rec |
| `ARB_SCAN_NOTIONAL_USD` | `10,25,50,100` | trade-size ladder |
| `ARB_HOT_MIN_INTERVAL_MS` | 600000 | hot-lane refresh floor |
| `ARB_PREFILTER` | on | `false` disables the liquidity prefilter |
| `ARB_SCAN_SOLANA` | on | Solana leg kill-switch |
| `ARB_SIMULATE` | off | enable tx simulation of the executable path |
| `CRON_SECRET` | — | protects the scan/ingest API routes |

---

## Deployment ($0 topology)

- **Scanner → GitHub Actions.** [`.github/workflows/scan.yml`](.github/workflows/scan.yml) runs `scan:loop` as a continuous ~5.5h job (under GitHub's 6h cap) that **self-restarts** via a `concurrency` guard — scheduled `*/10` ticks (and an optional local `workflow_dispatch` trigger) queue a single pending run that starts the instant the current one ends. Scheduled workflows only fire on the **default branch**, so the deployed branch must be the repo default. A public repo gets **unlimited** Actions minutes; if it ever goes private, revert to `scan:once` on a `*/30` schedule (2,000 free min/mo).
- **UI → Vercel.** Standard Next.js deploy; set the Supabase + `NEXT_PUBLIC_*` env in Vercel.
- **DB → Supabase.** Apply [`supabase/migrations/`](supabase/migrations) in order. Migrations are drift-guarded (`if not exists`) to tolerate a live DB that skipped an earlier one.

---

## Testing

```bash
npm run test        # Vitest — pure parsers, quote clients, queue logic, verifier
npm run typecheck
```

External clients (deBridge, Kyber, 0x, 1inch, Jupiter, HyperSync) are tested with stubbed `fetch` and pure parse functions, so the suite runs offline and deterministically.

---

## Research tooling & adjacent surfaces

The `backtest:*` scripts and the `layerzero/` + `symbiosis/` UI surfaces are exploration into whether *any* adjacent bridge or quote source breaks the redemption ceiling. The verdict so far: none do at small size. The one genuinely different lever identified — a **Hyperliquid funding-rate / spot-perp basis monitor** (market-neutral carry, not peg-gap redemption) — is not yet built.

---

*Private research project. No warranty; nothing here is financial advice — arbitrage carries execution, bridge, and smart-contract risk.*
