import { NextRequest, NextResponse } from "next/server";
import { sendTelegramAlert } from "@/lib/alerts/providers/telegram";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, botToken, chatId } = body;

    if (!message || !botToken || !chatId) {
      return NextResponse.json(
        { error: "Missing required fields: message, botToken, chatId" },
        { status: 400 }
      );
    }

    const success = await sendTelegramAlert(message, botToken, chatId);
    if (!success) {
      return NextResponse.json({ error: "Failed to send Telegram alert" }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
