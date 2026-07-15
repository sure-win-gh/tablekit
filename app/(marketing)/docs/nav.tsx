"use client";

// Docs tab bar. Client component only for usePathname (active-tab
// styling); everything else in the docs shell stays server-rendered.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/docs", label: "Getting started" },
  { href: "/docs/api", label: "API reference" },
  { href: "/docs/webhooks", label: "Webhooks" },
  { href: "/docs/errors", label: "Errors & limits" },
] as const;

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="border-hairline flex gap-1 border-b text-sm">
      {TABS.map((tab) => {
        const active = tab.href === "/docs" ? pathname === "/docs" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "text-ink border-ink -mb-px border-b-2 px-3 py-2 font-medium"
                : "text-ash hover:text-ink -mb-px border-b-2 border-transparent px-3 py-2"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
