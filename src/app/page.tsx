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
        <Badge tone="neutral">Phase 1 foundation</Badge>
      </section>

      <Card className="empty-state-card">
        <CardHeader>
          <div className="empty-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <Badge tone="info">Not connected</Badge>
        </CardHeader>
        <CardBody>
          <div className="empty-state-copy">
            <h2>Wallet and position data are not connected yet</h2>
            <p>
              This foundation does not connect to a wallet or read Burrow. No account data or
              financial values are shown here.
            </p>
          </div>
          <Button disabled aria-describedby="wallet-phase-note">
            Wallet connection comes in Phase 2
          </Button>
          <p className="microcopy" id="wallet-phase-note">
            Connecting a wallet will not authorize a repayment.
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
