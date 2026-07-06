// One-off smoke for the 1inch quote module (positive + negative control). Run: npx tsx scripts/smoke-1inch.mts
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), true);

const { fetchOneInchQuote } = await import("@/lib/quotes/oneinch");

const USDC_BSC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"; // 18-dec USDC on BSC
const WBNB_BSC = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"; // deeply liquid (positive control)
const DEFXS_BSC = "0xa5dec5b2ae02efc4dc199507f65a6538987e4299"; // rep w/ 0 pairs anywhere (negative control)
const AMT = (25n * 10n ** 18n).toString(); // $25 in BSC-USDC base units

// NOTE: GRASS-BSC (0xf43a…c8db) was probed as a candidate positive control but 1inch itself returns
// 400 INSUFFICIENT_LIQUIDITY for it (doesn't index its Topaz pool, which Kyber routes) — a truthful no.
console.log("positive control USDC->WBNB (expect a route):");
console.log(await fetchOneInchQuote(56, USDC_BSC, WBNB_BSC, AMT));

console.log("\nnegative control USDC->deFXS (expect null):");
console.log(await fetchOneInchQuote(56, USDC_BSC, DEFXS_BSC, AMT));
process.exit(0);
