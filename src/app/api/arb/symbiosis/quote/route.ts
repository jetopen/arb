import { NextRequest, NextResponse } from "next/server";
import { fetchSymQuote } from "@/lib/symbiosis/client";
import { clipToBaseUnits } from "@/lib/symbiosis/scanner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** On-demand executable quote at a USD clip — shows the real net edge (fixed fee included). */
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams;
    const inTok = {
      address: sp.get("inAddr") ?? "",
      chainId: Number(sp.get("inChain")),
      decimals: Number(sp.get("inDec")),
      symbol: sp.get("inSym") ?? "",
    };
    const outTok = {
      address: sp.get("outAddr") ?? "",
      chainId: Number(sp.get("outChain")),
      decimals: Number(sp.get("outDec")),
      symbol: sp.get("outSym") ?? "",
    };
    const usd = Number(sp.get("usd") ?? "1000");
    const inPrice = Number(sp.get("inPrice"));
    if (!inTok.address || !outTok.address || !Number.isFinite(inTok.chainId) || !Number.isFinite(inPrice) || inPrice <= 0) {
      return NextResponse.json({ error: "missing/invalid token params" }, { status: 400 });
    }
    const amount = clipToBaseUnits(usd, inPrice, inTok.decimals);
    const quote = await fetchSymQuote(inTok, outTok, amount);
    return NextResponse.json({ usd, quote });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
