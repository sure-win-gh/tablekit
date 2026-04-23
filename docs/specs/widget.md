# Spec: Embeddable widget + shareable booking link

**Status:** draft
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

- [ ] Widget script is < 30 KB gzipped.
- [ ] Widget uses `sessionStorage` only — no cookies.
- [ ] Widget respects the diner's system preferences (`prefers-color-scheme`, `prefers-reduced-motion`).
- [ ] Shareable page works without JavaScript for the first screen (SSR); JS enhances date/time pickers.
- [ ] Lighthouse performance ≥ 90 for both.
- [ ] WCAG 2.1 AA for colour contrast, focus order, labels.
- [ ] CSP on the widget page restricts `connect-src` to `api.tablekit.uk` and Stripe.
- [ ] No third-party analytics or fingerprinting.

## Technical notes

- Build the widget as a separate route group `(widget)` with its own root layout — no dashboard chrome.
- Use a standalone Next.js route at `/embed/<venue-slug>` that is iframed by the widget script.
- The loader script (`/widget.js`) lazily mounts an iframe; all content lives inside that iframe.
- Post messages between iframe and parent for height resizing only.
- The shareable page at `book.tablekit.uk/<venue-slug>` is the same React components without the iframe wrapper.

## Out of scope

- Theming by operator beyond a single accent colour (Plus tier later).
- Embedded payments (card form outside Stripe Checkout) — we are SAQ-A, see `payments.md`.
