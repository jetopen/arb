// Probe which deBridge chains we can actually QUOTE, to widen the scanner beyond the chains already in
// BASE_USDC. For every chain that has families in the lock-graph but no USDC base yet, it:
//   1. pulls a sample deAsset rep on that chain (from arb_families),
//   2. auto-discovers the chain's stablecoin from the deBridge token-list (USDC/USDT/…),
//   3. live-probes GET /v1.0/chain/estimation (USDC → that rep) — the exact call the scanner makes,
//   4. reports PASS (with a ready-to-paste BASE_USDC line) or SKIP (with the reason), e.g. Injective 500s.
//
// Read-only: it prints recommendations; you paste the PASS lines into src/lib/arb/base-tokens.ts. No
// silent caps — every candidate chain is listed as PASS or SKIP.
//
// Usage:
//   node scripts/probe-quotable-chains.mjs                 # probe all candidate chains
//   node scripts/probe-quotable-chains.mjs 100000022 250   # probe only these internal chain ids

import nextEnv from "@next/env";
try {
  nextEnv?.loadEnvConfig?.(process.cwd(), true);
} catch {
  /* prod: env already present */
}
import { createClient } from "@supabase/supabase-js";

const DLN = "https://dln.debridge.finance";
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Chains already wired in src/lib/arb/base-tokens.ts (BASE_USDC) — skip them. Keep in sync if you add more.
const ALREADY_QUOTABLE = new Set([
  1, 10, 56, 137, 8453, 42161, 43114, 59144, 100000019, 100000023, 7565164,
  100000022, 100000026, 100000027, 100000009, 100000030, 100000031, // added this sweep: HyperEVM, Tron, Sei, Flow, Monad, MegaETH
]);
// Aggregator has no route here (proven live) — don't bother re-probing unless deBridge adds coverage.
const KNOWN_DEAD = new Set([100000029]); // Injective

// Stablecoin symbols we accept as a quote base, best first.
const STABLE_PREF = ["USDC", "USDC.E", "USDCE", "USDBC", "USDT", "USDT0", "AXLUSDC", "USDC.e"];
const argChains = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tokenList(internalChainId) {
  try {
    const res = await fetch(`${DLN}/v1.0/token-list?chainId=${internalChainId}`);
    if (!res.ok) return [];
    const json = await res.json();
    return Object.entries(json.tokens ?? {}).map(([addr, m]) => ({
      address: m.address ?? addr,
      symbol: (m.symbol ?? "").toString(),
      decimals: m.decimals,
    }));
  } catch {
    return [];
  }
}

function pickStable(tokens) {
  for (const want of STABLE_PREF) {
    const hit = tokens.find((t) => t.symbol.toUpperCase() === want.toUpperCase());
    if (hit && Number.isInteger(hit.decimals)) return hit;
  }
  return null;
}

async function estimate(chainId, tokenIn, amountIn, tokenOut) {
  const url = `${DLN}/v1.0/chain/estimation?chainId=${chainId}&tokenIn=${tokenIn}&tokenInAmount=${amountIn}&tokenOut=${tokenOut}`;
  try {
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, why: json?.errorId || `HTTP ${res.status}` };
    const out = json?.estimation?.tokenOut?.amount;
    if (!out || out === "0") return { ok: false, why: "no route / amountOut 0" };
    return { ok: true, out, outUsd: json?.estimation?.tokenOut?.approximateUsdValue };
  } catch (e) {
    return { ok: false, why: e?.message ?? "fetch failed" };
  }
}

(async () => {
  // Pull every family's reps; build a sample rep (address+decimals+symbol) per chain.
  const { data, error } = await db.from("arb_families").select("native_chain_id,reps");
  if (error) {
    console.error("supabase read failed:", error.message);
    process.exit(1);
  }
  const sampleRep = new Map(); // chainId -> { address, decimals, symbol }
  const famCount = new Map(); // chainId -> distinct families touching it
  for (const f of data ?? []) {
    for (const r of f.reps ?? []) {
      const c = Number(r.internalChainId);
      famCount.set(c, (famCount.get(c) ?? 0) + 1);
      if (!sampleRep.has(c) && r.address && Number.isInteger(r.decimals)) {
        sampleRep.set(c, { address: r.address, decimals: r.decimals, symbol: r.symbol ?? "?" });
      }
    }
  }

  let candidates = [...sampleRep.keys()].filter((c) => !ALREADY_QUOTABLE.has(c) && !KNOWN_DEAD.has(c));
  if (argChains.length) candidates = argChains;
  candidates.sort((a, b) => (famCount.get(b) ?? 0) - (famCount.get(a) ?? 0));

  console.log(`Probing ${candidates.length} candidate chains (most families first)\n`);
  const pass = [];
  const skip = [];
  for (const chain of candidates) {
    const rep = sampleRep.get(chain);
    if (!rep) {
      skip.push([chain, "no sample rep with known decimals"]);
      continue;
    }
    const tokens = await tokenList(chain);
    const stable = pickStable(tokens);
    if (!stable) {
      skip.push([chain, `no stablecoin in token-list (${tokens.length} tokens)`]);
      await sleep(250);
      continue;
    }
    const amountIn = (10n ** BigInt(stable.decimals) * 100n).toString(); // $100
    const r = await estimate(chain, stable.address, amountIn, rep.address);
    if (r.ok) {
      pass.push([chain, stable, rep, r]);
      console.log(`  PASS ${chain}: $100 ${stable.symbol} -> ${rep.symbol} = ${r.outUsd ?? "?"}usd (${famCount.get(chain)} reps)`);
    } else {
      skip.push([chain, `estimation: ${r.why}`]);
      console.log(`  SKIP ${chain}: ${r.why} (stable ${stable.symbol})`);
    }
    await sleep(350);
  }

  console.log(`\n=== ${pass.length} PASS — paste into BASE_USDC (src/lib/arb/base-tokens.ts) ===`);
  for (const [chain, stable] of pass) {
    console.log(`  ${chain}: { address: "${stable.address}", decimals: ${stable.decimals} }, // ${stable.symbol} (live-probed)`);
  }
  console.log(`\n=== ${skip.length} SKIP ===`);
  for (const [chain, why] of skip) console.log(`  ${chain}: ${why}`);
  process.exit(0);
})().catch((e) => {
  console.error("probe failed:", e?.message ?? e);
  process.exit(1);
});
