import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { PrimaryNav } from "@/components/primary-nav";

type AppShellProps = { children: ReactNode };

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" href="/" aria-label="RESCORA home">
            <span className="brand-mark" aria-hidden="true">
              R
            </span>
            <span>RESCORA</span>
          </Link>
          <PrimaryNav />
          <div className="header-status" aria-label="Application scope and wallet">
            <Badge className="network-scope" tone="scope">
              <span className="scope-dot" aria-hidden="true" />
              NEAR TESTNET
            </Badge>
            <span className="wallet-state">Wallet not connected</span>
          </div>
        </div>
      </header>
      <main className="main-content" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <span>RESCORA · Phase 1 foundation</span>
        <span>Testnet scope only · No wallet or protocol connection</span>
      </footer>
    </div>
  );
}
