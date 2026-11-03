import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLElement> & { children: ReactNode };
type CardSectionProps = HTMLAttributes<HTMLDivElement> & { children: ReactNode };

export function Card({ children, className = "", ...props }: CardProps) {
  return (
    <section className={`ui-card ${className}`.trim()} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({ children, className = "", ...props }: CardSectionProps) {
  return (
    <div className={`ui-card__header ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}

export function CardBody({ children, className = "", ...props }: CardSectionProps) {
  return (
    <div className={`ui-card__body ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}
