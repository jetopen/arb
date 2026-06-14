"use client";

import { useState, useEffect } from "react";
import type { AlertConfig, DashboardSettings } from "@/lib/types";

const DEFAULT_SETTINGS: DashboardSettings = {
  alerts: {
    enabled: true,
    inApp: true,
    telegram: false,
    telegramBotToken: "",
    telegramChatId: "",
    webhook: false,
    webhookUrl: "",
  },
  messagesPerPage: 50,
  autoRefresh: true,
  refreshIntervalSeconds: 30,
};

function loadSettings(): DashboardSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const stored = localStorage.getItem("debridge-settings");
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: DashboardSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem("debridge-settings", JSON.stringify(settings));
}

export function useSettings() {
  const [settings, setSettingsState] = useState<DashboardSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettingsState(loadSettings());
  }, []);

  const setSettings = (updater: (prev: DashboardSettings) => DashboardSettings) => {
    setSettingsState((prev) => {
      const next = updater(prev);
      saveSettings(next);
      return next;
    });
  };

  return { settings, setSettings };
}

export { DEFAULT_SETTINGS };
