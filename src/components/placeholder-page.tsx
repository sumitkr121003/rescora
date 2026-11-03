import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";

type PlaceholderPageProps = {
  eyebrow: string;
  title: string;
  message: string;
};

export function PlaceholderPage({ eyebrow, title, message }: PlaceholderPageProps) {
  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="page-description">
            This area is part of the approved RESCORA application structure.
          </p>
        </div>
        <Badge tone="neutral">Phase 1 foundation</Badge>
      </section>
      <Card className="placeholder-card">
        <CardBody>
          <Badge className="placeholder-label" tone="info">
            Not implemented
          </Badge>
          <h2>This page is not connected to account data</h2>
          <p>{message}</p>
        </CardBody>
      </Card>
    </div>
  );
}
