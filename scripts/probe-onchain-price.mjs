// probe-onchain-price.mjs — standalone on-chain pool probe for manual arb screening.
//
// Reads UniswapV2-fork pair reserves directly from an RPC, computes the live
// mid-price (in quote token + USD), the pool's idleness (last reserve update),
// real USD TVL, and the tradable depth before a given execution-slippage
// threshold in BOTH directions. Use it to confirm a DefiLlama
// "high-TVL + near-zero-volume" candidate is genuinely idle AND to quantify how
// much you could actually move before the thin pool repriced.
//
// USD pricing: a CoinGecko reference price for the chain's NATIVE token is the
// trusted anchor; the target token's USD is derived from its on-chain pool ratio
// to native. A pool's "stablecoin" leg is NEVER assumed to be $1 — its implied
// USD is backed out and flagged if it has DEPEGGED (critical on hacked/abandoned
// chains like Harmony, where bridged USDC is worth ~$0.008, not $1).
//
// Reusable: edit the CONFIG block to point at a new chain + pair set.
// Run:  node scripts/probe-onchain-price.mjs
//       RPC_URL_1666600000=https://api.harmony.one node scripts/probe-onchain-price.mjs

import { createPublicClient, http, defineChain, parseAbi, getAddress } from "viem";

// ----------------------------- CONFIG ---------------------------------------
const CONFIG = {
  chain: {
    id: 1666600000,
    name: "Harmony",
    nativeSymbol: "ONE",
    rpcUrl: process.env.RPC_URL_1666600000 || "https://api.harmony.one",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  },
  // CoinGecko ids for trusted USD anchors (native is the load-bearing one).
  ref: { nativeId: "harmony", targetId: "defi-kingdoms" },
  // The token we want a price FOR. The OTHER side of each pair is the quote.
  target: { address: "0x72Cb10C6bfA5624dD07Ef608027E366bd690048F", expectSymbol: "JEWEL" },
  pairs: [
    { label: "JEWEL/wONE  (DFK DEX)", address: "0xEB579DDcD49a7Beb3F205c9fF6006Bb6390F138f" }, // native pair first
    { label: "JEWEL/1USDC (DFK DEX)", address: "0xA1221A5BBEa699f507cc00bDedeA05b5d2e32Eba" },
  ],
  ammFeeBps: 30, // 0.30% — standard UniswapV2 fork; adjust if the DEX differs
  slippageTargets: [0.005, 0.01, 0.02], // depth reported at 0.5% / 1% / 2% exec slippage
};
// ----------------------------------------------------------------------------

const PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const toNum = (raw, dec) => Number(raw) / 10 ** Number(dec);
const fmt = (n, d = 6) =>
  n === null || n === undefined || !isFinite(n)
    ? "n/a"
    : n.toLocaleString("en-US", { maximumFractionDigits: d });
const usd = (n) => (n === null || !isFinite(n) ? "n/a" : "$" + fmt(n, n < 0.01 ? 6 : 2));
const looksStable = (sym) => /USD|USDC|USDT|DAI|BUSD/i.test(sym);

function ageString(seconds) {
  if (seconds < 0) return "in the future (clock skew)";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m ago`;
}

function amountOut(amountIn, reserveIn, reserveOut, feeBps) {
  const inWithFee = amountIn * (10000 - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * 10000 + inWithFee);
}

// Binary-search the input size (tokenIn units) whose execution price is `target`
// below mid. Returns { amountIn, amountOut } in token units.
function depthForSlippage(reserveIn, reserveOut, feeBps, target) {
  const mid = reserveOut / reserveIn;
  let lo = 0;
  let hi = reserveIn;
  for (let i = 0; i < 80; i++) {
    const mIn = (lo + hi) / 2;
    const execPrice = amountOut(mIn, reserveIn, reserveOut, feeBps) / mIn;
    if (1 - execPrice / mid > target) hi = mIn;
    else lo = mIn;
  }
  const amountIn = (lo + hi) / 2;
  return { amountIn, amountOut: amountOut(amountIn, reserveIn, reserveOut, feeBps) };
}

async function fetchRefPrices() {
  const ids = [CONFIG.ref.nativeId, CONFIG.ref.targetId].filter(Boolean).join(",");
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const j = await r.json();
    return {
      nativeUsd: j[CONFIG.ref.nativeId]?.usd ?? null,
      targetUsd: j[CONFIG.ref.targetId]?.usd ?? null,
    };
  } catch {
    return { nativeUsd: null, targetUsd: null };
  }
}

async function readPair(client, p) {
  const pair = getAddress(p.address);
  const [reserves, token0, token1] = await Promise.all([
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token1" }),
  ]);
  const [r0, r1, blockTsLast] = reserves;
  const [d0, s0, d1, s1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  const target = getAddress(CONFIG.target.address);
  const tgtIs0 = getAddress(token0) === target;
  const tgt = tgtIs0 ? { sym: s0, dec: d0, res: r0 } : { sym: s1, dec: d1, res: r1 };
  const quo = tgtIs0 ? { sym: s1, dec: d1, res: r1 } : { sym: s0, dec: d0, res: r0 };
  return {
    label: p.label,
    pair,
    blockTsLast: Number(blockTsLast),
    tgtRes: toNum(tgt.res, tgt.dec),
    quoRes: toNum(quo.res, quo.dec),
    tgtSym: tgt.sym,
    quoSym: quo.sym,
    quoIsNative: quo.sym.toUpperCase().includes(CONFIG.chain.nativeSymbol),
  };
}

async function main() {
  const c = CONFIG.chain;
  const chain = defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    contracts: { multicall3: { address: c.multicall3 } },
  });
  const client = createPublicClient({
    chain,
    transport: http(c.rpcUrl, { batch: true, timeout: 20_000, retryCount: 2 }),
  });

  const [onchainId, ref] = await Promise.all([client.getChainId(), fetchRefPrices()]);
  const nowBlock = await client.getBlockNumber();
  const nowTs = Number((await client.getBlock({ blockNumber: nowBlock })).timestamp);

  console.log("=".repeat(78));
  console.log(`ON-CHAIN POOL PROBE  —  ${c.name}  (rpc: ${c.rpcUrl})`);
  console.log(`chainId: ${onchainId}${onchainId === c.id ? " ✓" : ` ✗ EXPECTED ${c.id}`}   head block ${nowBlock} @ ${new Date(nowTs * 1000).toISOString()}`);
  console.log(`reference: ${c.nativeSymbol}/USD = ${usd(ref.nativeUsd)} (CoinGecko)   ${CONFIG.target.expectSymbol}/USD(agg) = ${usd(ref.targetUsd)}`);
  console.log("=".repeat(78));

  // Pass 1: read every pair.
  const pools = [];
  for (const p of CONFIG.pairs) {
    try {
      pools.push(await readPair(client, p));
    } catch (e) {
      console.log(`\n▸ ${p.label}\n  ✗ read failed: ${e.shortMessage || e.message}`);
    }
  }

  // Establish trusted target USD: prefer native-pair ratio × native ref price.
  let targetUsd = null;
  const nativePool = pools.find((x) => x.quoIsNative);
  if (nativePool && ref.nativeUsd) targetUsd = (nativePool.quoRes / nativePool.tgtRes) * ref.nativeUsd;
  if (targetUsd === null) targetUsd = ref.targetUsd; // fall back to aggregator

  // Pass 2: report.
  for (const pool of pools) {
    const mid = pool.quoRes / pool.tgtRes; // quote per 1 target
    let quoteUsd = null;
    if (pool.quoIsNative) quoteUsd = ref.nativeUsd;
    else if (targetUsd !== null && mid > 0) quoteUsd = targetUsd / mid; // back out from trusted target
    const midUsd = quoteUsd !== null ? mid * quoteUsd : null;

    console.log(`\n▸ ${pool.label}\n  pair ${pool.pair}`);
    console.log(`  reserves: ${fmt(pool.tgtRes, 2)} ${pool.tgtSym}  |  ${fmt(pool.quoRes, 2)} ${pool.quoSym}`);
    console.log(`  mid-price: 1 ${pool.tgtSym} = ${fmt(mid)} ${pool.quoSym}` + (midUsd !== null ? `  ≈ ${usd(midUsd)}` : ""));

    // Depeg check on a "stable" quote leg.
    if (looksStable(pool.quoSym) && quoteUsd !== null) {
      const depegPct = (1 - quoteUsd) * 100;
      const flag = Math.abs(depegPct) > 5 ? `  ⚠️ DEPEGGED ${depegPct.toFixed(1)}% (NOT $1 — do not price at face value)` : " (≈ pegged)";
      console.log(`  implied ${pool.quoSym} = ${usd(quoteUsd)}${flag}`);
    }

    // Real USD TVL using best-known prices for BOTH legs.
    if (targetUsd !== null && quoteUsd !== null) {
      const tvl = pool.tgtRes * targetUsd + pool.quoRes * quoteUsd;
      console.log(`  real pool TVL ≈ ${usd(tvl)}` + (looksStable(pool.quoSym) ? `  (face-value would mis-state this)` : ""));
    }

    // Idleness (blockTimestampLast = last block reserves changed = last swap/mint/burn).
    console.log(`  last reserve change: ${ageString(nowTs - pool.blockTsLast)}  [${pool.blockTsLast}]`);

    // Tradable depth before slippage, both directions, in USD.
    console.log(`  tradable depth (fee ${CONFIG.ammFeeBps / 100}%):`);
    for (const t of CONFIG.slippageTargets) {
      const buy = depthForSlippage(pool.quoRes, pool.tgtRes, CONFIG.ammFeeBps, t); // pay quote, get target
      const sell = depthForSlippage(pool.tgtRes, pool.quoRes, CONFIG.ammFeeBps, t); // pay target, get quote
      const buyUsd = quoteUsd !== null ? buy.amountIn * quoteUsd : null;
      const sellUsd = targetUsd !== null ? sell.amountIn * targetUsd : null;
      console.log(
        `    @${(t * 100).toFixed(1)}%  buy ≈ ${usd(buyUsd)}   |   sell ≈ ${usd(sellUsd)}`
      );
    }
  }

  console.log("\n" + "-".repeat(78));
  if (targetUsd !== null) {
    const drift = ref.targetUsd ? ((targetUsd / ref.targetUsd - 1) * 100).toFixed(1) : "n/a";
    console.log(`On-chain ${CONFIG.target.expectSymbol} ≈ ${usd(targetUsd)} (via native pool)  vs aggregator ${usd(ref.targetUsd)}  → drift ${drift}%`);
  }
  console.log("Note: 'last Swap event' lookback omitted — api.harmony.one rejects eth_getLogs on these filters;");
  console.log("      blockTimestampLast (last reserve change) is the reliable idle signal instead.");
  console.log("-".repeat(78));
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.shortMessage || e.message);
  process.exit(1);
});
