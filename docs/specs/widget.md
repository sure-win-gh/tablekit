# Spec: Embeddable widget + shareable booking link

**Status:** shipped (`prefers-color-scheme` + CSP header deferred — see below)
**Depends on:** `bookings.md`, `venues.md`

## What we're building

Two distribution surfaces for taking bookings:

1. **Embeddable widget** — a `<script>` tag the operator pastes into their own website. Opens a lightweight modal with the booking flow.
2. **Shareable booking link** — a hosted booking page at `book.tablekit.uk/<venue-slug>` the operator can drop into their Instagram bio, QR codes, or Google Business Profile.

Both surfaces use the same React code and the same public API.

## User stories

- As an operator I can paste one line of HTML into my site and bookings appear on my dashboard.
- As an operator I can share a link to a hosted booking page that works on any device with no JS required on my end.
- As a diner I can book in under 60 seconds on mobile.
- As a diner I am told clearly when a deposit is required and redirected to Stripe.

## Acceptance criteria

- [x] Widget script < 30 KB gzipped. [`public/widget.js`](../../public/widget.js) is 1,896 bytes raw → ~959 bytes gzipped. Two orders of magnitude under budget; the loader's job is just to mount an iframe + relay height postMessages, so it should stay tiny.
- [x] Widget uses no cookies and no client-side storage. The loader writes nothing to `localStorage` / `sessionStorage` / `document.cookie`; iframe content lives behind `(widget)/embed` and inherits the same posture.
- [x] Shareable page works without JavaScript for the first screen. [`app/(widget)/book/[venueIdOrSlug]/page.tsx`](../../app/(widget)/book/[venueIdOrSlug]/page.tsx) is an async server component that renders venue + service info + initial slot list before any client JS runs; [`forms.tsx`](../../app/(widget)/book/[venueIdOrSlug]/forms.tsx) hydrates as a client island for date/time interactivity.
- [x] No third-party analytics or fingerprinting. No `gtag` / `posthog` / `fathom` / `plausible` / fingerprinting library imports anywhere in `app/(widget)/` or `public/widget.js`. Sentry runs on the dashboard side only.
- [~] **Widget respects `prefers-reduced-motion`.** All four `transition` classes in the public surface (slot picker + review-form star/submit/share buttons) carry `motion-reduce:transition-none`. The embed iframe + loader do no animation, so the resize behaviour is reduced-motion-clean by construction.
- [ ] **Widget respects `prefers-color-scheme`.** Not consumed today — requires a dark palette in the `@theme` block of `app/globals.css` and a `dark:` audit across widget components. Pulled when the design-system polish lands.
- [ ] **CSP header restricts `connect-src` to `api.tablekit.uk` + Stripe.** No CSP is set anywhere — `next.config.ts` is the empty default. Add a route-scoped `Content-Security-Policy` header for `/embed/*` (and the public `book.tablekit.uk/*`) covering `connect-src`, `frame-src` (Stripe Elements), `script-src` (self + Stripe), `frame-ancestors *` for the embed iframe.
- [ ] Lighthouse performance ≥ 90 — needs a manual run pre-launch; not codifiable in CI without a Lighthouse-CI step. Tracked as a launch-readiness check.
- [ ] WCAG 2.1 AA — relies on shadcn/Radix primitives (good defaults) plus our colour tokens. Manual axe-core or Lighthouse a11y sweep before launch; tracked alongside Lighthouse perf above.

## Technical notes

- Build the widget as a separate route group `(widget)` with its own root layout — no dashboard chrome.
- Use a standalone Next.js route at `/embed/<venue-slug>` that is iframed by the widget script.
- The loader script (`/widget.js`) lazily mounts an iframe; all content lives inside that iframe.
- Post messages between iframe and parent for height resizing only.
- The shareable page at `book.tablekit.uk/<venue-slug>` is the same React components without the iframe wrapper.

## Out of scope

- Theming by operator beyond a single accent colour (Plus tier later).
- Embedded payments (card form outside Stripe Checkout) — we are SAQ-A, see `payments.md`.

## Deferred

Three follow-ups, all small but each warranting its own PR + review:

### Dark-mode palette

`prefers-color-scheme: dark` requires a dark token set in the `@theme` block of `app/globals.css` plus a `dark:` audit across the widget components. Bigger — pull when the wider design-system polish lands so we tune the dashboard + widget together.

### CSP for the public booking surfaces

Route-segment headers for `/embed/[venueIdOrSlug]` and `/book/[venueIdOrSlug]` (or `next.config.ts` `headers()` if the policy is uniform). Suggested directives:

- `default-src 'self'`
- `connect-src 'self' https://api.tablekit.uk https://api.stripe.com`
- `script-src 'self' https://js.stripe.com`
- `frame-src https://js.stripe.com https://hooks.stripe.com`
- `frame-ancestors *` (the operator's site embeds the iframe)
- `img-src 'self' data: https:`

Pair with a 24-hour `report-only` rollout via `Content-Security-Policy-Report-Only` first to catch accidental third-party calls before enforcing.
