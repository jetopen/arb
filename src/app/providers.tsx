"use client";

import { AlertProvider } from "@/lib/alerts/context";
import { AlertToast } from "@/components/alert-toast";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AlertProvider>
      {children}
      <AlertToast />
    </AlertProvider>
  );
}
