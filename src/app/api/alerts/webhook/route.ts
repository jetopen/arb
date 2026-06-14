import { NextRequest, NextResponse } from "next/server";
import { sendWebhookAlert } from "@/lib/alerts/providers/webhook";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, webhookUrl } = body;

    if (!message || !webhookUrl) {
      return NextResponse.json(
        { error: "Missing required fields: message, webhookUrl" },
        { status: 400 }
      );
    }

    const success = await sendWebhookAlert(message, webhookUrl);
    if (!success) {
      return NextResponse.json({ error: "Failed to send webhook alert" }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
