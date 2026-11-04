import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export default function PositionsPage() {
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="positions-title">
        <div>
          <p className="eyebrow">BURROW · POSITION SAFETY</p>
          <h1 id="positions-title">Your lending positions</h1>
          <p className="page-description">
            RESCORA will help you understand liquidation risk and prepare a repayment proposal for
            your own Burrow account.
          </p>
        </div>
        <Badge tone="neutral">Read-only identity integration</Badge>
      </section>

      <Card className="empty-state-card">
        <CardHeader>
          <div className="empty-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <Badge tone="info">Burrow data not connected</Badge>
        </CardHeader>
        <CardBody>
          <div className="empty-state-copy">
            <h2>Position data is not connected yet</h2>
            <p>
              OneKey account access identifies a testnet account only. RESCORA has not loaded Burrow
              positions, so it shows no portfolio balances or risk figures.
            </p>
          </div>
          <Button disabled aria-describedby="wallet-phase-note">
            Burrow position reads are not connected
          </Button>
          <p className="microcopy" id="wallet-phase-note">
            Wallet access does not authorize a repayment or any transaction.
          </p>
        </CardBody>
      </Card>

      <section className="foundation-grid" aria-label="RESCORA foundation status">
        <Card className="foundation-card">
          <CardBody>
            <span className="status-dot status-dot--muted" aria-hidden="true" />
            <div>
              <h3>Risk assessment</h3>
              <p>Available after verified Burrow data is connected.</p>
            </div>
            <span className="card-status">Not implemented</span>
          </CardBody>
        </Card>
        <Card className="foundation-card">
          <CardBody>
            <span className="status-dot status-dot--muted" aria-hidden="true" />
            <div>
              <h3>Rescue proposals</h3>
              <p>Require validated calculations and your explicit approval.</p>
            </div>
            <span className="card-status">Not implemented</span>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
