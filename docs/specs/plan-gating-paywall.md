# Spec: Plan-gating paywall (show-but-lock)

**Status:** in progress — entitlements map + `LockedFeature` overlay + `/dashboard/upgrade` plans page (PR-a), gated pages wired to the lock (PR-b), sidebar shows locked nav items (PR-c).
**Depends on:** `auth.md` (plan tiers + `requirePlan`)

## What we're building

Higher-tier features become **visible but locked** for lower-tier orgs instead of being hidden or 500-crashing. A locked feature appears in the sidebar with a lock icon, and its page renders a **blurred placeholder teaser** behind an **"Upgrade to unlock"** card that links to a plans page.

Plus features are locked for Free + Core orgs; Core features are locked for Free orgs — driven by the existing plan ladder (`free < core < plus`, `lib/auth/plan-level.ts`).

## Why this matters

Today lower-tier users never see what they're missing (the sidebar drops gated items) and, if they reach a gated URL directly, the page throws `InsufficientPlanError` and 500s. Neither sells the upgrade. Showing a tasteful locked state turns every gated surface into an upsell.

## The lockable features

| Feature key | Min plan | Page | Sidebar item |
|---|---|---|---|
| `enquiries` | plus | `/venues/[id]/enquiries` | Venue › Communications › Enquiries |
| `insights` | plus | `/venues/[id]/reports/insights` | Venue › Insights |
| `serviceSummary` | plus | `/venues/[id]/service-summary` | Venue › Service summary |
| `crm` | plus | `/venues/[id]/guests`, `/dashboard/guests` | Venue › Guests |
| `campaigns` | plus | `/venues/[id]/campaigns` | — |
| `apiKeys` | plus | `/organisation/api-keys` | — |
| `deposits` | core | `/venues/[id]/deposits` | Venue › Setup › Deposits |
| `messaging` | core | Settings › SMS/WhatsApp block | — (inline) |

Structural gates stay as-is (hidden, not locked): **Overview** and **cross-venue Guests** only appear once the org has ≥2 venues (`multiVenue`); cross-venue visibility also needs the `groupCrmEnabled` org opt-in.

## Technical approach

- **Single source of truth:** `lib/auth/entitlements.ts` — `FEATURES: Record<Feature, { label, minPlan, blurb }>` and `isLocked(plan, feature)`. Pure (no DB, no `server-only`) so both the server pages and the client sidebar import it. Built on `hasPlan` from `plan-level.ts`.
- **Non-throwing read:** `getPlan(orgId): Promise<Plan>` added to `lib/auth/require-plan.ts` (same `adminDb` read as `requirePlan`, minus the throw) so a page can decide to lock instead of crash.
- **`<LockedFeature feature currentPlan />`** (`components/billing/locked-feature.tsx`, server component): a blurred generic placeholder (`blur-sm select-none pointer-events-none`, `aria-hidden`) under a centered upgrade card (coral `Badge` with the min plan, heading, blurb, primary `Button` → `/dashboard/upgrade?feature=<key>`). A compact `inline` variant for in-page sections (Settings messaging). Static — no client JS, can't be dismissed to reveal content.
- **Page guard pattern:** `requireRole(...)` → `getPlan(orgId)` → `if (isLocked(plan, <feature>)) return <LockedFeature/>` **before** any real query. Replaces the throwing `requirePlan` page guards (and the campaigns `<Upsell>`).
- **Sidebar:** pass the org `plan` into `SidebarData`; mark plan-gated items `locked` (kept visible) rather than `show:false` (still used for structural hides). `NavLink` renders a trailing lock icon for locked items but still links to the page.
- **Plans page:** `/dashboard/upgrade` — Free £0 / Core £19 / Plus £39 comparison, current plan highlighted, `?feature=` called out. CTA = "Contact us to upgrade" (mailto). **Real Stripe subscription billing is out of scope** — a later feature.

## Security: the lock is UX only

The page lock is presentational. **Server actions, API routes and webhooks keep their existing throwing `requirePlan` checks** (e.g. enquiries + messaging actions), so a locked user cannot drive the feature by a crafted request. No gated data is fetched on a locked page (the overlay returns before the query). No new tables, RLS, migrations, or PII (placeholder data only).

## Out of scope (year 1)

Stripe subscription checkout / billing portal, proration, self-serve plan downgrade, per-seat pricing. The Upgrade CTA is informational + contact-driven until billing lands.
