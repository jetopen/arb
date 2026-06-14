"use client";

import { useSettings } from "@/lib/use-settings";
import type { AlertConfig } from "@/lib/types";

export default function SettingsPage() {
  const { settings, setSettings } = useSettings();

  const updateAlert = (patch: Partial<AlertConfig>) => {
    setSettings((prev) => ({
      ...prev,
      alerts: { ...prev.alerts, ...patch },
    }));
  };

  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="text-xl font-semibold text-foreground">Settings</h1>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-foreground">Alerts</h2>

        <ToggleRow
          label="Enable Alerts"
          description="Receive notifications for new messages"
          checked={settings.alerts.enabled}
          onChange={(checked) => updateAlert({ enabled: checked })}
        />

        {settings.alerts.enabled && (
          <>
            <ToggleRow
              label="In-App Notifications"
              description="Show toast notifications in the dashboard"
              checked={settings.alerts.inApp}
              onChange={(checked) => updateAlert({ inApp: checked })}
            />

            <ToggleRow
              label="Telegram Notifications"
              description="Send alerts via Telegram bot"
              checked={settings.alerts.telegram}
              onChange={(checked) => updateAlert({ telegram: checked })}
            />

            {settings.alerts.telegram && (
              <div className="ml-6 space-y-3">
                <InputField
                  label="Bot Token"
                  value={settings.alerts.telegramBotToken}
                  onChange={(v) => updateAlert({ telegramBotToken: v })}
                  placeholder="123456:ABC-DEF..."
                  type="password"
                />
                <InputField
                  label="Chat ID"
                  value={settings.alerts.telegramChatId}
                  onChange={(v) => updateAlert({ telegramChatId: v })}
                  placeholder="-1001234567890"
                />
              </div>
            )}

            <ToggleRow
              label="Webhook Notifications"
              description="POST alerts to a webhook URL"
              checked={settings.alerts.webhook}
              onChange={(checked) => updateAlert({ webhook: checked })}
            />

            {settings.alerts.webhook && (
              <div className="ml-6">
                <InputField
                  label="Webhook URL"
                  value={settings.alerts.webhookUrl}
                  onChange={(v) => updateAlert({ webhookUrl: v })}
                  placeholder="https://example.com/webhook"
                />
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-foreground">Display</h2>

        <ToggleRow
          label="Auto-Refresh"
          description="Automatically refresh data"
          checked={settings.autoRefresh}
          onChange={(checked) =>
            setSettings((prev) => ({ ...prev, autoRefresh: checked }))
          }
        />

        {settings.autoRefresh && (
          <div className="ml-6">
            <InputField
              label="Refresh Interval (seconds)"
              value={String(settings.refreshIntervalSeconds)}
              onChange={(v) => {
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 5) {
                  setSettings((prev) => ({ ...prev, refreshIntervalSeconds: n }));
                }
              }}
              placeholder="30"
            />
          </div>
        )}
      </section>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted uppercase tracking-wider">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="px-3 py-2 text-sm rounded-md border border-border bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
    </div>
  );
}
