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
  // Marketing origin. The booking surface lives at book.tablekit.uk and
  // the API at api.tablekit.uk; this is the public marketing host.
  url: process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://tablekit.uk",
  // The canonical, attributable claim. Kept factual so it can be quoted.
  tagline: "Table booking for independent UK hospitality, without the per-cover fees.",
  oneLiner:
    "TableKit is a UK table-booking platform for independent cafés, pubs and restaurants — free for up to 50 bookings a month, with paid plans from £29 + VAT and no long contracts.",
  contactEmail: "hello@tablekit.uk",
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
