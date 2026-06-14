import { NextRequest, NextResponse } from "next/server";
import { searchByTxHash, fetchOrderDetails } from "@/lib/api-client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();

    if (!q) {
      return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
    }

    let result;
    if (q.startsWith("0x") && q.length === 66) {
      result = await searchByTxHash(q);
    } else if (q.startsWith("0x") && q.length === 66) {
      result = await fetchOrderDetails(q);
    } else {
      result = await fetchOrderDetails(q);
    }

    if (!result) {
      return NextResponse.json({ message: null });
    }

    return NextResponse.json({ message: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
