import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

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
// - api.tablekitapp.com is the production API host (different subdomain
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

// `report-uri` is the legacy reporting directive but still has the
// widest browser support; `report-to` is the modern Reporting-API
// successor. We emit both — same endpoint accepts either wire format.
// Path-relative so the report lands at the same origin that served
// the violating page, dodging cross-origin reporting restrictions.
const REPORT_URI = "/api/csp-report";

// Serialise a directive list to a CSP header string. Shared by every policy
// below so their formatting can't drift.
function serializeCsp(directives: Array<[string, string[]]>): string {
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

function buildCsp({ frameAncestors }: { frameAncestors: string }): string {
  // 'unsafe-inline' on script-src is the unfortunate cost of Next.js
  // server-rendered hydration scripts. The nonce-based approach is
  // viable but requires a custom `_document` shim in the App Router;
  // we're report-only for now, so keep this and tighten in a follow-up.
  // 'unsafe-inline' on style-src covers Tailwind + Stripe Elements +
  // hCaptcha which all inject inline styles.
  return serializeCsp([
    ["default-src", ["'self'"]],
    ["connect-src", ["'self'", "https://api.tablekitapp.com", ...STRIPE, ...HCAPTCHA]],
    ["script-src", ["'self'", "'unsafe-inline'", ...STRIPE_SCRIPTS, ...HCAPTCHA]],
    ["style-src", ["'self'", "'unsafe-inline'", ...HCAPTCHA]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["frame-src", ["'self'", ...STRIPE_FRAMES, ...HCAPTCHA]],
    ["frame-ancestors", [frameAncestors]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
    ["report-uri", [REPORT_URI]],
  ]);
}

const EMBED_CSP = buildCsp({ frameAncestors: "*" });
const BOOK_CSP = buildCsp({ frameAncestors: "'self'" });

// CSP for the /demo marketing page (demo-scheduler.md). The marketing site has
// no site-wide CSP today, so this is a net-new, report-only, page-scoped policy.
// The only third party is the consent-gated Cal.com scheduler embed, pinned to
// Cal.com's **EU region** for data residency (docs/specs/demo-scheduler.md):
//   - app.cal.eu serves the embed script (script-src) + iframe/API (frame/connect).
//   - cal.eu is the booking-page origin the iframe navigates to (frame-src) and
//     posts to (connect-src).
// Must stay in lockstep with CAL_ORIGIN/CAL_EMBED_JS_URL in lib/marketing/site.ts.
// The embed injects inline styles (covered by 'unsafe-inline'). Kept report-only,
// matching the /book /embed /events posture — a missed origin logs, never blocks.
const CAL = ["https://app.cal.eu", "https://cal.eu"];
const DEMO_CSP = serializeCsp([
  ["default-src", ["'self'"]],
  ["script-src", ["'self'", "'unsafe-inline'", ...CAL]],
  ["style-src", ["'self'", "'unsafe-inline'"]],
  ["img-src", ["'self'", "data:", "https:"]],
  ["font-src", ["'self'", "data:"]],
  ["connect-src", ["'self'", ...CAL]],
  ["frame-src", ["'self'", ...CAL]],
  ["frame-ancestors", ["'self'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'self'"]],
  ["object-src", ["'none'"]],
  ["report-uri", [REPORT_URI]],
]);

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
      {
        // Public special-event landing pages — same hosted-page posture as
        // /book (frame-ancestors 'self'; no Stripe/captcha needed here).
        source: "/events/:path*",
        headers: [{ key: "Content-Security-Policy-Report-Only", value: BOOK_CSP }],
      },
      {
        // Marketing demo page (demo-scheduler.md). `:path*` matches the bare
        // /demo and any future sub-route (e.g. a /demo/thanks confirmation), so
        // the policy can't silently miss one — same pattern as the siblings.
        // Self-only for now; the Cal embed PR extends DEMO_CSP with Cal origins.
        source: "/demo/:path*",
        headers: [{ key: "Content-Security-Policy-Report-Only", value: DEMO_CSP }],
      },
    ];
  },
};

// Wrap with Sentry so production source maps upload during the Vercel
// build and stack traces are readable. All upload behaviour is gated
// on SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT being present —
// with no token the wrapper is inert, so local `next build` and CI
// without Sentry secrets behave exactly as before.
//
// silent: only log upload output in CI. widenClientFileUpload: better
// stack frames. tunnelRoute: routes browser events through our own
// origin so ad-blockers don't drop them.
export default withSentryConfig(nextConfig, {
  // Spread the env-derived options only when set: under
  // exactOptionalPropertyTypes these keys are typed `string`, not
  // `string | undefined`, so passing an absent var explicitly is a type
  // error (and the wrapper treats absent and undefined identically).
  ...(process.env["SENTRY_ORG"] ? { org: process.env["SENTRY_ORG"] } : {}),
  ...(process.env["SENTRY_PROJECT"] ? { project: process.env["SENTRY_PROJECT"] } : {}),
  ...(process.env["SENTRY_AUTH_TOKEN"] ? { authToken: process.env["SENTRY_AUTH_TOKEN"] } : {}),
  silent: !process.env["CI"],
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  disableLogger: true,
});
