# Demo scheduler (Cal.com)

**Status:** built, flag-off — merged to main 2026-07-19 (PRs #125 plumbing + #127 embed). Ships behind `NEXT_PUBLIC_DEMO_EMBED_ENABLED` (unset ⇒ demo CTA is a link-out, no Cal.com anywhere). **Go-live remaining:** sign the Cal.com DPA, then flip the flag after the 30-day sub-processor notice. Cal.com **EU data region confirmed** on the account, so no SCCs/IDTA/TRA beyond a residency check; sub-processor rows added to `/legal/sub-processors` + `docs/playbooks/gdpr.md`. Note: Cal.com processes only prospect (demo-booking) data — never venue/guest data. Repo has no DOM test harness, so the consent gate is a pure unit-tested module (`lib/marketing/scheduler-consent.ts`) + a Playwright smoke.

## Depends on

- [`marketing-frontend.md`](../playbooks/marketing-frontend.md) — owns the "Book a 15-min demo" CTA; this spec upgrades it from a link-out to a consent-gated embed.
- [`gdpr.md`](../playbooks/gdpr.md) — collects PII (name, email, booking time) on a marketing surface and introduces a candidate non-EU sub-processor. See the WhatsApp/Meta precedent for the non-EU exception process.
- [`security.md`](../playbooks/security.md) — first third-party script + iframe on the marketing site; needs CSP `frame-src`/`script-src` allow-listing.

## What we're building

Today the marketing "Book a 15-min demo" CTA is a link-out (`NEXT_PUBLIC_DEMO_URL`, `mailto:` fallback) — the visitor leaves our site, so no PII passes through TableKit and Cal.com is **not** a sub-processor (per `gdpr.md`: an outbound hyperlink the visitor navigates themselves is not sub-processing). This spec adds an **optional, consent-gated Cal.com embed** so a prospect can book the demo without leaving the page, while keeping the page cookieless and script-free until the visitor explicitly opts in. The embed uses a **click-to-load** gate: by default we render a branded placeholder with a "Load scheduler" button and the existing link-out as a no-JS fallback; Cal's script and cookies load only on that explicit click (consent on interaction). No demo data is stored in TableKit — Cal.com holds the booking.

## User stories

- As a **prospective operator**, I can book a 15-minute demo from a calendar embedded on the marketing site, without leaving the page.
- As a **privacy-conscious visitor**, I see no third-party scheduler script or cookie until I explicitly choose to load it; the demo is still bookable via the link-out if I don't.
- As the **founder**, I can change the Cal event/link or turn the embed off via env without a redeploy of logic.
- As the **DPO**, I can point to a documented lawful basis, a sub-processor entry, and a transfer assessment before the embed goes live.

## Data model

**No new tables.** TableKit stores no demo-booking PII — the name/email/slot live in Cal.com. The consent choice is a client-side `localStorage` flag (`tablekit:consent:scheduler`), not a DB row, so there is no org-scoped or PII table and no RLS surface. (If we later ingest demo bookings as sales leads via a Cal webhook, that is a separate spec and **will** need an RLS-policied `demo_leads` table in the same migration.)

## API surface

- **`/demo`** (new page, `app/(marketing)/(site)/demo/page.tsx`) — RSC shell hosting the scheduler island, plus the `CtaBand` and trust copy. The site's "Book a 15-min demo" CTA points here (internal link) instead of the external URL when the embed is enabled.
- **`<DemoScheduler>`** (new `"use client"` island) — renders the placeholder + "Load scheduler" button by default; on click, dynamically imports `@calcom/embed-react` and mounts the inline embed, and persists consent to `localStorage`. The link-out (`DEMO_HREF`) is always present as a no-JS / no-consent fallback.
- **Config** (`lib/marketing/site.ts`): `CAL_LINK` (e.g. `tablekit/15min`) and `DEMO_EMBED_ENABLED` from env; when disabled, the CTA falls back to today's link-out behaviour with zero code change elsewhere.
- **CSP** (`security.md` / middleware): add Cal's origins to `frame-src` and `script-src`. No server actions, no webhooks, no new cron in v1.

## Acceptance criteria

- [ ] With default page load (and with JS disabled), **no** Cal.com script, iframe, or cookie is present — verified in the network panel; the link-out fallback works without JS.
- [ ] The Cal embed loads **only** after an explicit "Load scheduler" click; the consent choice persists across navigations via `localStorage`.
- [ ] A prospect can complete a demo booking in the inline embed and see Cal's confirmation.
- [ ] `@calcom/embed-react` is **dynamically imported** (not in the initial bundle); Lighthouse on `/` is unaffected (the embed lives on `/demo`, not the home critical path).
- [ ] CSP updated to allow Cal origins; no other third-party origins introduced; `pnpm typecheck && pnpm lint && pnpm test` pass.
- [ ] **GDPR gate (blocks go-live):** Cal.com row added to `/legal/sub-processors` and the `gdpr.md` table; lawful basis recorded (Art. 6(1)(b)/(f) — booking a requested demo); **EU data region used if available, else SCCs/UK IDTA + a completed transfer risk assessment** (Cal.com Cloud defaults to the US — treat as the documented non-EU exception, mirroring the WhatsApp/Meta precedent); 30-day customer notice given before first production egress.
- [ ] A new dependency (`@calcom/embed-react`) is justified in the PR per the marketing playbook's no-new-deps rule.

## Marketing impact

- **Customer-visible:** no (marketing-site infrastructure — the demo CTA, not a product feature)
- **Tier:** n/a
- **Registry entry:** none — do not add to `lib/marketing/features.ts`
- **Benefit line:** n/a
- **Needs feature page:** no

## Out of scope

- Storing demo bookings as CRM/sales leads in TableKit (would need a webhook + an RLS-policied table — separate spec).
- Replacing the link-out everywhere: the link-out stays as the fallback and as the behaviour when `DEMO_EMBED_ENABLED` is off.
- A full consent-management platform / cookie categorisation UI — click-to-load is the consent mechanism for v1; the notice-only `CookieNotice` is unchanged.
- Self-hosting Cal.com in our own EU infrastructure (an alternative to the SCCs/TRA route) — note it as the residency-preserving option but not built here.
