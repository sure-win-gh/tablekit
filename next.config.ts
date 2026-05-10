import type { NextConfig } from "next";

// Content-Security-Policy for the public booking surfaces.
//
// Two routes serve diner-facing HTML:
//   • /book/[venueIdOrSlug]   — hosted shareable page (top-level navigation)
//   • /embed/[venueIdOrSlug]  — iframed by the operator's site
//
// Both run the same React tree + the same upstream calls (Stripe
// Elements, hCaptcha, our own /api/v1/*), so the bulk of the policy
// is shared. The only divergence is `frame-ancestors`:
//   • /book   — `'self'` (clickjack-safe; we don't expect anyone to
//     embed the hosted page).
//   • /embed  — `*` (the whole point is third-party embedding).
//
// Phase 1 ships as `Content-Security-Policy-Report-Only` so any
// missed third-party (a future analytics import, a CDN-hosted font)
// surfaces in browser dev tools without blocking. Once we've watched
// real traffic for ~24h the next PR flips this to enforcing — same
// directive set, different header name.
//
// We don't wire a `report-uri` / `report-to` endpoint yet; violations
// just print to the diner's console. That's enough for an internal
// dogfooding pass before launch.

// Every host or scheme any first-screen feature reaches.
//
// - 'self' covers same-origin /api/v1/* in dev + the React bundle.
// - api.tablekit.uk is the production API host (different subdomain
//   from the widget surfaces).
// - api.stripe.com / m.stripe.* — Stripe Elements telemetry +
//   PaymentIntent confirmations.
// - hcaptcha.com / *.hcaptcha.com — anti-spam widget; only loaded
//   when NEXT_PUBLIC_HCAPTCHA_SITEKEY is set, but listing it here
//   in all environments keeps the policy stable across deploys.
const STRIPE = ["https://api.stripe.com", "https://m.stripe.network", "https://m.stripe.com"];
const STRIPE_FRAMES = ["https://js.stripe.com", "https://hooks.stripe.com"];
const STRIPE_SCRIPTS = ["https://js.stripe.com"];
const HCAPTCHA = ["https://hcaptcha.com", "https://*.hcaptcha.com"];

function buildCsp({ frameAncestors }: { frameAncestors: string }): string {
  // 'unsafe-inline' on script-src is the unfortunate cost of Next.js
  // server-rendered hydration scripts. The nonce-based approach is
  // viable but requires a custom `_document` shim in the App Router;
  // we're report-only for now, so keep this and tighten in a follow-up.
  // 'unsafe-inline' on style-src covers Tailwind + Stripe Elements +
  // hCaptcha which all inject inline styles.
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["connect-src", ["'self'", "https://api.tablekit.uk", ...STRIPE, ...HCAPTCHA]],
    ["script-src", ["'self'", "'unsafe-inline'", ...STRIPE_SCRIPTS, ...HCAPTCHA]],
    ["style-src", ["'self'", "'unsafe-inline'", ...HCAPTCHA]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["frame-src", ["'self'", ...STRIPE_FRAMES, ...HCAPTCHA]],
    ["frame-ancestors", [frameAncestors]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

const EMBED_CSP = buildCsp({ frameAncestors: "*" });
const BOOK_CSP = buildCsp({ frameAncestors: "'self'" });

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/embed/:path*",
        headers: [{ key: "Content-Security-Policy-Report-Only", value: EMBED_CSP }],
      },
      {
        source: "/book/:path*",
        headers: [{ key: "Content-Security-Policy-Report-Only", value: BOOK_CSP }],
      },
    ];
  },
};

export default nextConfig;
