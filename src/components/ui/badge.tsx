import type { HTMLAttributes, ReactNode } from "react";

type BadgeTone = "neutral" | "info" | "scope";
type BadgeProps = HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: BadgeTone };

export function Badge({ children, className = "", tone = "neutral", ...props }: BadgeProps) {
  return (
    <span className={`ui-badge ui-badge--${tone} ${className}`.trim()} {...props}>
      {children}
    </span>
  );
}
