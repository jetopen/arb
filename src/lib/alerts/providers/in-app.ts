import type { AlertEvent } from "../engine";

export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  timestamp: number;
  messageOrderTx: string;
  dismissed: boolean;
}

type NotificationCallback = (notifications: InAppNotification[]) => void;

let notificationId = 0;

export function createInAppHandler(onNotify: NotificationCallback): {
  handler: (event: AlertEvent) => void;
  getNotifications: () => InAppNotification[];
  dismiss: (id: string) => void;
  dismissAll: () => void;
} {
  const notifications: InAppNotification[] = [];

  return {
    handler(event: AlertEvent) {
      const { message } = event;
      const notification: InAppNotification = {
        id: `alert-${++notificationId}`,
        title: `New ${message.status} Message`,
        body: `${message.fromTokenSymbol} → ${message.toTokenSymbol} on ${message.txHash.slice(0, 10)}...`,
        timestamp: event.timestamp,
        messageOrderTx: message.txHash,
        dismissed: false,
      };
      notifications.unshift(notification);
      // Keep only last 50
      if (notifications.length > 50) notifications.length = 50;
      onNotify([...notifications]);

      // Auto-dismiss after 5 seconds
      setTimeout(() => {
        notification.dismissed = true;
        onNotify([...notifications]);
      }, 5000);
    },
    getNotifications() {
      return notifications.filter((n) => !n.dismissed);
    },
    dismiss(id: string) {
      const n = notifications.find((n) => n.id === id);
      if (n) n.dismissed = true;
      onNotify([...notifications]);
    },
    dismissAll() {
      for (const n of notifications) n.dismissed = true;
      onNotify([...notifications]);
    },
  };
}
