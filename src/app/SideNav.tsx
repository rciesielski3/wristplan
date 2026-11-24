"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive } from "./activeNav";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/workouts", label: "Workouts" },
  { href: "/calendar", label: "Calendar" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="sidenav">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={isActive(pathname, l.href) ? "page" : undefined}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
