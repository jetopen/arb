import type { NormalizedMessage } from "../../types";
import { getChainName } from "../../chains";

export async function sendTelegramAlert(
  message: NormalizedMessage,
  botToken: string,
  chatId: string
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  const from = getChainName(message.fromChainId);
  const to = getChainName(message.toChainId);
  const text = [
    "🆕 New deBridge Message",
    `From: ${from} → ${to}`,
    `Amount: ${message.fromTokenSymbol} → ${message.toTokenSymbol}`,
    `Status: ${message.status}`,
    `Tx: ${message.txHash}`,
  ].join("\n");

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
