// Single source of the marketing site's *entity facts* — name, what we
// do, pricing, data-residency posture, and the canonical one-liner. Every
// page sources these from here so an LLM (and a human) forms one stable,
// correct picture of the product. See the GEO standards in
// docs/playbooks/marketing-frontend.md: consistency is the strategy.
//
// Server-safe plain constants only — no client state, no PII.

export const SITE = {
  name: "TableKit",
  legalName: "TableKit Ltd",
  // Marketing origin. The booking surface lives at book.tablekitapp.com and
  // the API at api.tablekitapp.com; this is the public marketing host.
  url: process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://tablekitapp.com",
  // The canonical, attributable claim. Kept factual so it can be quoted.
  tagline: "Table booking for independent UK hospitality, without the per-cover fees.",
  oneLiner:
    "TableKit is a UK table-booking platform for independent cafés, pubs and restaurants — free for up to 50 bookings a month, with paid plans from £29 + VAT and no long contracts.",
  contactEmail: "hello@tablekitapp.com",
} as const;

// Primary action everywhere: free sign-up into the existing flow.
export const SIGNUP_HREF = "/signup";

// Secondary action: book a 15-min demo. Link-out only (no embedded
// scheduler script → no third-party cookie on our pages). Configured via
// env once a scheduler account exists; until then it falls back to a
// mailto so the CTA still works. NOTE: the chosen scheduler needs a GDPR
// sub-processor entry before go-live (docs/playbooks/gdpr.md).
export const DEMO_HREF =
  process.env["NEXT_PUBLIC_DEMO_URL"] ??
  `mailto:${SITE.contactEmail}?subject=${encodeURIComponent("TableKit — book a 15-min demo")}`;

// True when DEMO_HREF points off-site (so links get rel/target treatment).
export const DEMO_IS_EXTERNAL = /^https?:/.test(DEMO_HREF);

// Internal demo page hosting the consent-gated Cal.com embed (demo-scheduler.md).
export const DEMO_PAGE_HREF = "/demo";

// Cal.com **EU region** config for the /demo embed (docs/specs/demo-scheduler.md
// — EU data residency; booking page is https://cal.eu/<slug>, embed script on
// the EU app subdomain). Origin + script URL are hardcoded, not env-driven,
// because the region is a data-residency commitment that MUST stay in lockstep
// with the /demo CSP in next.config.ts — switching region means changing both,
// deliberately. Only the event slug varies per account, so that stays env-set.
// Booking the (public) demo needs no API token — the embed just iframes the
// public booking page.
export const CAL_LINK = process.env["NEXT_PUBLIC_CAL_LINK"] ?? "tablekit/demo-call";
export const CAL_ORIGIN = "https://cal.eu";
export const CAL_EMBED_JS_URL = "https://app.cal.eu/embed/embed.js";

// Master switch for the embedded scheduler. Off (unset / ≠ "1") ⇒ every demo
// CTA behaves exactly as today: a link-out via DEMO_HREF, no /demo page in the
// flow, no Cal.com script anywhere. On ⇒ CTAs point at the internal /demo page,
// which still only loads Cal after an explicit consent click. Flipping this to
// "1" is the go-live step and is gated on the Cal.com sub-processor paperwork
// (docs/playbooks/gdpr.md) — see docs/specs/demo-scheduler.md.
export const DEMO_EMBED_ENABLED = process.env["NEXT_PUBLIC_DEMO_EMBED_ENABLED"] === "1";

// Where the "Book a 15-min demo" CTA points, and whether it's an off-site link.
// Embed on ⇒ internal /demo page; embed off ⇒ today's link-out. Call sites use
// these two so the flag lives in one place.
export const DEMO_CTA_HREF = DEMO_EMBED_ENABLED ? DEMO_PAGE_HREF : DEMO_HREF;
export const DEMO_CTA_EXTERNAL = DEMO_EMBED_ENABLED ? false : DEMO_IS_EXTERNAL;

// Honest proof, reused next to every CTA. No fabricated social proof.
export const TRUST_POINTS = [
  "No card required",
  "Cancel anytime",
  "UK data residency",
  "GDPR-ready",
] as const;

// Pricing facts — the single source for copy, the pricing matrix and the
// Product/Offer JSON-LD. Prices are VAT-exclusive (the honest number an
// operator budgets against); VAT is added at checkout via Stripe Tax.
export const PRICING = {
  currency: "GBP",
  vatNote: "+ VAT",
  feesNote: "SMS & Stripe fees are passed through at cost.",
  freeBookingLimit: 50,
} as const;
