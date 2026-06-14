import type { NormalizedMessage } from "../../types";

export async function sendWebhookAlert(
  message: NormalizedMessage,
  webhookUrl: string
): Promise<boolean> {
  if (!webhookUrl) return false;

  const payload = {
    event: "new_message",
    data: message,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
