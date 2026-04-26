"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";

// Active-tab underline pattern lifted from Airbnb's tri-tab category
// picker — the only place we use a 2px ink underline. Active match is
// startsWith() so child routes (e.g. /reports/export/...) keep the
// parent tab lit.

type Tab = { href: string; label: string };

export function VenueTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <div className="-mb-px flex gap-1 text-sm">
      {tabs.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "relative px-3 py-2.5 transition",
              active
                ? "font-semibold text-ink"
                : "font-medium text-ash hover:text-ink",
            )}
          >
            {t.label}
            {active ? (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" />
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
