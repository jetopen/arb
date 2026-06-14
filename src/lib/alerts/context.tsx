"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { AlertEngine } from "./engine";
import {
  createInAppHandler,
  type InAppNotification,
} from "./providers/in-app";
import { sendTelegramAlert } from "./providers/telegram";
import { sendWebhookAlert } from "./providers/webhook";
import type { NormalizedMessage } from "../types";

interface AlertContextValue {
  alertsEnabled: boolean;
  setAlertsEnabled: (enabled: boolean) => void;
  notifications: InAppNotification[];
  dismissNotification: (id: string) => void;
  dismissAll: () => void;
  alertCount: number;
  engine: AlertEngine;
}

const AlertContext = createContext<AlertContextValue | null>(null);

export function useAlerts() {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error("useAlerts must be used within AlertProvider");
  return ctx;
}

interface AlertProviderProps {
  children: ReactNode;
}

export function AlertProvider({ children }: AlertProviderProps) {
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const engineRef = useRef<AlertEngine | null>(null);
  const inAppRef = useRef<ReturnType<typeof createInAppHandler> | null>(null);

  if (!engineRef.current) {
    engineRef.current = new AlertEngine();

    inAppRef.current = createInAppHandler((n) => setNotifications([...n]));
    engineRef.current.register(inAppRef.current.handler);

    // Register Telegram + webhook handlers
    engineRef.current.register(async (event) => {
      const botToken = process.env.NEXT_PUBLIC_TELEGRAM_BOT_TOKEN ?? "";
      const chatId = process.env.NEXT_PUBLIC_TELEGRAM_CHAT_ID ?? "";
      if (botToken && chatId) {
        await sendTelegramAlert(event.message, botToken, chatId);
      }
    });

    engineRef.current.register(async (event) => {
      const webhookUrl = process.env.NEXT_PUBLIC_WEBHOOK_URL ?? "";
      if (webhookUrl) {
        await sendWebhookAlert(event.message, webhookUrl);
      }
    });
  }

  const engine = engineRef.current;

  const dismissNotification = useCallback((id: string) => {
    inAppRef.current?.dismiss(id);
  }, []);

  const dismissAll = useCallback(() => {
    inAppRef.current?.dismissAll();
  }, []);

  const alertCount = notifications.filter((n) => !n.dismissed).length;

  return (
    <AlertContext.Provider
      value={{
        alertsEnabled,
        setAlertsEnabled: (enabled: boolean) => {
          setAlertsEnabled(enabled);
          engine.setEnabled(enabled);
        },
        notifications,
        dismissNotification,
        dismissAll,
        alertCount,
        engine,
      }}
    >
      {children}
    </AlertContext.Provider>
  );
}
