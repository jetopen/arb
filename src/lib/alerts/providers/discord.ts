/** Minimal Discord webhook embed shape (only the fields we use). */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

/**
 * POST a message to a Discord webhook. Returns true on a 2xx (Discord replies 204 No Content).
 * Best-effort: never throws — a network error or bad URL just yields false so it can't break a scan.
 */
export async function sendDiscordAlert(
  webhookUrl: string,
  payload: { content?: string; embeds?: DiscordEmbed[] }
): Promise<boolean> {
  if (!webhookUrl) return false;
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
