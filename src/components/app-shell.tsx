import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { PrimaryNav } from "@/components/primary-nav";
import { WalletIdentity } from "@/components/wallet-identity";
import { WalletSessionProvider } from "@/components/wallet-session-provider";

type AppShellProps = { children: ReactNode };

export function AppShell({ children }: AppShellProps) {
  return (
    <WalletSessionProvider>
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
            <div className="header-status" aria-label="Application network scope">
              <Badge className="network-scope" tone="scope">
                <span className="scope-dot" aria-hidden="true" />
                APP CONFIG · NEAR TESTNET
              </Badge>
              <WalletIdentity />
            </div>
          </div>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <span>RESCORA · hackathon demonstration</span>
          <span>Synthetic demo available · live assessment unverified · execution disabled</span>
        </footer>
      </div>
    </WalletSessionProvider>
  );
}
