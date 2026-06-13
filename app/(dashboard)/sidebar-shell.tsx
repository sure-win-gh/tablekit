"use client";

import {
  Banknote,
  Building2,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleUser,
  Clock,
  CreditCard,
  Database,
  Gauge,
  Globe,
  Hourglass,
  Images,
  Inbox,
  LayoutDashboard,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  Star,
  TableProperties,
  TrendingUp,
  Users,
  UtensilsCrossed,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { cn } from "@/components/ui";
import { isLocked } from "@/lib/auth/entitlements";
import type { Plan } from "@/lib/auth/plan-level";

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
// Per-group expand/collapse persistence. Suffix is the group's own key.
const GROUP_KEY_PREFIX = "tablekit:nav-group:";
// Last venue the user was looking at. Lets the Venue section stay
// pinned in the rail after navigating to an org-level route (which has
// no /venues/<id>/ segment in its path).
const VENUE_KEY = "tablekit:last-venue";

export type SidebarData = {
  user: { name: string; email: string };
  org: {
    id: string;
    name: string;
    // The org's plan tier. Plan-gated nav items derive their locked
    // state from this via isLocked() so they show locked rather than
    // hidden. groupCrmEnabled + multiVenue stay separate — they're
    // structural (org opt-in / venue count), not plan locks.
    plan: Plan;
    groupCrmEnabled: boolean;
    multiVenue: boolean;
  };
  venues: Array<{ id: string; name: string }>;
  // The user's full membership list, including the active org.
  // Used by the org switcher dropdown — only rendered when this
  // has 2+ entries.
  memberships: Array<{ orgId: string; orgName: string }>;
};

type Item = {
  kind: "item";
  href: string;
  label: string;
  icon: LucideIcon;
  // `show: false` hides the item entirely (structural gates). `locked`
  // keeps it visible but rendered with a lock + linked to the page,
  // which shows the upgrade overlay (plan gates).
  show?: boolean | undefined;
  locked?: boolean | undefined;
};

type Group = {
  kind: "group";
  // localStorage key suffix — open/closed state persists across sessions.
  groupKey: string;
  label: string;
  icon: LucideIcon;
  items: Item[];
};

type NavEntry = Item | Group;

export function SidebarShell({
  data,
  signOut,
  switchActiveOrg,
}: {
  data: SidebarData;
  signOut: () => Promise<void>;
  switchActiveOrg: (input: { orgId: string }) => Promise<void>;
}) {
  const pathname = usePathname();
  const collapsed = useFlagStore(COLLAPSE_KEY);
  const drawerOpen = useFlagStore(DRAWER_KEY);

  // The venue in the URL when we're on a venue route. Persist it so the
  // Venue section can stay in the rail after the user jumps to an
  // org-level route (Organisation, Guests, Admin…), which carries no
  // venue in its path. Falls back to the stored venue, then the first
  // venue, so the section is present whenever the org has any venue.
  const urlVenueId = matchVenueId(pathname);
  useEffect(() => {
    if (urlVenueId) writeValue(VENUE_KEY, urlVenueId);
  }, [urlVenueId]);

  const storedVenueId = useValueStore(VENUE_KEY);
  // Guard against a stored venue that's since been deleted / left.
  const storedIsKnown = storedVenueId ? data.venues.some((v) => v.id === storedVenueId) : false;
  const venueId =
    urlVenueId ?? (storedIsKnown ? storedVenueId : null) ?? data.venues[0]?.id ?? null;
  const activeVenue = venueId ? data.venues.find((v) => v.id === venueId) : undefined;

  // Org-section entries. Day-to-day links sit at the top; the
  // compliance/data plumbing collapses into Admin so the rail isn't
  // dominated by configure-once items.
  const orgEntries: NavEntry[] = [
    {
      kind: "item",
      href: "/dashboard/overview",
      label: "Overview",
      icon: LayoutDashboard,
      show: data.org.multiVenue,
    },
    { kind: "item", href: "/dashboard/organisation", label: "Organisation", icon: Building2 },
    {
      kind: "item",
      href: "/dashboard/guests",
      label: "Guests",
      icon: Users,
      // Structural: cross-venue CRM only appears for multi-venue orgs
      // that opted in. Multi-venue already implies Plus, so no lock.
      show: data.org.groupCrmEnabled && data.org.multiVenue,
    },
    {
      kind: "group",
      groupKey: "org-admin",
      label: "Admin",
      icon: Shield,
      items: [
        { kind: "item", href: "/dashboard/settings/account", label: "Account", icon: CircleUser },
        { kind: "item", href: "/dashboard/data", label: "Data", icon: Database },
        {
          kind: "item",
          href: "/dashboard/privacy-requests",
          label: "Privacy requests",
          icon: ShieldCheck,
        },
        { kind: "item", href: "/dashboard/settings/security", label: "Security", icon: Lock },
      ],
    },
  ];

  // Venue-section entries, only rendered inside a venue route. Daily-
  // ops links (Bookings → Reports) stay flat; Communications and Setup
  // collapse to keep the rail short.
  const venueEntries: NavEntry[] = venueId
    ? [
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/bookings`,
          label: "Bookings",
          icon: CalendarDays,
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/timeline`,
          label: "Timeline",
          icon: Clock,
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/floor-plan`,
          label: "Floor plan",
          icon: TableProperties,
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/waitlist`,
          label: "Waitlist",
          icon: Hourglass,
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/guests`,
          label: "Guests",
          icon: Users,
          locked: isLocked(data.org.plan, "crm"),
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/reports`,
          label: "Reports",
          icon: CalendarRange,
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/reports/insights`,
          label: "Insights",
          icon: TrendingUp,
          locked: isLocked(data.org.plan, "insights"),
        },
        {
          kind: "item",
          href: `/dashboard/venues/${venueId}/service-summary`,
          label: "Service summary",
          icon: Gauge,
          locked: isLocked(data.org.plan, "serviceSummary"),
        },
        {
          kind: "group",
          groupKey: "venue-comms",
          label: "Communications",
          icon: MessageSquare,
          items: [
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/enquiries`,
              label: "Enquiries",
              icon: Inbox,
              locked: isLocked(data.org.plan, "enquiries"),
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/reviews`,
              label: "Reviews",
              icon: Star,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/campaigns`,
              label: "Campaigns",
              icon: Megaphone,
              locked: isLocked(data.org.plan, "campaigns"),
            },
          ],
        },
        {
          kind: "group",
          // groupKey kept as "venue-setup" so existing expand/collapse
          // state survives the Setup → Settings rename.
          groupKey: "venue-setup",
          label: "Settings",
          icon: Settings,
          items: [
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/settings`,
              label: "General",
              icon: Wrench,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/services`,
              label: "Services",
              icon: UtensilsCrossed,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/photos`,
              label: "Photos",
              icon: Images,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/deposits`,
              label: "Deposits",
              icon: CreditCard,
              locked: isLocked(data.org.plan, "deposits"),
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/settings/messaging`,
              label: "Messaging",
              icon: MessageSquare,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/settings/payments`,
              label: "Payments",
              icon: Banknote,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/settings/google`,
              label: "Google",
              icon: Globe,
            },
            {
              kind: "item",
              href: `/dashboard/venues/${venueId}/settings/pos`,
              label: "POS",
              icon: Receipt,
            },
          ],
        },
      ]
    : [];

  return (
    <>
      {/* Mobile hamburger — only visible at sm and below. */}
      <button
        type="button"
        aria-label={drawerOpen ? "Close menu" : "Open menu"}
        onClick={() => toggleFlag(DRAWER_KEY)}
        className="border-hairline text-ink fixed top-3 left-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-full border bg-white shadow-sm md:hidden"
      >
        <Menu className="h-4 w-4" aria-hidden />
      </button>

      {/* Backdrop on mobile while the drawer is open. */}
      {drawerOpen ? (
        <div
          aria-hidden
          onClick={() => writeFlag(DRAWER_KEY, false)}
          className="bg-ink/30 fixed inset-0 z-30 md:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "border-hairline fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-white transition-[width,transform] duration-200 ease-out md:sticky md:top-0 md:h-screen md:transform-none",
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
          className="border-hairline text-ash hover:border-ink hover:text-ink absolute top-1/2 right-0 z-40 hidden h-7 w-7 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-white shadow-sm transition md:inline-flex"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>

        {/* Brand header. The org name slot is either a static label
            or — for users with 2+ memberships — a click-to-switch
            dropdown. Brand mark + "TableKit" wordmark always link to
            /dashboard; only the org-name row is the switcher trigger,
            so we don't accidentally swallow the brand-link click. */}
        <div
          className={cn(
            "border-hairline flex items-center gap-2 border-b px-4 py-4",
            collapsed ? "justify-center px-3" : "justify-start",
          )}
        >
          <Link href="/dashboard" className="flex shrink-0 items-center">
            <span className="bg-coral inline-flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold text-white">
              T
            </span>
          </Link>
          {!collapsed ? (
            <div className="flex min-w-0 flex-col">
              <Link
                href="/dashboard"
                className="text-ink text-sm leading-none font-bold tracking-tight"
              >
                TableKit
              </Link>
              {data.memberships.length >= 2 ? (
                <OrgSwitcher
                  current={data.org}
                  memberships={data.memberships}
                  switchActiveOrg={switchActiveOrg}
                />
              ) : (
                <span className="text-ash mt-0.5 truncate text-[11px]">{data.org.name}</span>
              )}
            </div>
          ) : null}
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2">
          <Section
            label="Organisation"
            entries={filterEntries(orgEntries)}
            pathname={pathname}
            collapsed={collapsed}
          />
          {venueId ? (
            <Section
              label={activeVenue?.name ?? "Venue"}
              entries={filterEntries(venueEntries)}
              pathname={pathname}
              collapsed={collapsed}
            />
          ) : null}
        </nav>

        {/* Footer: user + sign-out */}
        <div className="border-hairline border-t p-2">
          {!collapsed ? (
            <div className="text-ash px-2 pb-2 text-[11px]">
              <p className="text-ink truncate font-semibold">{data.user.name}</p>
              <p className="truncate">{data.user.email}</p>
            </div>
          ) : null}
          <form action={signOut}>
            <button
              type="submit"
              className={cn(
                "rounded-input text-charcoal hover:bg-cloud hover:text-ink flex w-full items-center gap-2 px-2 py-1.5 text-sm transition",
                collapsed && "justify-center",
              )}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              {!collapsed ? "Sign out" : null}
            </button>
          </form>
        </div>
      </aside>

      {/* No layout spacer needed: at md+ the aside is
          `position: sticky` which participates in normal flow and
          already takes its own flex width. A spacer in addition to
          this was double-counting, producing a sidebar-width empty
          band right of the rail. On mobile the aside is
          `position: fixed` (out of flow) and main fills the full
          width; the drawer slides over content. */}
    </>
  );
}

function Section({
  label,
  entries,
  pathname,
  collapsed,
}: {
  label: string;
  entries: NavEntry[];
  pathname: string;
  collapsed: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {!collapsed ? (
        <p className="text-ash px-2 py-1.5 text-[10px] font-semibold tracking-wider uppercase">
          {label}
        </p>
      ) : null}
      {entries.map((entry) =>
        entry.kind === "item" ? (
          <NavLink
            key={entry.href}
            item={entry}
            active={pathname.startsWith(entry.href)}
            collapsed={collapsed}
          />
        ) : collapsed ? (
          // Collapsed (icon-only) rail has no room for group headers.
          // Inline the children so the icons stay reachable.
          <div key={entry.groupKey} className="contents">
            {entry.items.map((it) => (
              <NavLink
                key={it.href}
                item={it}
                active={pathname.startsWith(it.href)}
                collapsed={collapsed}
              />
            ))}
          </div>
        ) : (
          <CollapsibleGroup key={entry.groupKey} group={entry} pathname={pathname} />
        ),
      )}
    </div>
  );
}

function CollapsibleGroup({ group, pathname }: { group: Group; pathname: string }) {
  const Icon = group.icon;
  const groupKey = `${GROUP_KEY_PREFIX}${group.groupKey}`;
  const stored = useFlagStore(groupKey);
  // Auto-expand when the active route lives inside the group, so the
  // user always sees their current spot without having to remember to
  // open the disclosure.
  const containsActive = group.items.some((it) => pathname.startsWith(it.href));
  const open = stored || containsActive;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggleFlag(groupKey)}
        className="rounded-input text-charcoal hover:bg-cloud hover:text-ink flex w-full items-center gap-2.5 px-2 py-1.5 text-sm transition"
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="ml-3 flex flex-col gap-0.5 border-l border-neutral-200 pl-2">
          {group.items.map((it) => (
            <NavLink
              key={it.href}
              item={it}
              active={pathname.startsWith(it.href)}
              collapsed={false}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Drop entries the user shouldn't see (plan-gated, multi-venue-gated)
// and groups whose every child got filtered out.
function filterEntries(entries: NavEntry[]): NavEntry[] {
  const out: NavEntry[] = [];
  for (const e of entries) {
    if (e.kind === "item") {
      if (e.show !== false) out.push(e);
    } else {
      const items = e.items.filter((i) => i.show !== false);
      if (items.length > 0) out.push({ ...e, items });
    }
  }
  return out;
}

function NavLink({ item, active, collapsed }: { item: Item; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : item.locked ? `${item.label} — upgrade to unlock` : undefined}
      onClick={() => writeFlag(DRAWER_KEY, false)}
      className={cn(
        "rounded-input flex items-center gap-2.5 px-2 py-1.5 text-sm transition",
        active ? "bg-cloud text-ink font-semibold" : "text-charcoal hover:bg-cloud hover:text-ink",
        item.locked && !active && "text-ash",
        collapsed && "justify-center",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-coral")} aria-hidden />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
      {!collapsed && item.locked ? (
        <Lock className="text-ash ml-auto h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : null}
    </Link>
  );
}

// Click-to-switch dropdown rendered in place of the static org-name
// label when the user has 2+ memberships. Uses native <details> so we
// get free keyboard + a11y semantics without bringing in a popover
// dependency. The dropdown closes implicitly on switch — the server
// action redirects to /dashboard and the page re-renders fresh.
function OrgSwitcher({
  current,
  memberships,
  switchActiveOrg,
}: {
  current: { id: string; name: string };
  memberships: Array<{ orgId: string; orgName: string }>;
  switchActiveOrg: (input: { orgId: string }) => Promise<void>;
}) {
  return (
    <details className="group relative mt-0.5">
      <summary className="text-ash hover:text-ink flex cursor-pointer list-none items-center gap-1 truncate text-[11px] [&::-webkit-details-marker]:hidden">
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="h-3 w-3 shrink-0" aria-hidden />
      </summary>
      <div
        role="menu"
        className="border-hairline absolute top-full left-0 z-50 mt-1 w-52 overflow-hidden rounded-md border bg-white py-1 shadow-lg"
      >
        {memberships.map((m) => {
          const isCurrent = m.orgId === current.id;
          return (
            <button
              key={m.orgId}
              type="button"
              role="menuitem"
              disabled={isCurrent}
              onClick={() => {
                if (isCurrent) return;
                void switchActiveOrg({ orgId: m.orgId });
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs",
                isCurrent
                  ? "text-ink cursor-default font-semibold"
                  : "text-charcoal hover:bg-cloud hover:text-ink",
              )}
            >
              <span className="truncate">{m.orgName}</span>
              {isCurrent ? <Check className="text-coral h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </details>
  );
}

function matchVenueId(pathname: string): string | null {
  // /dashboard/venues/<uuid>/...  — capture the uuid segment.
  const m = pathname.match(/^\/dashboard\/venues\/([0-9a-f-]{36})/i);
  return m ? (m[1] ?? null) : null;
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

// Cache subscribers by key so each useSyncExternalStore call gets a
// stable reference (re-subscribing on every render would thrash).
const subCache = new Map<string, (notify: () => void) => () => void>();
function getSub(key: string) {
  let s = subCache.get(key);
  if (!s) {
    s = subscribe(key);
    subCache.set(key, s);
  }
  return s;
}

function useFlagStore(key: string): boolean {
  return useSyncExternalStore(
    getSub(key),
    () => readFlag(key),
    // Server snapshot — sidebar starts expanded + drawer + groups closed.
    () => false,
  );
}

// String-valued sibling of the flag store, for the last-venue pointer.
// Shares the same storage-event subscription plumbing.

function readValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  } catch {
    // No storage — the pointer just isn't remembered.
  }
}

function useValueStore(key: string): string | null {
  return useSyncExternalStore(
    getSub(key),
    () => readValue(key),
    // Server snapshot — nothing remembered yet; the client fills it in
    // after hydration (and the first-venue fallback covers SSR).
    () => null,
  );
}
