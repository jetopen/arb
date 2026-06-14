import { NextResponse } from "next/server";
import { fetchStatistics } from "@/lib/api-client";

export async function GET() {
  try {
    const data = await fetchStatistics();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
