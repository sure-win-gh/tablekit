# Claude Code kickoff prompt — build the Tablekit marketing front end

> Paste everything below the line into Claude Code, run from the repo root. It assumes `docs/playbooks/marketing-frontend.md` exists (it does). Don't paste this heading or this note.

---

We're building the public **marketing front end** for Tablekit. The back end and operator app already exist; the current `app/(marketing)/page.tsx` is a placeholder. Your job is to turn it into a visually striking, conversion-focused marketing site — warm and hospitality-led — that drives independent UK café/pub/restaurant owners to **start a free account**.

## Read first, then stop and plan

1. Read `CLAUDE.md` in full — the stack, repo layout, style rules, and the development loop are binding.
2. Read `docs/playbooks/marketing-frontend.md` in full. **This playbook is the source of truth for this work** — brand, voice, page inventory, the feature registry, and the sync process. Everything below defers to it.
3. Read `app/globals.css` — understand the existing `@theme` token system (coral accent `#ff385c`, the `ink → cloud` neutral scale, radius + shadow scales, Inter at weight 500). You will **extend** these tokens with a warm layer, not replace them.
4. Read the existing `app/(marketing)/` routes and `app/(marketing)/layout.tsx`, plus `components/site-footer` and `components/cookie-notice`, so you build with the grain of what's there.
5. Skim `docs/specs/index.md` to know which features are **shipped and customer-visible** — these populate the feature registry.

Then **do not write feature code yet.** Per CLAUDE.md rule 7, run `/plan` (this touches far more than 3 files). Write the plan to `.claude/plans/marketing-frontend.md` covering: the `(marketing)/(site)` route grouping, the warm tokens you'll add to `@theme` (with proposed hex), the shape of `lib/marketing/features.ts` and the seed entries you'll derive from shipped specs, the component inventory under `components/marketing/`, page-by-page section breakdown, and your SEO/metadata approach. **Then stop and wait for my confirmation before implementing.**

## What to build (v1)

Three marketing pages, sharing a marketing-specific header + footer, built on the existing `(marketing)` route group without disturbing the functional routes (`signup`, `login`, `privacy`, `legal`, `security`, `docs/api`, `unsubscribe`):

- **Home (`/`)** — hero with primary CTA, the operator's problem (no-shows, per-cover fees, long contracts), how-it-works in 3 steps, feature highlights (rendered from the registry), a trust/proof band, a pricing teaser, an FAQ, and a closing CTA.
- **Pricing (`/pricing`)** — three columns: Free / Core **£29 + VAT** / Plus **£74 + VAT**, the "SMS & Stripe fees passed through at cost" note, a full feature matrix rendered from the registry, pricing FAQ, and a CTA per tier.
- **Features (`/features` and `/features/[slug]`)** — an index rendered from the registry, plus a deep-dive page per live feature with benefit-led copy, a real-app screenshot slot, and the tier badge.

### The non-negotiable: build the sync mechanism, not just the pages

The reason this work exists is to keep marketing current as features ship. So:

1. **Create `lib/marketing/features.ts`** — the typed registry described in the playbook (`MarketingFeature[]`). Seed it from the **shipped, customer-visible** features in `docs/specs/index.md` (bookings, deposits/no-show protection, waitlist & walk-ins, guest CRM, reviews, reporting/insights, multi-venue, AI enquiry handler, public API, etc.), each tagged to its tier and its `docs/specs/*.md` file. Home highlights, the pricing matrix, and the features index must **all render from this one array** — no duplicated hand-written feature lists.
2. **Add a `## Marketing impact` section to the `/spec` command's required sections** (`.claude/commands/spec.md`), using the template in the playbook, so every future spec declares its marketing impact.
3. **Add a marketing-sync step to the `/ship` command** (`.claude/commands/ship.md`) — a customer-visible feature isn't "done" until its `lib/marketing/features.ts` entry and any `/features/<slug>` page are updated. Mirror the existing "tests + migration + security" gate.

## Brand, voice, and visual direction

Follow the playbook's Brand and Voice sections exactly. In short: warm, plain-spoken, confident British voice talking to a non-technical owner-operator; warm hospitality aesthetic layered on the existing coral/neutral token system; food-and-venue imagery via clearly-labelled placeholder slots until real photography exists (never fake screenshots or stock that misrepresents the product); coral stays the single primary-action colour. Add warm tokens (cream background, a honey/clay support tone, a cocoa display ink) to the `@theme` block — propose exact hex in your plan. **Zero hand-rolled hex in components.**

## Hard constraints

- **Stack:** the canonical stack only (Next.js 16 App Router, RSC-first, Tailwind v4 tokens in `@theme`, shadcn/ui, TypeScript strict — no `any`). `"use client"` only where interaction truly needs it.
- **Conversion:** primary CTA everywhere is **free sign-up** into the existing `signup` flow (no card required — say so); secondary CTA is "Book a 15-min demo". No dark patterns, no fake social proof, no countdown timers.
- **Pricing honesty:** always show **+ VAT**; always note SMS/Stripe are at cost.
- **Accessibility & performance:** mobile-first, WCAG 2.1 AA, respect `prefers-reduced-motion`, core content + CTAs work without JS. Target Lighthouse ≥ 95 performance and 100 a11y/SEO/best-practices on `/`.
- **SEO:** per-page `metadata` (title/description/OG/canonical), proper heading hierarchy, sitemap + robots, JSON-LD `Organization` + `Product`/`Offer`.
- **No new dependencies or analytics** without justifying in the PR; analytics also needs a GDPR sub-processor entry and must be cookieless/consent-gated.
- **Don't touch** payments, auth, or guest-data code. If a marketing page needs to link into `signup`, link — don't modify its logic.

## Done means

Work the full loop from CLAUDE.md: implement in small conventional commits, run `pnpm typecheck && pnpm lint && pnpm test`, run the Playwright e2e smoke (`pnpm test:e2e`) since the UI changed, then run the `@code-reviewer` subagent on the diff. Satisfy the acceptance-criteria checklist in `docs/playbooks/marketing-frontend.md`. Open a PR against `main` referencing the playbook — do not merge.

If anything in the playbook or these instructions is ambiguous or seems to conflict with the existing code, **stop and ask me** rather than improvising — don't guess on brand or pricing.

---

# Follow-up prompt — paste this after Claude Code produces its first plan

> Send this as a second message once the model has written `.claude/plans/marketing-frontend.md`, to make it revise the plan before any code is written. It hardens three things: proven conversion layouts, technical SEO, and LLM/AI-search discoverability. Fold the durable rules into `docs/playbooks/marketing-frontend.md` so they survive past this build.

Before you write any code, revise `.claude/plans/marketing-frontend.md` so it's grounded in proven patterns, not invented from scratch. Don't reach for new dependencies, trackers, or fake proof to do any of this. Cover the three areas below, and add the durable rules (not the page-by-page specifics) to `docs/playbooks/marketing-frontend.md` as new sections so future pages inherit them.

## 1. Proven high-converting layouts

For each page, state the **established structure** you're following and why it converts for this audience (a sceptical, mobile-first UK owner-operator), then map our content onto it. Use conventions that are proven for freemium B2B SaaS — don't reinvent page architecture.

- **Home:** above-the-fold value proposition that passes the 5-second test — one clear headline (outcome, not feature), one subhead, one primary CTA (free sign-up, "no card required"), and a supporting visual — all visible without scrolling on a phone. Then the proven order: problem → how-it-works (3 steps) → feature highlights → proof/trust → pricing teaser → objection-handling FAQ → repeated closing CTA. The primary CTA repeats at least 3 times down the page; the same single action every time.
- **Pricing:** three-tier comparison with the recommended tier (Core) visually anchored, value framed before price, annual/monthly clarity, "+ VAT" honesty, and an FAQ that defuses the real objections (cancellation, migration off OpenTable/ResDiary, what counts toward the free 50/month). Reduce choice paralysis — one obvious default.
- **Features:** benefit-led, not feature-led — every section leads with the operator outcome (fewer no-shows, fewer phone interruptions, money saved vs OpenTable) and only then names the feature.

Conversion rules to bake into the plan and the playbook: one primary action per page (free sign-up); minimise form fields; reduce cognitive load and choice overload; make CTAs specific ("Start free — no card needed", not "Submit"); surface trust near every CTA (no card, cancel anytime, UK data residency, GDPR posture); honest proof only — no fabricated logos, testimonials, counts, or urgency timers. Where we lack real social proof, substitute honest proof (the free tier itself, the no-card promise, the security/GDPR stance). State the **measurement plan** too: what the primary conversion event is and how we'd know a page works — without adding a tracker that isn't GDPR-cleared.

## 2. Technical SEO

Add an SEO section to the plan and the playbook covering:

- **Per-page metadata** via Next.js `metadata` / `generateMetadata`: unique title + meta description, canonical URL, Open Graph + Twitter card with a real OG image per page.
- **Semantic structure:** exactly one `<h1>` per page, logical heading hierarchy, landmark elements, descriptive link text, alt text on every image.
- **Structured data (JSON-LD):** `Organization` + `WebSite` sitewide; `Product` with `Offer` entries on pricing (each tier, GBP, VAT noted); `FAQPage` on pages with an FAQ; `BreadcrumbList` on `/features/[slug]`. Validate against Google's Rich Results expectations.
- **Crawl & indexing:** `app/sitemap.ts` and `app/robots.ts`, clean canonical URLs, no duplicate content between `/features` index and detail pages.
- **Performance as SEO:** Core Web Vitals budget (LCP, CLS, INP) — static/RSC rendering, sized images to prevent layout shift, lazy-load below-the-fold, code-split client islands. Target the Lighthouse goals already in the playbook.
- **Keyword intent (lightly):** map each page to the search intent an operator actually has ("table booking system for small restaurant UK", "OpenTable alternative cheap", "restaurant booking no per-cover fee") and reflect that in headings and copy naturally — no stuffing.

## 3. LLM / AI-search optimisation (GEO)

Increasingly, owners discover tools by asking an AI assistant ("what's a cheap OpenTable alternative for a UK café?"). Plan for the pages to be **quotable and citable** by LLMs and AI search:

- **Answer-first, self-contained copy:** lead sections with a clear, factual, standalone claim an LLM can lift and attribute ("Tablekit is a UK table-booking platform for independent hospitality, free for up to 50 bookings a month, with paid plans from £29 + VAT"). Avoid burying the what/who/how-much in marketing fluff.
- **Explicit, structured facts:** state pricing, tiers, limits, what's included per tier, supported integrations, and data residency as plain text on the page (not only inside images or interactive widgets an LLM can't read). The JSON-LD above doubles as machine-readable grounding.
- **Comparison & question framing:** include honest, factual framing around the questions people ask AI ("How is Tablekit different from OpenTable/ResDiary?", "Is there a free table booking system?") — as real on-page content and `FAQPage` schema, answered concisely and truthfully.
- **Clean, fetchable HTML:** core content server-rendered and present without JS so crawlers and AI fetchers see it; semantic markup; descriptive headings that read as questions/answers where natural.
- **Consistent entity facts:** name, what we do, pricing, and UK/GDPR posture stated consistently across pages so an LLM forms a stable, correct picture of the product. Don't game it — accuracy is the strategy; fabricated claims get us cited wrongly or not at all.

## Then

Update `.claude/plans/marketing-frontend.md` with these three sections folded into each page's breakdown, add the durable conversion/SEO/GEO rules to `docs/playbooks/marketing-frontend.md`, extend the playbook's acceptance criteria to include them, and **stop again for my confirmation** before implementing.
