import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { ClientProviders } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "deBridge Messages Dashboard",
  description: "Cross-chain message monitoring dashboard for deBridge protocol",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-white text-foreground">
        <ClientProviders>
          <header className="border-b border-border bg-white sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-14">
                <div className="flex items-center gap-8">
                  <Link href="/" className="text-lg font-semibold text-foreground">
                    deBridge
                  </Link>
                  <nav className="flex items-center gap-4">
                    <Link
                      href="/"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Messages
                    </Link>
                    <Link
                      href="/analytics"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Analytics
                    </Link>
                    <Link
                      href="/arbitrage"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Arbitrage
                    </Link>
                    <Link
                      href="/tokens"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Tokens
                    </Link>
                    <Link
                      href="/layerzero"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      LayerZero
                    </Link>
                    <Link
                      href="/symbiosis"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Symbiosis
                    </Link>
                    <Link
                      href="/settings"
                      className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                      Settings
                    </Link>
                  </nav>
                </div>
                <div className="text-xs text-muted">
                  Auto-refresh: 30s
                </div>
              </div>
            </div>
          </header>
          <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6">
            {children}
          </main>
        </ClientProviders>
      </body>
    </html>
  );
}
