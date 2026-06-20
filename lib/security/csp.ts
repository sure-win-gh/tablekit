// Content-Security-Policy for the authenticated app surfaces (/dashboard,
// /admin). Distinct from the widget policy in next.config.ts: those surfaces
// embed third-party scripts (Stripe Elements, hCaptcha) and must stay on
// 'unsafe-inline' for now, whereas the dashboard loads ZERO inline scripts and
// ZERO third-party client scripts (Stripe on the dashboard is a full-page
// redirect to hosted Checkout/Portal; hCaptcha is widget-only; Sentry is a
// self-hosted chunk tunnelling to /monitoring). So the dashboard gets a tight
// nonce-based script-src with no third-party origins.
//
// This is a pure string builder with no node/edge-only APIs so it imports
// cleanly into the edge proxy (proxy.ts). The nonce is generated per request
// there; Next.js stamps it onto its own framework <script> tags.

// Mirrors next.config.ts: the same report sink, path-relative so the report
// lands on the same origin that served the violating page. `report-uri` is the
// widely-supported legacy directive; `report-to` is the Reporting-API
// successor (Chrome is deprecating report-uri) — we emit both, and the sink at
// /api/csp-report accepts either wire format. `report-to` names an endpoint
// group declared via the `Reporting-Endpoints` response header (set in
// proxy.ts).
const REPORT_URI = "/api/csp-report";
const REPORT_GROUP = "csp-endpoint";

/**
 * Build the dashboard/admin CSP directive string for a given per-request
 * nonce. `script-src` drops 'unsafe-inline' entirely — only the nonce'd
 * Next.js bootstrap and its 'strict-dynamic'-trusted chunks run. `style-src`
 * keeps 'unsafe-inline' deliberately: React renders inline style attributes
 * (style={{}}) which can't be nonced, and style injection is low XSS risk.
 *
 * `supabaseUrl` (NEXT_PUBLIC_SUPABASE_URL) is added to `connect-src` for the
 * browser Supabase client — token refresh (https) and Realtime (wss), e.g. the
 * POS guest-spend panels. Omitted → `connect-src 'self'` only.
 */
export function dashboardCsp(nonce: string, opts: { supabaseUrl?: string } = {}): string {
  const supabase = opts.supabaseUrl
    ? [opts.supabaseUrl, opts.supabaseUrl.replace(/^https/, "wss")]
    : [];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    // No 'unsafe-inline'. 'strict-dynamic' lets the nonce'd bootstrap load
    // Next's chunks; 'self' is the fallback for pre-CSP3 browsers.
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]],
    // Kept 'unsafe-inline' — React inline style attributes can't be nonced.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    // Same-origin (server actions, Sentry tunnels to /monitoring = self) plus
    // the Supabase origin for the browser client's https + wss (Realtime).
    ["connect-src", ["'self'", ...supabase]],
    ["frame-src", ["'self'"]],
    // The dashboard is never framed (matches X-Frame-Options: DENY).
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
    ["report-uri", [REPORT_URI]],
    ["report-to", [REPORT_GROUP]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
