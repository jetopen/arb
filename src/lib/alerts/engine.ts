import type { NormalizedMessage } from "../types";
import { getChainName } from "../chains";

export interface AlertEvent {
  type: "new_message";
  message: NormalizedMessage;
  timestamp: number;
}

export type AlertHandler = (event: AlertEvent) => void | Promise<void>;

export class AlertEngine {
  private handlers: AlertHandler[] = [];
  private lastSeenTimestamp: number = 0;
  private enabled: boolean = true;

  register(handler: AlertHandler) {
    this.handlers.push(handler);
  }

  unregister(handler: AlertHandler) {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  checkForNewMessages(messages: NormalizedMessage[]) {
    if (!this.enabled || messages.length === 0) return;

    const sorted = [...messages].sort((a, b) => b.timestamp - a.timestamp);
    const newestTimestamp = sorted[0].timestamp;

    if (this.lastSeenTimestamp === 0) {
      this.lastSeenTimestamp = newestTimestamp;
      return;
    }

    const newMessages = sorted.filter((m) => m.timestamp > this.lastSeenTimestamp);

    if (newMessages.length > 0) {
      this.lastSeenTimestamp = newestTimestamp;
      for (const msg of newMessages) {
        const event: AlertEvent = {
          type: "new_message",
          message: msg,
          timestamp: Date.now(),
        };
        for (const handler of this.handlers) {
          try {
            handler(event);
          } catch {
            // Handler errors should not crash the engine
          }
        }
      }
    }
  }

  getLastSeenTimestamp(): number {
    return this.lastSeenTimestamp;
  }

  reset() {
    this.lastSeenTimestamp = 0;
  }
}

export function formatAlertMessage(msg: NormalizedMessage): string {
  const from = getChainName(msg.fromChainId);
  const to = getChainName(msg.toChainId);
  const txShort = `${msg.txHash.slice(0, 10)}...`;
  return `New deBridge Message\nFrom: ${from} → ${to}\nAmount: ${msg.fromTokenSymbol} → ${msg.toTokenSymbol}\nStatus: ${msg.status}\nTx: ${txShort}`;
}
