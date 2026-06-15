// cross-venue-scanner/scan.mjs
// uyar121-style manual-arb screener: CoinGecko top MOVERS -> tokens listed on >=2
// venues -> cross-venue price GAPS (CEX<->CEX or CEX<->DEX), gated by depth/spread.
//
// This is NOT a structural-mechanism arb (those are stranded or bot-saturated — see
// the dePort/Hyperliquid notes). It mirrors the documented manual method: a sharp
// move shakes a thin micro-cap's price out of sync across the venues it trades on,
// and the gap persists because the venues are obscure / withdrawals are gated / no
// bot bridges them. The scanner finds the gap + how much you could move; YOU must
// still confirm the cheap venue allows withdrawal and the expensive venue deposit
// of that exact asset/network (the stuck-funds trap that kills most of these).
//
// Free, no-auth (CoinGecko public API). Run:  node cross-venue-scanner/scan.mjs
//
// CoinGecko fields used (verified live 2026-06-15):
//   /coins/markets            -> id, symbol, price_change_percentage_24h, total_volume, market_cap
//   /coins/{id}/tickers?depth=true -> per market: market.name, base/target, converted_last.usd,
//       converted_volume.usd, bid_ask_spread_percentage, cost_to_move_up_usd/down_usd (±2% depth),
//       is_stale, is_anomaly, trust_score, trade_url

const CG = "https://api.coingecko.com/api/v3";

const CONFIG = {
  pages: 4,                 // /coins/markets pages to scan (250/page) -> 1000 coins
  moverMinAbsPct: 10,       // |24h change| band (uyar: ±10–50%)
  moverMaxAbsPct: 60,
  marketMcapMinUsd: 300_000,    // skip dust
  marketMcapMaxUsd: 2_000_000_000, // bias toward micro/small caps where gaps persist
  coinMinVolUsd: 200_000,   // coin must have real aggregate 24h volume
  topMovers: 24,            // how many movers to deep-scan (tickers call each)

  // per-venue gates
  venueMinVolUsd: 20_000,   // ignore dead markets
  venueMaxSpreadPct: 2.0,   // ignore wide-spread (illiquid) books
  venueMinDepthUsd: 300,    // ignore venues you can't move >$300 within 2%

  gapFlagPct: 2.5,          // flag cross-venue gaps above this (gross)
  suspectMaxGapPct: 20,     // gaps bigger than this are ~always same-ticker-different-token or stale, not edge
  roundTripCostPct: 0.8,    // ~0.2% buy + 0.2% sell + ~0.4% withdrawal/slippage buffer
  reqSpacingMs: 2600,       // spacing to respect CoinGecko free rate limit (~30/min)
  topN: 30,
};

// fiat targets -> a gap vs a fiat pair is usually a regional premium (e.g. kimchi/KRW),
// gated by capital controls, NOT a freely-arbable token gap.
const FIAT = new Set(["KRW","TRY","IDR","EUR","JPY","BRL","RUB","INR","UAH","NGN","VND","GBP","AUD","CAD","ARS","ZAR","PLN","THB","MXN","PHP","CHF","HKD","SGD","AED"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n) => (n == null || !isFinite(n) ? "n/a" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%");
const usd = (n) => {
  if (n == null || !isFinite(n)) return "n/a";
  if (n !== 0 && Math.abs(n) < 1e-4) return "$" + Number(n).toPrecision(3); // sub-cent tokens
  return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
};
const money = (n) => (n == null || !isFinite(n) ? "?" : "$" + Math.round(n).toLocaleString("en-US"));

async function cg(path) {
  const r = await fetch(`${CG}${path}`, { headers: { accept: "application/json" } });
  if (r.status === 429) { await sleep(8000); return cg(path); } // back off once on rate limit
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

const isDex = (name, base, target) =>
  /0x[0-9a-fA-F]{6}/.test(`${base}${target}`) ||
  /\b(swap|uniswap|pancake|sushi|curve|balancer|aerodrome|velodrome|raydium|orca|camelot|quick|trader ?joe|ramses|kitten|hyperswap|clmm|dex|amm)\b/i.test(name) ||
  /\([^)]+\)$/.test(name); // "Name (Chain)" suffix

async function getMovers() {
  const all = [];
  for (let p = 1; p <= CONFIG.pages; p++) {
    const rows = await cg(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&price_change_percentage=24h`);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    await sleep(CONFIG.reqSpacingMs);
  }
  return all
    .filter((c) => {
      const ch = Math.abs(c.price_change_percentage_24h || 0);
      return (
        ch >= CONFIG.moverMinAbsPct && ch <= CONFIG.moverMaxAbsPct &&
        (c.total_volume || 0) >= CONFIG.coinMinVolUsd &&
        (c.market_cap || 0) >= CONFIG.marketMcapMinUsd &&
        (c.market_cap || 0) <= CONFIG.marketMcapMaxUsd
      );
    })
    .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h))
    .slice(0, CONFIG.topMovers);
}

function analyzeCoin(coin, tickers) {
  const venues = (tickers || [])
    .filter((t) => !t.is_stale && !t.is_anomaly && t.converted_last?.usd > 0)
    .map((t) => {
      const upd = t.cost_to_move_up_usd, dn = t.cost_to_move_down_usd;
      const depth = upd != null && dn != null ? Math.min(upd, dn) : (upd ?? dn ?? null);
      return {
        name: t.market?.name || "?",
        pair: `${t.base}/${t.target}`,
        target: t.target,
        price: t.converted_last.usd,
        vol: t.converted_volume?.usd ?? 0,
        spread: t.bid_ask_spread_percentage,
        depthUp: upd, depthDn: dn, depth,
        dex: isDex(t.market?.name || "", t.base || "", t.target || ""),
        url: t.trade_url,
      };
    })
    .filter((v) =>
      v.vol >= CONFIG.venueMinVolUsd &&
      (v.spread == null || v.spread <= CONFIG.venueMaxSpreadPct) &&
      (v.depth == null || v.depth >= CONFIG.venueMinDepthUsd)
    );

  if (venues.length < 2) return null;

  // cheap (buy) = min price with buy-side depth; rich (sell) = max price with sell-side depth
  const buy = venues.reduce((a, b) => (b.price < a.price ? b : a));
  const sell = venues.reduce((a, b) => (b.price > a.price ? b : a));
  if (buy.name === sell.name) return null;

  const grossPct = (sell.price / buy.price - 1) * 100;
  const netPct = grossPct - CONFIG.roundTripCostPct;
  // tradable size before the gap collapses ~ min(buy-side up-depth, sell-side down-depth)
  const size = Math.min(buy.depthUp ?? Infinity, sell.depthDn ?? Infinity);
  const fiat = FIAT.has((buy.target || "").toUpperCase()) || FIAT.has((sell.target || "").toUpperCase());
  const suspect = grossPct > CONFIG.suspectMaxGapPct; // implausible gap => likely same-ticker-different-token / stale
  return {
    symbol: coin.symbol?.toUpperCase(), id: coin.id, change24h: coin.price_change_percentage_24h,
    mcap: coin.market_cap, nVenues: venues.length, buy, sell, grossPct, netPct,
    size: isFinite(size) ? size : null,
    kind: buy.dex || sell.dex ? (buy.dex && sell.dex ? "DEX↔DEX" : "CEX↔DEX") : "CEX↔CEX",
    fiat, suspect,
  };
}

async function main() {
  console.log("=".repeat(100));
  console.log("CROSS-VENUE MOVER ARB SCANNER (uyar121 method)  —  CoinGecko, no-auth");
  console.log(`band ±${CONFIG.moverMinAbsPct}-${CONFIG.moverMaxAbsPct}% 24h | mcap ${money(CONFIG.marketMcapMinUsd)}-${money(CONFIG.marketMcapMaxUsd)} | gates: vol≥${money(CONFIG.venueMinVolUsd)} spread≤${CONFIG.venueMaxSpreadPct}% depth≥${money(CONFIG.venueMinDepthUsd)}`);
  console.log("=".repeat(100));

  const movers = await getMovers();
  console.log(`Found ${movers.length} movers in band. Deep-scanning venues (spaced ~${CONFIG.reqSpacingMs}ms for rate limit)...\n`);

  const results = [];
  for (const c of movers) {
    await sleep(CONFIG.reqSpacingMs);
    let t;
    try { t = await cg(`/coins/${c.id}/tickers?depth=true`); }
    catch (e) { console.error(`  ${c.symbol}: tickers failed (${e.message})`); continue; }
    const a = analyzeCoin(c, t.tickers);
    if (a) results.push(a);
    process.stdout.write(`  scanned ${c.symbol?.toUpperCase()} (${pct(c.price_change_percentage_24h)})${a ? ` gap ${pct(a.grossPct)} [${a.kind}]` : " — <2 gated venues"}\n`);
  }

  results.sort((a, b) => b.netPct - a.netPct);
  // clean candidates = real same-token, freely-arbable gaps (exclude suspect cross-listings + fiat premiums)
  const flagged = results.filter((r) => r.grossPct >= CONFIG.gapFlagPct && r.netPct > 0 && !r.suspect && !r.fiat);

  console.log("\n" + "=".repeat(100));
  console.log(`CROSS-VENUE GAPS (net of ~${CONFIG.roundTripCostPct}% round-trip cost), ranked:`);
  console.log("=".repeat(100));
  for (const r of results.slice(0, CONFIG.topN)) {
    const tag = r.suspect ? " ⚠SUSPECT(same-ticker?/stale)" : r.fiat ? " ⚑FIAT-premium(not freely arbable)" : (r.grossPct >= CONFIG.gapFlagPct && r.netPct > 0 ? " ◀ FLAG" : "");
    console.log(
      `${r.symbol.padEnd(10)} ${pct(r.change24h).padStart(8)} 24h | ${r.kind.padEnd(8)} | gross ${pct(r.grossPct).padStart(8)} net ${pct(r.netPct).padStart(8)} | ~${money(r.size).padStart(9)} tradable${tag}`
    );
    console.log(`   BUY  ${r.buy.name} @ ${usd(r.buy.price)} (${r.buy.pair}) depth↑${money(r.buy.depthUp)} spr ${r.buy.spread?.toFixed?.(2) ?? "?"}%`);
    console.log(`   SELL ${r.sell.name} @ ${usd(r.sell.price)} (${r.sell.pair}) depth↓${money(r.sell.depthDn)} spr ${r.sell.spread?.toFixed?.(2) ?? "?"}%`);
  }

  const suspects = results.filter((r) => r.suspect);
  const fiats = results.filter((r) => r.fiat && !r.suspect && r.grossPct >= CONFIG.gapFlagPct);
  if (suspects.length) console.log(`\nExcluded as SUSPECT (gap > ${CONFIG.suspectMaxGapPct}% ⇒ almost always same-ticker-different-token or stale): ${suspects.map((r) => `${r.symbol} ${pct(r.grossPct)}`).join(", ")}`);
  if (fiats.length) console.log(`Excluded as FIAT regional-premium (kimchi-style, capital-controlled): ${fiats.map((r) => `${r.symbol} ${pct(r.grossPct)}`).join(", ")}`);

  console.log("\n" + "-".repeat(100));
  if (flagged.length) {
    console.log(`${flagged.length} candidate(s) with gross gap ≥ ${CONFIG.gapFlagPct}% AND positive net — MANUAL CHECKS before trading:`);
    for (const r of flagged) console.log(`  • ${r.symbol} (${r.kind}): buy ${r.buy.name} ${usd(r.buy.price)} → sell ${r.sell.name} ${usd(r.sell.price)}, net ${pct(r.netPct)}, ~${money(r.size)} size`);
    console.log("\n  ⚠ STUCK-FUNDS GATE (the trap that kills most of these — CoinGecko can't check it):");
    console.log("    1. Does the BUY venue allow WITHDRAWAL of this token on a network the SELL venue accepts for DEPOSIT?");
    console.log("    2. Same canonical asset/contract on both sides (not a same-ticker different token)?");
    console.log("    3. Withdrawal fee + network fee < the net gap at your size?  4. Re-pull prices — movers reprice fast.");
  } else {
    console.log(`No mover shows a gross gap ≥ ${CONFIG.gapFlagPct}% with positive net across ≥2 liquid venues right now.`);
    console.log("→ Normal: most cross-venue gaps are within fees, or the cheap side is too thin (depth gate). Re-run when volatility spikes.");
  }
  console.log("-".repeat(100));
}

main().catch((e) => { console.error("SCANNER FAILED:", e.message); process.exit(1); });
