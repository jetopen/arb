// probe-hyperliquid-arb.mjs — HyperCore <-> HyperEVM spot divergence scanner.
//
// For every token LINKED on both layers (evmContract != null), compares:
//   • Core side:  the HyperCore orderbook mid for the token's USDC spot pair
//                 (api.hyperliquid.xyz/info  spotMetaAndAssetCtxs), and
//   • EVM side:   the token's HyperEVM AMM price (DefiLlama coins API, which
//                 aggregates that ERC20's HyperEVM pools into a USD price + a
//                 liquidity-confidence score).
// Ranks by |divergence| net of an assumed round-trip cost, so the saturated
// deep pairs (HYPE etc.) fall to ~0 and any surviving manual edge in the thin
// linked tail floats to the top.
//
// Mechanism verified live 2026-06-15: the cross-layer transfer is an intra-state
// move (~1-2s/leg), NOT a bridge — so a flagged gap is mechanically closeable.
// BUT the deep pairs are bot-saturated; treat sub-0.3% gaps as noise. Flagged
// candidates still need a TIER-2 check (executable l2Book BBO + AMM pool depth)
// before trading — divergence here is mid-vs-mid, not slippage-inclusive.
//
// No auth. Run:  node scripts/probe-hyperliquid-arb.mjs

const CONFIG = {
  infoUrl: "https://api.hyperliquid.xyz/info",
  llamaBase: "https://coins.llama.fi/prices/current",
  llamaChain: "hyperliquid", // DefiLlama slug for HyperEVM (verified)
  whype: "0x5555555555555555555555555555555555555555", // HYPE's EVM proxy (native -> wrapped)
  usdcTokenIndex: 0, // quote leg for "USD" pairs
  roundTripCostPct: 0.12, // ~0.07% Core taker + ~0.05% deep-AMM fee; tail tokens are higher
  flagPct: 0.5, // surface gaps above this (net) as worth a tier-2 depth check
  llamaConfidenceFloor: 0.9, // DefiLlama price confidence ~ liquidity quality
  llamaChunk: 50,
  topN: 25,
};

const info = async (body) => {
  const r = await fetch(CONFIG.infoUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`info ${body.type} -> HTTP ${r.status}`);
  return r.json();
};

const pct = (n) => (n === null || !isFinite(n) ? "n/a" : (n >= 0 ? "+" : "") + n.toFixed(3) + "%");
const usd = (n) => (n === null || !isFinite(n) ? "n/a" : "$" + n.toLocaleString("en-US", { maximumFractionDigits: n < 0.01 ? 8 : 4 }));

async function llamaPrices(addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += CONFIG.llamaChunk) {
    const chunk = addrs.slice(i, i + CONFIG.llamaChunk);
    const key = chunk.map((a) => `${CONFIG.llamaChain}:${a}`).join(",");
    try {
      const r = await fetch(`${CONFIG.llamaBase}/${key}`);
      const j = await r.json();
      for (const [k, v] of Object.entries(j.coins || {})) {
        out.set(k.split(":")[1].toLowerCase(), { price: v.price, confidence: v.confidence, symbol: v.symbol });
      }
    } catch (e) {
      console.error(`  llama chunk ${i} failed: ${e.message}`);
    }
  }
  return out;
}

async function main() {
  console.log("=".repeat(96));
  console.log("HYPERLIQUID  HyperCore(orderbook) <-> HyperEVM(AMM)  SPOT DIVERGENCE SCAN");
  console.log("=".repeat(96));

  // NOTE: spotMetaAndAssetCtxs ctxs[] is NOT index-aligned to universe[] (different
  // lengths/order) — use allMids, which keys every spot pair by its name ("@<index>"
  // or canonical "BASE/USDC"). Verified: allMids["@107"]==HYPE/USDC mid, matches l2Book.
  const meta = await info({ type: "spotMeta" });
  const mids = await info({ type: "allMids" });
  const tokens = meta.tokens || [];
  const universe = meta.universe || [];

  const linked = tokens.filter((t) => t.evmContract && t.evmContract.address);
  console.log(`tokens: ${tokens.length} | linked (round-trippable): ${linked.length} | spot pairs: ${universe.length}`);

  // Core USDC-quoted mid per base token, looked up by pair NAME in allMids.
  const coreUsd = new Map(); // baseTokenIndex -> mid in USDC (~USD)
  for (const u of universe) {
    if (!u || u.tokens[1] !== CONFIG.usdcTokenIndex) continue; // only USDC-quoted -> USD
    const px = mids[u.name];
    const mid = px != null ? Number(px) : null;
    if (mid && isFinite(mid) && mid > 0) coreUsd.set(u.tokens[0], mid);
  }

  // EVM prices via DefiLlama for all linked ERC20s (+ WHYPE for HYPE baseline)
  const evmAddrs = linked.map((t) => t.evmContract.address.toLowerCase());
  evmAddrs.push(CONFIG.whype.toLowerCase());
  const evm = await llamaPrices([...new Set(evmAddrs)]);
  console.log(`DefiLlama returned EVM prices for ${evm.size}/${new Set(evmAddrs).size} addresses\n`);

  // Alignment validation: HYPE Core mid vs WHYPE EVM price should match (~same asset)
  const hype = tokens.find((t) => t.name === "HYPE");
  const hypeCore = hype ? coreUsd.get(hype.index) : null;
  const whypeEvm = evm.get(CONFIG.whype.toLowerCase())?.price ?? null;
  if (hypeCore && whypeEvm) {
    const d = (hypeCore / whypeEvm - 1) * 100;
    const ok = Math.abs(d) < 5;
    console.log(`ALIGNMENT CHECK — HYPE: Core ${usd(hypeCore)} vs EVM(WHYPE) ${usd(whypeEvm)}  diff ${pct(d)}  ${ok ? "✓ scan trustworthy" : "✗ Core midPx misaligned — fall back to l2Book"}`);
  } else {
    console.log("ALIGNMENT CHECK — could not resolve HYPE on both sides");
  }
  console.log("-".repeat(96));

  // Build comparison rows
  const rows = [];
  for (const t of linked) {
    const core = coreUsd.get(t.index);
    const e = evm.get(t.evmContract.address.toLowerCase());
    if (!core || !e || !e.price) continue;
    const divergence = (e.price / core - 1) * 100; // EVM relative to Core
    rows.push({
      name: t.name,
      core,
      evm: e.price,
      conf: e.confidence ?? 0,
      divergence,
      absNet: Math.abs(divergence) - CONFIG.roundTripCostPct,
      dir: divergence > 0 ? "buy Core → sell EVM" : "buy EVM → sell Core",
    });
  }
  // HYPE baseline (evmContract null -> use WHYPE)
  if (hypeCore && whypeEvm) {
    const divergence = (whypeEvm / hypeCore - 1) * 100;
    rows.push({ name: "HYPE", core: hypeCore, evm: whypeEvm, conf: evm.get(CONFIG.whype.toLowerCase())?.confidence ?? 0, divergence, absNet: Math.abs(divergence) - CONFIG.roundTripCostPct, dir: divergence > 0 ? "buy Core → sell EVM" : "buy EVM → sell Core" });
  }

  rows.sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));
  const tradable = rows.filter((r) => r.conf >= CONFIG.llamaConfidenceFloor);

  console.log(`Compared ${rows.length} linked tokens with prices on BOTH sides (${tradable.length} at confidence >= ${CONFIG.llamaConfidenceFloor}).`);
  console.log(`Round-trip cost assumed ${CONFIG.roundTripCostPct}%. Showing top ${CONFIG.topN} by |divergence| (conf-gated):\n`);
  console.log(`  ${"TOKEN".padEnd(12)} ${"CORE".padStart(14)} ${"EVM".padStart(14)} ${"DIVERG".padStart(10)} ${"NET".padStart(9)}  CONF  DIRECTION`);
  for (const r of tradable.slice(0, CONFIG.topN)) {
    const flag = r.absNet > CONFIG.flagPct ? "  ◀ FLAG" : "";
    console.log(`  ${r.name.padEnd(12)} ${usd(r.core).padStart(14)} ${usd(r.evm).padStart(14)} ${pct(r.divergence).padStart(10)} ${pct(r.absNet).padStart(9)}  ${r.conf.toFixed(2)}  ${r.dir}${flag}`);
  }

  const flagged = tradable.filter((r) => r.absNet > CONFIG.flagPct && r.name !== "HYPE");
  console.log("\n" + "-".repeat(96));
  if (flagged.length) {
    console.log(`${flagged.length} candidate(s) with net gap > ${CONFIG.flagPct}% AND real liquidity — TIER-2 check next (l2Book executable BBO + AMM pool depth):`);
    for (const r of flagged) console.log(`  • ${r.name}: ${pct(r.divergence)} gross (${pct(r.absNet)} net), ${r.dir}`);
  } else {
    console.log(`No linked token shows a net gap > ${CONFIG.flagPct}% at confidence >= ${CONFIG.llamaConfidenceFloor}.`);
    console.log(`→ Consistent with the saturation finding: deep pairs are bot-arbed to within fees; tail gaps are mostly low-confidence (thin/no EVM liquidity), not executable edge.`);
  }
  console.log("-".repeat(96));
  console.log("NOTE: divergence is mid-vs-mid, and the EVM side (DefiLlama) is frequently STALE / from an outlier pool.");
  console.log("      Verified false positives (2026-06-15): FXRP/USOL/KHYPE/PURR/JEFF all collapsed to <1% vs the REAL");
  console.log("      deepest pool. A flag must clear a TIER-2 check: Core l2Book depth+spread AND the deepest HyperEVM");
  console.log("      pool (GeckoTerminal /tokens/{addr}/pools, or on-chain slot0) at your notional before it is edge.");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
