# Implementation plan: Demo scheduler (Cal.com)

**Spec:** `docs/specs/demo-scheduler.md` (draft, 2026-06-13)
**Depends on:** `docs/playbooks/marketing-frontend.md`, `docs/playbooks/gdpr.md`, `docs/playbooks/security.md`
**Planned:** 2026-07-17

## Summary

Upgrade the marketing "Book a 15-min demo" CTA from a link-out to an **optional, consent-gated,
click-to-load Cal.com embed** on a new `/demo` page. The page stays cookieless + script-free until
the visitor explicitly clicks "Load scheduler"; the existing link-out (`DEMO_HREF`) is the no-JS /
no-consent fallback. **No PII touches TableKit** — Cal.com holds the name/email/slot. The consent
choice is a client-side `localStorage` flag, not a DB row → **no new table, no RLS surface, no
migration.**

Ships **flag-off by default** (`NEXT_PUBLIC_DEMO_EMBED_ENABLED` unset ⇒ today's link-out behaviour,
zero behaviour change). The embed only activates when the flag is on **and** the visitor clicks to
load — mirroring the WhatsApp/Meta "dormant until enabled" sub-processor precedent.

## ⛔ Blockers to surface before coding (per skill rules)

1. **NEW SUB-PROCESSOR — Cal.com (non-EU / US).** Cal.com Cloud defaults to US. This is a new
   non-EU sub-processor receiving prospect PII (name/email/booking time) once the embed goes live.
   Requires: `/legal/sub-processors` row + `docs/playbooks/gdpr.md` table entry, lawful basis
   (Art. 6(1)(b)/(f)), SCCs / UK IDTA + a completed Transfer Risk Assessment, and 30-day customer
   notice before first production egress. **This is a go-live gate, not a build blocker** — the
   feature ships flag-off so no egress happens until the flag flips. **Decision needed from Ben**
   (see "Open questions" — do NOT flip the flag or add the /legal row in the build PR until
   confirmed).
2. **NEW DEPENDENCY — `@calcom/embed-react`** (marketing playbook no-new-deps rule). Must be
   justified in the PR body and **version-pinned** (repo convention — exact version, no `^`).
   Dynamically imported so it stays out of the initial bundle.

**Not affected:** PCI scope (no payments) — unchanged, still SAQ-A. No plaintext PII handling
anywhere (no PII stored; `lib/security/crypto.ts` untouched).

## Files to create

- `/Users/bensherwin/dev-tablekit/app/(marketing)/(site)/demo/page.tsx` — RSC shell: heading + trust
  copy + `<DemoScheduler>` island + `<CtaBand>`. `export const metadata`. Server-safe, no PII.
- `/Users/bensherwin/dev-tablekit/components/marketing/demo-scheduler.tsx` — `"use client"` island.
  Renders a branded placeholder + "Load scheduler" button by default; on click dynamically
  `import("@calcom/embed-react")`, mounts the inline `<Cal>` embed, and persists consent. Always
  renders the `DEMO_HREF` link-out as the no-JS / no-consent fallback.
- `/Users/bensherwin/dev-tablekit/tests/unit/demo-scheduler.test.tsx` — island unit tests (below).

## Files to modify

- `/Users/bensherwin/dev-tablekit/lib/marketing/site.ts` — add:
  - `CAL_LINK = process.env["NEXT_PUBLIC_CAL_LINK"] ?? "tablekit/15min"` (Cal event slug).
  - `DEMO_EMBED_ENABLED = process.env["NEXT_PUBLIC_DEMO_EMBED_ENABLED"] === "1"`.
  - `DEMO_PAGE_HREF = "/demo"` (internal).
  - Derived CTA target so call sites stay DRY:
    `DEMO_CTA_HREF = DEMO_EMBED_ENABLED ? DEMO_PAGE_HREF : DEMO_HREF` and
    `DEMO_CTA_EXTERNAL = DEMO_EMBED_ENABLED ? false : DEMO_IS_EXTERNAL`.
  - Keep `DEMO_HREF` / `DEMO_IS_EXTERNAL` (still the fallback + used inside the island).
- `/Users/bensherwin/dev-tablekit/components/marketing/cta-band.tsx` — swap the demo `CtaLink` to
  `href={DEMO_CTA_HREF} external={DEMO_CTA_EXTERNAL}`.
- `/Users/bensherwin/dev-tablekit/app/(marketing)/(site)/page.tsx` — same swap on the hero demo CTA
  (line ~57): import `DEMO_CTA_HREF` / `DEMO_CTA_EXTERNAL`, use them in place of `DEMO_HREF` /
  `DEMO_IS_EXTERNAL`. (Other CTA call sites reference `CtaBand`, so they inherit the change.)
- `/Users/bensherwin/dev-tablekit/next.config.ts` — add a `/demo` entry to `headers()` with a
  **report-only** CSP that allow-lists Cal origins (see CSP section). New builder variant, no change
  to the existing `/embed` `/book` `/events` policies.
- `/Users/bensherwin/dev-tablekit/.env.local.example` — document `NEXT_PUBLIC_CAL_LINK`,
  `NEXT_PUBLIC_DEMO_EMBED_ENABLED`, and (already present) `NEXT_PUBLIC_DEMO_URL` — names only, no
  values.
- `/Users/bensherwin/dev-tablekit/package.json` — add pinned `@calcom/embed-react` (+ lockfile via
  `pnpm install`).

## Migrations

**None.** No new tables, columns, or enums. TableKit stores no demo-booking data; the only state is
a client-side `localStorage` flag (`tablekit:consent:scheduler`).

## RLS policies

**None.** No new org-scoped or PII table. (Per spec: if we later ingest demo bookings as sales leads
via a Cal webhook, that is a **separate** spec and will need an RLS-policied `demo_leads` table in
the same migration — explicitly out of scope here.)

## CSP (security.md)

The marketing-site routes currently have **no CSP header at all** — `next.config.ts` only sets
report-only CSPs on `/embed`, `/book`, `/events`. So this adds a net-new, **report-only**,
`/demo`-scoped policy (consistent with the repo's pre-launch report-only posture — it observes
without risk of breaking the page). Allow-list only Cal origins; introduce no other third parties:

```
default-src 'self';
script-src  'self' 'unsafe-inline' https://app.cal.com;
style-src   'self' 'unsafe-inline' https://app.cal.com;
frame-src   'self' https://app.cal.com https://cal.com;
connect-src 'self' https://app.cal.com;
img-src     'self' data: https:;
font-src    'self' data:;
frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none';
report-uri /api/csp-report
```

Notes:
- Verify the exact runtime origins from `@calcom/embed-react` in the browser network panel before
  finalising (Cal loads `app.cal.com/embed/embed.js` and iframes `app.cal.com`; `cal.com` kept on
  `frame-src` for redirect safety). Tighten to observed origins only.
- Because it's report-only, a missed origin surfaces in the console (and `/api/csp-report`) rather
  than blocking the booking — the safe way to confirm the allow-list before a later enforce flip.

## Tests

Unit (`tests/unit/demo-scheduler.test.tsx`, Vitest + Testing Library, jsdom):
- Default render shows the placeholder + "Load scheduler" button and **does not** import/mount the
  Cal embed (assert the dynamic import isn't called — mock `@calcom/embed-react`).
- The `DEMO_HREF` link-out fallback is present in the DOM on first render (no-JS/no-consent path).
- Clicking "Load scheduler" mounts the embed **and** writes `tablekit:consent:scheduler` to
  `localStorage`; a re-mount with the flag already set auto-loads the embed (consent persists).
- Storage-throws path (private mode): click still mounts the embed, no unhandled throw.

E2E smoke (Playwright, `tests/e2e/` — smoke only per CLAUDE.md):
- `/demo` renders with **no** `app.cal.com` request in the network log until "Load scheduler" is
  clicked; the link-out is visible; after click, the Cal iframe appears. (Run with the flag on.)

CI grep (extend the existing no-PII / no-new-origin guard if one exists): assert no third-party
origin other than `cal.com`/`app.cal.com` is introduced in `next.config.ts`.

## Risks / watch at review

- **Consent-before-load is the whole point.** Regression risk: the Cal script/cookie loading on page
  load instead of on click. The unit test asserting "no import until click" is the guard — keep it.
  Use `useSyncExternalStore` for the `localStorage` consent read (the repo's established pattern in
  `components/cookie-notice.tsx`) — do **not** setState-in-effect.
- **Bundle bloat.** `@calcom/embed-react` must be `dynamic import()` inside the click handler, not a
  top-level import, or it lands in the `/demo` initial chunk. Lighthouse on `/` must be unaffected
  (embed lives on `/demo`, off the home critical path) — verify.
- **Flag-off must be a true no-op.** With `NEXT_PUBLIC_DEMO_EMBED_ENABLED` unset, every CTA must
  behave exactly as today (link-out via `DEMO_HREF`). The `/demo` page still exists but nothing links
  to it — acceptable; confirm no nav/footer auto-links it.
- **CSP false sense of security.** It's report-only, so it does not actually block a rogue origin
  yet. Fine for now (matches repo posture), but note it in the PR so it's not mistaken for enforced.
- **hydration / SSR.** Island must render the placeholder identically on server + first client paint
  (server snapshot = "not loaded") to avoid a hydration mismatch — same discipline as CookieNotice's
  `getServerSnapshot`.
- **GDPR gate is real.** Do not flip the flag or add the `/legal` row until the sub-processor
  decision + TRA + 30-day notice are done (see blockers).

## Rollback plan

- **Instant, no deploy:** unset `NEXT_PUBLIC_DEMO_EMBED_ENABLED` (or set ≠ `1`). Every CTA reverts to
  the `DEMO_HREF` link-out; the embed never loads. This is the primary kill switch.
- **Full revert:** the change is additive and migration-free — revert the PR. New files
  (`/demo/page.tsx`, `demo-scheduler.tsx`, test) delete cleanly; the `site.ts` / `cta-band.tsx` /
  `page.tsx` / `next.config.ts` edits are small and self-contained; `pnpm remove @calcom/embed-react`.
  No DB state to unwind.

## Estimated diff size

~**300 lines across 8 files** (incl. tests):
- `demo-scheduler.tsx` island ~110
- `/demo/page.tsx` ~55
- unit test ~70
- e2e smoke ~35
- `site.ts` ~12, `cta-band.tsx` ~2, `(site)/page.tsx` ~2, `next.config.ts` ~20, env example ~3,
  `package.json` ~1

Near the 300-line PR ceiling. **Recommended split (optional)** if you want each PR < 200 lines:
- **PR 1 — plumbing (flag-off, no Cal):** `site.ts` config + CTA swap in `cta-band.tsx` /
  `(site)/page.tsx` + `next.config.ts` `/demo` CSP + env example + a minimal `/demo` page that
  renders only the link-out fallback (no dep yet). ~90 lines, zero third-party, safe to merge alone.
- **PR 2 — the embed:** add `@calcom/embed-react`, the click-to-load island, and tests; wire the
  island into the `/demo` page. ~210 lines, contains the only third-party surface — easier to review
  in isolation. **Go-live gate (sub-processor row + gdpr.md + TRA + 30-day notice + flag flip) is a
  separate follow-up, not in either PR.**

I lean toward the **2-PR split**: it isolates the sub-processor-bearing code (PR 2) from the safe
plumbing (PR 1), matching the repo's "small, reversible, one concern" commit rule.

## Decisions (Ben, 2026-07-17)

1. ✅ **Cal.com accepted as a documented non-EU (US) sub-processor** under SCCs/UK IDTA + TRA + 30-day
   notice — same exception process as WhatsApp/Meta. **Build proceeds flag-off.** The
   `/legal/sub-processors` + `docs/playbooks/gdpr.md` rows, the TRA, and the 30-day customer notice
   are the **go-live gate at flag-flip — NOT in either build PR.**
2. ✅ **2-PR split** (PR 1 plumbing / PR 2 embed, as described in "Estimated diff size").

### Still to confirm (does not block PR 1)

- **Cal.com data region:** confirm whether the account offers an EU data region (shrinks the
  transfer-risk surface) or is US Cloud under SCCs — needed for the TRA + the region text in the
  sub-processor row at go-live, not for the build.

## Build order

- **PR 1 (plumbing, safe to merge alone, flag-off):** `site.ts` config (`CAL_LINK`,
  `DEMO_EMBED_ENABLED`, `DEMO_PAGE_HREF`, derived `DEMO_CTA_HREF`/`DEMO_CTA_EXTERNAL`) + CTA swap in
  `cta-band.tsx` + `(site)/page.tsx` + `next.config.ts` `/demo` report-only CSP + `.env.local.example`
  + a link-out-only `/demo` page (no dep). No third-party surface.
- **PR 2 (embed):** add pinned `@calcom/embed-react`, the click-to-load `DemoScheduler` island +
  unit/e2e tests, wire the island into `/demo`.
- **Go-live (separate, gated):** sub-processor rows + gdpr.md + TRA + 30-day notice, then flip
  `NEXT_PUBLIC_DEMO_EMBED_ENABLED=1`.
