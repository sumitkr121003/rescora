"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [{ href: "/", label: "Positions" }] as const;

export function PrimaryNav() {
  const pathname = usePathname();

  return (
    <nav className="primary-nav" aria-label="Main navigation">
      {navigation.map((item) => (
        <Link
          aria-current={pathname === item.href ? "page" : undefined}
          className="nav-link"
          href={item.href}
          key={item.href}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
