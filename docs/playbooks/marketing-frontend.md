# Playbook: Marketing front end

**Status:** active
**Owns:** `app/(marketing)/(site)/*` (the public marketing pages — home, pricing, features), the marketing design layer in `app/globals.css`, and `components/marketing/*`.
**Does not own:** `signup`, `login`, `privacy`, `legal`, `security`, `docs/api`, `unsubscribe` — those existing `(marketing)` routes are functional surfaces, not marketing pages. Touch them only when a marketing page links into them.

This is the single source of truth for the public-facing marketing site: what it is, how it's built, and — most importantly — **how it stays in sync as the product gains features.** If you only read one section, read [Keeping marketing in sync](#keeping-marketing-in-sync).

---

## Why this exists

Tablekit's selling point is that an independent café/pub/restaurant owner can run real table booking for roughly a tenth of what OpenTable, ResDiary or Collins charge. The marketing site has one job: get that owner to **start a free account**. Every page, section and word is in service of that single conversion. Secondary CTA is "Book a 15-min demo" for the hesitant; there is no hard demo gate.

The risk this playbook guards against: we ship a great new feature (deposits, AI enquiry handler, multi-venue) and the marketing site never mentions it, so the thing that would have converted a visitor is invisible. The fix is process, not heroics — see [Keeping marketing in sync](#keeping-marketing-in-sync).

---

## Audience & voice

**Who we're talking to:** a time-poor, non-technical owner-operator of one to a few UK hospitality venues. They are sceptical of "tech", allergic to long contracts and per-cover fees, and they make decisions on their phone between services.

**Voice:** warm, plain-spoken, confident, British. Like a fellow operator who's been there, not a Silicon Valley pitch. Short sentences. Concrete nouns (covers, no-shows, deposits, walk-ins) over abstractions (synergy, platform, solution). Never patronising, never hypey. UK spelling throughout (organise, colour, optimise). Prices always shown **+ VAT** because that's the honest number an operator budgets against.

**Things we never do:** fake testimonials, fake logos, fake numbers, countdown timers, dark patterns, "limited time" pressure. Trust is the product. If we don't have real social proof yet, we use honest proof (the free tier itself, the no-card-required promise, the data-residency/GDPR posture) rather than inventing it.

---

## Brand & visual direction

The chosen direction is **warm hospitality** — inviting, food-and-venue-led, human — layered on top of the existing Airbnb-inspired token system in `app/globals.css`. We **extend** those tokens; we do not replace the coral accent or the neutral/radius/shadow scales that the dashboard already uses. A visitor who signs up should feel the marketing site and the app are the same brand.

### Tokens (extend, don't fork)

Existing tokens stay as-is: `--color-coral` / `--color-coral-deep` (primary CTA only), the `ink → cloud` neutral scale, the radius scale (`tag/input/card/pill/search`), `--shadow-panel`, and Inter at body weight 500.

Add a small **warm layer** in the `@theme` block of `app/globals.css` for marketing surfaces — propose exact hex in the build PR, but the intent is:

- A warm off-white page background (`--color-cream`, a hair warmer than `#fff`) for marketing sections, so the site feels softer than the dashboard's clean white.
- A warm secondary/support tone (`--color-honey` / `--color-clay` family) for section accents, illustration fills and "soft" CTAs — used sparingly so coral stays the one true action colour.
- A deep warm ink for large display headings (`--color-cocoa`) as an alternative to `--color-ink` where a hero needs more warmth.

Every new colour goes in `@theme` behind a Tailwind utility. **No hand-rolled hex in components — ever.** This is a hard rule inherited from `globals.css`.

### Typography

Inter stays as the system face. Marketing headlines may use a larger display scale and tighter tracking than the dashboard, but no second font family unless a future PR explicitly adds and justifies one (and updates this playbook). Body copy stays weight 500.

### Imagery

Food and venue photography is the emotional core of "warm hospitality." Until real photography exists, every page uses **clearly-marked image slots** (`components/marketing/Placeholder`) sized and captioned for what should go there (e.g. "16:9 — busy café floor, golden hour, real UK venue"). Never ship stock that misrepresents the product or fake screenshots of features that don't exist. Product screenshots must be of the real app.

### Motion & accessibility (non-negotiable)

- Respect `prefers-reduced-motion` everywhere. Animation is a garnish, never required to understand or use the page.
- WCAG 2.1 AA: colour contrast, focus-visible states, semantic landmarks, alt text on every image, keyboard-operable nav and CTAs.
- Mobile-first. The owner is on a phone. Design the small screen first, scale up.
- Core content and CTAs render server-side (RSC) and work without JS.

---

## Page inventory (build order)

Marketing pages live in a `(site)` group inside `(marketing)` so they share a marketing-specific header/footer/layout without disturbing the functional routes. Confirm the exact grouping in the build plan.

| Page | Route | Primary job | Must contain |
|---|---|---|---|
| **Home** | `/` | Convert cold traffic to free sign-up | Hero + primary CTA, the problem (no-shows / cost / contracts), how it works in 3 steps, feature highlights (data-driven — see below), social-proof/trust band, pricing teaser, FAQ, final CTA |
| **Pricing** | `/pricing` | Convert price-shoppers | Free / Core £29 / Plus £74 three-column compare, all **+ VAT**, "SMS & Stripe fees at cost" note, full feature matrix, FAQ (VAT, cancellation, migration), CTA per tier |
| **Features** | `/features` + `/features/[slug]` | Convert researchers; SEO | Feature index rendered from the feature registry; per-feature deep-dive pages with real benefit copy, screenshot slot, and the tier each feature belongs to |

Supporting pages (about, contact, blog) are out of scope for v1 of this playbook — add rows here when they're built.

### The feature registry (why pages don't drift)

Home feature highlights, the pricing feature matrix, and the `/features` index all render from **one structured source of truth**, not hand-written JSX per page. Create `lib/marketing/features.ts` exporting a typed array — one entry per customer-visible feature:

```ts
// lib/marketing/features.ts
export type MarketingFeature = {
  slug: string;                 // url + stable key, e.g. "deposits"
  name: string;                 // "Deposits & no-show protection"
  tagline: string;              // one line for cards/matrix
  description: string;          // 1–2 sentences for the feature page
  tier: "free" | "core" | "plus";
  spec: string;                 // matching docs/specs file, e.g. "payments-deposits.md"
  status: "live" | "coming-soon";
  showOnHome: boolean;          // surfaces in the home highlights grid
  icon: string;                 // lucide icon name
};
```

Because every marketing surface reads from this array, **adding one entry updates the home grid, the pricing matrix and the features index at once.** That is the mechanical half of staying in sync. The process half is below.

---

## Keeping marketing in sync

This is the whole point of the playbook. Two layers — a content registry (mechanical) and a spec convention + ship-step (process). Both must be honoured.

### 1. Every feature spec carries a "Marketing impact" section

When `/spec <feature>` creates or updates a spec under `docs/specs/`, the spec **must** include a `## Marketing impact` section near the end, before "Out of scope". It answers three questions:

- **Is this customer-visible?** If yes, it needs a `lib/marketing/features.ts` entry. If it's internal/infra (e.g. `admin-dashboard.md`), say "None — internal" and you're done.
- **Which tier does it sell?** free / core / plus. This drives the pricing matrix.
- **What's the one-line benefit** an operator would care about (not the feature name — the outcome)?

Template to paste into specs:

```md
## Marketing impact

- **Customer-visible:** yes | no (internal/infra)
- **Tier:** free | core | plus
- **Registry entry:** add/update `lib/marketing/features.ts` slug `<slug>`
- **Benefit line:** "<the outcome an operator cares about>"
- **Needs feature page:** yes (`/features/<slug>`) | no (highlight/matrix only)
```

### 2. Updating marketing is a required step in `/ship`

A feature is **not done** until its marketing impact is reflected. Mirroring the project's existing "tests + migration + security check" gate, add a fourth: **marketing sync.** Concretely, when a customer-visible feature ships:

1. Add or update its entry in `lib/marketing/features.ts` (`status: "live"` once it's truly shipped, `"coming-soon"` if pre-launch).
2. If the spec says `Needs feature page: yes`, add `/features/<slug>` content using the real benefit copy and a screenshot slot of the real app.
3. If the tier or feature matrix changed, the pricing page updates automatically from the registry — verify it renders correctly.
4. Update the feature's row in `docs/specs/index.md` Status as you already do.

The `/ship` command's checklist should gain a marketing step (see the patch suggested to the build agent). If you ship a customer-visible feature and the registry doesn't change, that's a review failure — `code-reviewer` should flag a customer-visible diff with no `features.ts` change.

### 3. Quarterly drift check

Once a quarter, diff `docs/specs/index.md` (status = shipped, customer-visible) against `lib/marketing/features.ts`. Anything shipped-and-visible but missing from the registry is marketing debt. Fix it.

---

## Build & stack rules

Follow `CLAUDE.md` and propose specifics in the build plan. Defaults:

- **Stack:** the canonical stack — Next.js 16 App Router, RSC-first, Tailwind v4 with tokens in the `@theme` block of `app/globals.css` (no `tailwind.config.ts`), shadcn/ui components, TypeScript strict (no `any`). `"use client"` only where interaction genuinely needs it (mobile nav toggle, FAQ accordion, pricing toggle).
- **Performance budget:** marketing pages are mostly static — prefer static rendering / RSC, code-split any client islands, lazy-load below-the-fold imagery, target Lighthouse ≥ 95 on performance and 100 on accessibility/SEO/best-practices for `/`.
- **SEO:** per-page `metadata` (title, description, OpenGraph, canonical), sensible heading hierarchy, sitemap + robots, JSON-LD `Organization` + `Product`/`Offer` for pricing. No keyword stuffing.
- **Analytics:** none added without an entry in the GDPR sub-processor list (`docs/playbooks/gdpr.md`). If/when added, must be cookieless or consent-gated via the existing `CookieNotice`. Don't introduce a tag manager.
- **No new dependencies** without justifying them in the PR. Animation via CSS / existing libs before reaching for a new one.
- **Data residency / GDPR:** marketing pages collect no PII beyond what the existing `signup` flow already handles. A "book a demo" or newsletter form, if added, is a new data flow and needs a GDPR pass.

## Conversion principles (durable)

These apply to every marketing page, present and future. They are grounded in the standard freemium-SaaS
landing-page anatomy, the 5-second usability test, price-anchoring (the centre-stage effect) and Hick's law
(choice overload) — not invented per page.

- **One primary action per page:** free sign-up. The only secondary action is "Book a 15-min demo". No third CTA.
- **Repeat the primary CTA ≥3× down any long page** — the _same_ action each time, with a specific label
  ("Start free — no card needed"), never a generic "Submit"/"Get started".
- **Every hero passes the 5-second test:** one outcome headline (not a feature), one subhead, one primary CTA,
  one supporting visual, all visible without scrolling on mobile.
- **Proven page skeletons.** Home: hero → problem → how-it-works (3 steps) → feature highlights → proof/trust →
  pricing teaser → objection FAQ → closing CTA. Pricing: three-tier compare with the recommended tier (Core)
  visually anchored, value framed before price, cancel-anytime, **+ VAT**, fees-at-cost, full matrix, objection
  FAQ. Features: benefit-led — lead with the operator outcome (fewer no-shows, fewer phone interruptions, money
  saved vs OpenTable), then name the feature.
- **Trust adjacent to every CTA:** _no card required · cancel anytime · UK data residency · GDPR-ready._
- **Minimise cognitive load and choice:** short lines, concrete nouns, one idea per section, one obvious
  default. We add no forms — the `signup` flow owns data capture and we never modify its logic.
- **Honest proof only.** No fabricated logos, testimonials, counts, or urgency timers. Where social proof is
  absent, substitute honest proof (the free tier itself, the no-card promise, the security/GDPR posture).
- **Measurement.** The primary conversion event is an account created in the existing `signup` flow (already
  persisted server-side). Measure effectiveness with existing cookieless, server-side signals only (Vercel
  request stats; optionally Cloudflare Web Analytics — cookieless, and Cloudflare is already a sub-processor —
  behind a GDPR note). No new client tracker or sub-processor without an entry in `docs/playbooks/gdpr.md` and
  consent gating.

## Technical SEO standards (durable)

- Per-page metadata via Next.js `metadata`/`generateMetadata`: unique title, meta description, canonical,
  OpenGraph + Twitter card, and a **real OG image per page** (generated with `next/og` — never a fake
  screenshot).
- Semantic structure: exactly one `<h1>` per page, logical heading hierarchy, landmark elements, descriptive
  link text, alt text on every image.
- Structured data (JSON-LD): `Organization` + `WebSite` sitewide; `Product` with `Offer` entries on pricing
  (each tier, GBP, VAT noted); `FAQPage` on any page with an FAQ; `BreadcrumbList` on `/features/[slug]`.
  Validate against Google's Rich Results expectations.
- Crawl & indexing: `app/sitemap.ts` + `app/robots.ts`, clean canonical URLs, no duplicate content between the
  features index and detail pages.
- Performance as SEO — Core Web Vitals budget: **LCP < 2.5s, CLS < 0.1, INP < 200ms.** Static/RSC rendering,
  sized images to prevent layout shift, lazy-load below-the-fold, code-split client islands. Meet the
  Lighthouse targets above.
- Map each page to the operator's real search intent and reflect it naturally in headings/copy — no stuffing.

## AI-search / GEO standards (durable)

Owners increasingly discover tools by asking an AI assistant ("a cheap OpenTable alternative for a UK café?").
Pages must be quotable and citable, with accuracy as the only strategy.

- Answer-first, self-contained copy: lead key sections with a clear, factual, standalone claim an assistant can
  lift and attribute. State the what/who/how-much up front, not buried under marketing fluff.
- Explicit, structured facts as plain text (pricing, tiers, limits, what's included, integrations, data
  residency) — not only inside images or interactive widgets. JSON-LD mirrors them for machine grounding.
- Comparison & question framing: answer the real questions people ask AI ("How is TableKit different from
  OpenTable/ResDiary?", "Is there a free table-booking system?") as honest on-page content and `FAQPage` schema.
- Clean, fetchable HTML: core content server-rendered and present without JS; semantic markup; headings that
  read as questions/answers where natural.
- Consistent entity facts (name, what we do, pricing, UK/GDPR posture) across all pages, sourced from one
  module (`lib/marketing/site.ts`) so they can't drift. Never fabricate — wrong facts get us cited wrongly.

## Acceptance criteria (v1 marketing site)

- [ ] Home, Pricing, and Features (index + at least the live features) exist under `(marketing)`, sharing a marketing header/footer, not disturbing existing functional routes.
- [ ] All three pages render feature/pricing content from `lib/marketing/features.ts` — no hard-coded feature lists duplicated across pages.
- [ ] Primary CTA throughout is free sign-up into the existing `signup` flow; secondary is "Book a demo".
- [ ] Prices shown as Free / £29 / £74, each marked **+ VAT**, with the "SMS & Stripe at cost" note.
- [ ] Warm tokens added to `@theme`; zero hand-rolled hex in components; coral remains the only primary-action colour.
- [ ] Mobile-first, WCAG 2.1 AA, `prefers-reduced-motion` respected, works without JS for core content.
- [ ] Per-page SEO metadata + OG + JSON-LD; sitemap + robots present.
- [ ] `## Marketing impact` template added to `/spec`'s required sections, and a marketing-sync step added to `/ship`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass; `code-reviewer` run on the diff.

### Conversion / SEO / GEO (durable — see sections above)

- [ ] Each page follows its proven skeleton; the primary CTA repeats ≥3× on home, identical action + specific label.
- [ ] Trust signals sit adjacent to every CTA (no card · cancel anytime · UK residency · GDPR).
- [ ] Honest proof only — no fabricated logos, testimonials, counts, or urgency timers.
- [ ] Pricing anchors Core, frames value before price, states cancel-anytime, **+ VAT**, fees-at-cost, and explains the free 50/month.
- [ ] Per-page unique title, meta description, canonical, OpenGraph + Twitter, and a real OG image (`next/og`).
- [ ] JSON-LD: `Organization` + `WebSite` sitewide; `Product`/`Offer` on pricing; `FAQPage` on FAQ pages; `BreadcrumbList` on `/features/[slug]`; passes Rich Results.
- [ ] One `<h1>` per page; landmarks; alt text; descriptive links.
- [ ] `sitemap.ts` + `robots.ts` present; clean canonicals; no duplicate content between features index and detail.
- [ ] Core Web Vitals budget met (LCP < 2.5s, CLS < 0.1, INP < 200ms) alongside the Lighthouse targets.
- [ ] Answer-first copy; explicit facts as plain text; entity facts consistent across pages; core content renders without JS.
- [ ] Measurement plan documented; no analytics/tracker added without a GDPR sub-processor entry + consent gating.

## Out of scope (v1)

Blog/CMS, about/contact pages, customer logos and testimonials (until real ones exist), A/B testing infrastructure, localisation, dark mode for marketing, paid-ads landing-page variants. Add them as rows above when they land.
