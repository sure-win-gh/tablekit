"use client";

import {
  Building2,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  TableProperties,
  Users,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { cn } from "@/components/ui";

// Collapsable left sidebar — the dashboard's primary chrome.
//
// State lives in localStorage (read via useSyncExternalStore for
// SSR-safe rendering — no setState-in-effect to keep the lint
// happy). Two states: "expanded" (240px, labels visible) and
// "collapsed" (64px, icons only). Mobile breakpoint hides the
// sidebar entirely behind a hamburger button — the drawer overlay
// is also driven by the same store so ⌘\ toggles it from anywhere.

const COLLAPSE_KEY = "tablekit:sidebar-collapsed";
const DRAWER_KEY = "tablekit:sidebar-drawer";

export type SidebarData = {
  user: { name: string; email: string };
  org: { name: string; groupCrmEnabled: boolean; multiVenue: boolean };
  venues: Array<{ id: string; name: string }>;
};

type Item = {
  href: string;
  label: string;
  icon: LucideIcon;
  show?: boolean | undefined;
};

export function SidebarShell({
  data,
  signOut,
}: {
  data: SidebarData;
  signOut: () => Promise<void>;
}) {
  const pathname = usePathname();
  const collapsed = useFlagStore(COLLAPSE_KEY);
  const drawerOpen = useFlagStore(DRAWER_KEY);

  const venueId = matchVenueId(pathname);

  // Org-section items. Overview only when there's >1 venue (single-
  // venue orgs auto-redirect from /dashboard, so /overview would
  // bounce back). Guests only when group CRM is on.
  const orgItems: Item[] = [
    { href: "/dashboard/overview", label: "Overview", icon: LayoutDashboard, show: data.org.multiVenue },
    { href: "/dashboard/organisation", label: "Organisation", icon: Building2 },
    { href: "/dashboard/guests", label: "Guests", icon: Users, show: data.org.groupCrmEnabled },
    { href: "/dashboard/privacy-requests", label: "Privacy requests", icon: ShieldCheck },
  ];

  // Venue-section items, only rendered while inside a venue route.
  const venueItems: Item[] = venueId
    ? [
        { href: `/dashboard/venues/${venueId}/bookings`, label: "Bookings", icon: CalendarDays },
        { href: `/dashboard/venues/${venueId}/timeline`, label: "Timeline", icon: Clock },
        { href: `/dashboard/venues/${venueId}/waitlist`, label: "Waitlist", icon: Users },
        { href: `/dashboard/venues/${venueId}/floor-plan`, label: "Floor plan", icon: TableProperties },
        { href: `/dashboard/venues/${venueId}/services`, label: "Services", icon: UtensilsCrossed },
        { href: `/dashboard/venues/${venueId}/deposits`, label: "Deposits", icon: CreditCard },
        { href: `/dashboard/venues/${venueId}/reports`, label: "Reports", icon: CalendarRange },
        { href: `/dashboard/venues/${venueId}/settings`, label: "Settings", icon: Settings },
      ]
    : [];

  return (
    <>
      {/* Mobile hamburger — only visible at sm and below. */}
      <button
        type="button"
        aria-label={drawerOpen ? "Close menu" : "Open menu"}
        onClick={() => toggleFlag(DRAWER_KEY)}
        className="fixed left-3 top-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-white text-ink shadow-sm md:hidden"
      >
        <Menu className="h-4 w-4" aria-hidden />
      </button>

      {/* Backdrop on mobile while the drawer is open. */}
      {drawerOpen ? (
        <div
          aria-hidden
          onClick={() => writeFlag(DRAWER_KEY, false)}
          className="fixed inset-0 z-30 bg-ink/30 md:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-hairline bg-white transition-[width,transform] duration-200 ease-out md:sticky md:top-0 md:h-screen md:transform-none",
          collapsed ? "w-16" : "w-60",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        {/* Edge handle — always visible on desktop. Half-pokes out of
            the right edge of the rail at vertical center, so it's
            obvious in both expanded + collapsed states. Replaces the
            old in-header collapse button + footer-stuck expand button
            which were too easy to miss. */}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => toggleFlag(COLLAPSE_KEY)}
          className="absolute right-0 top-1/2 z-40 hidden h-7 w-7 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-hairline bg-white text-ash shadow-sm transition hover:border-ink hover:text-ink md:inline-flex"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>

        {/* Brand header */}
        <div
          className={cn(
            "flex items-center border-b border-hairline px-4 py-4",
            collapsed ? "justify-center px-3" : "justify-start",
          )}
        >
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-coral text-[13px] font-bold text-white">
              T
            </span>
            {!collapsed ? (
              <div className="flex flex-col">
                <span className="text-sm font-bold leading-none tracking-tight text-ink">
                  TableKit
                </span>
                <span className="mt-0.5 truncate text-[11px] text-ash">{data.org.name}</span>
              </div>
            ) : null}
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
          <Section
            label="Organisation"
            items={orgItems.filter((i) => i.show !== false)}
            pathname={pathname}
            collapsed={collapsed}
          />
          {venueId ? (
            <Section
              label="Venue"
              items={venueItems}
              pathname={pathname}
              collapsed={collapsed}
            />
          ) : null}
        </nav>

        {/* Footer: user + sign-out */}
        <div className="border-t border-hairline p-2">
          {!collapsed ? (
            <div className="px-2 pb-2 text-[11px] text-ash">
              <p className="truncate font-semibold text-ink">{data.user.name}</p>
              <p className="truncate">{data.user.email}</p>
            </div>
          ) : null}
          <form action={signOut}>
            <button
              type="submit"
              className={cn(
                "flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-sm text-charcoal transition hover:bg-cloud hover:text-ink",
                collapsed && "justify-center",
              )}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              {!collapsed ? "Sign out" : null}
            </button>
          </form>
        </div>
      </aside>

      {/* Push the main content to the right of the sidebar at md+.
          Spacer width matches the sidebar exactly — content sits
          flush against the sidebar's right edge with no extra
          gutter. */}
      <div
        aria-hidden
        className={cn("hidden md:block", collapsed ? "w-16" : "w-60")}
      />
    </>
  );
}

function Section({
  label,
  items,
  pathname,
  collapsed,
}: {
  label: string;
  items: Item[];
  pathname: string;
  collapsed: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {!collapsed ? (
        <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ash">
          {label}
        </p>
      ) : null}
      {items.map((it) => (
        <NavLink key={it.href} item={it} active={pathname.startsWith(it.href)} collapsed={collapsed} />
      ))}
    </div>
  );
}

function NavLink({ item, active, collapsed }: { item: Item; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      onClick={() => writeFlag(DRAWER_KEY, false)}
      className={cn(
        "flex items-center gap-2.5 rounded-input px-2 py-1.5 text-sm transition",
        active ? "bg-cloud font-semibold text-ink" : "text-charcoal hover:bg-cloud hover:text-ink",
        collapsed && "justify-center",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-coral")} aria-hidden />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </Link>
  );
}

function matchVenueId(pathname: string): string | null {
  // /dashboard/venues/<uuid>/...  — capture the uuid segment.
  const m = pathname.match(/^\/dashboard\/venues\/([0-9a-f-]{36})/i);
  return m ? m[1] ?? null : null;
}

// ---------------------------------------------------------------------------
// localStorage-backed boolean flags (collapse state, mobile drawer).
// useSyncExternalStore is the rule-compliant way to subscribe React
// to external state — same pattern as components/cookie-notice.tsx.
// ---------------------------------------------------------------------------

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value ? "1" : null }));
  } catch {
    // No storage — flag just stays default.
  }
}

function toggleFlag(key: string): void {
  writeFlag(key, !readFlag(key));
}

function subscribe(key: string) {
  return (notify: () => void): (() => void) => {
    function handler(e: StorageEvent) {
      if (e.key === key) notify();
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  };
}

const collapseSub = subscribe(COLLAPSE_KEY);
const drawerSub = subscribe(DRAWER_KEY);

function useFlagStore(key: string): boolean {
  const sub = key === COLLAPSE_KEY ? collapseSub : drawerSub;
  return useSyncExternalStore(
    sub,
    () => readFlag(key),
    // Server snapshot — sidebar starts expanded + drawer closed.
    () => false,
  );
}
