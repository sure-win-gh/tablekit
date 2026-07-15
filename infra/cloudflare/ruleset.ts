// Cloudflare edge ruleset — SOURCE OF TRUTH.
//
// The Cloudflare zone is configured by hand in the dashboard (no
// Terraform: for a solo operator the state file + a standing zone-wide
// API token + drift-apply risk outweigh the benefit). This file is the
// versioned, reviewable record of what the dashboard MUST contain.
// Change process:
//   1. Edit this file in a PR (reviewable diff + rationale).
//   2. Apply the change in the dashboard after merge.
//   3. Verify with `pnpm tsx scripts/cloudflare-drift.ts` (read-only).
// The unit test (tests/unit/cloudflare-ruleset.test.ts) pins every
// skip-rule path to a real route in app/api so the list can't drift
// from the codebase.
//
// Companion prose (why the layer exists, incident response, IP-ban
// policy): docs/playbooks/cloudflare.md.
//
// Changelog:
//   2026-07-15  Initial codification of the playbook prose (R1-R5,
//               skip rules, bot fight mode, managed rulesets).

export type RateLimitRule = {
  id: string;
  /** Cloudflare filter expression (dashboard: Security → WAF → Rate limiting rules). */
  expression: string;
  threshold: number;
  periodSec: number;
  action: "managed_challenge" | "block";
  mitigationTimeoutSec: number;
  rationale: string;
};

export type SkipRule = {
  /** URL path prefix the skip applies to. */
  path: string;
  /** Repo-relative route handler (or config) that owns the path. */
  route: string;
  /** Why it is safe to skip WAF + rate limiting here. */
  verification: string;
};

/**
 * R1-R5. Edge thresholds sit deliberately ABOVE the app-level limits
 * (login 5/IP/15min, widget bookings 5/10min, availability 30/min):
 * the edge is the coarse flood net, the app is the precise boundary.
 * Managed Challenge (not Block) on auth pages so a human who
 * fat-fingered a password gets a checkbox, not a wall.
 */
export const RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  {
    id: "R1",
    expression: '(http.request.uri.path eq "/login" and http.request.method eq "POST")',
    threshold: 10,
    periodSec: 60,
    action: "managed_challenge",
    mitigationTimeoutSec: 600,
    rationale: "Credential stuffing; challenge (not block) to spare shared-IP humans.",
  },
  {
    id: "R2",
    expression: '(http.request.uri.path eq "/signup" and http.request.method eq "POST")',
    threshold: 10,
    periodSec: 60,
    action: "managed_challenge",
    mitigationTimeoutSec: 600,
    rationale: "Bot signups / email-spam via verification sends.",
  },
  {
    id: "R3",
    expression: '(http.request.uri.path eq "/api/v1/bookings" and http.request.method eq "POST")',
    threshold: 30,
    periodSec: 60,
    action: "block",
    mitigationTimeoutSec: 600,
    rationale: "Booking-spam floods; app layer enforces the precise 5/10min per IP.",
  },
  {
    id: "R4",
    expression:
      '(http.request.uri.path eq "/api/v1/availability" and http.request.method eq "GET")',
    threshold: 120,
    periodSec: 60,
    action: "block",
    mitigationTimeoutSec: 600,
    rationale: "Scraping; app layer enforces 30/min per IP underneath.",
  },
  {
    id: "R5",
    expression: '(starts_with(http.request.uri.path, "/api/v1/"))',
    threshold: 600,
    periodSec: 60,
    action: "block",
    mitigationTimeoutSec: 300,
    rationale: "Catch-all for the public API; mirrors the 600/min per-key app limit.",
  },
] as const;

/**
 * Skip rules (WAF → Custom rules → Skip remaining rules + rate
 * limiting). Every entry is safe ONLY because the receiving route
 * verifies a signature/secret in-app — the unit test enforces that
 * each path maps to a real route file so this list cannot rot.
 */
export const SKIP_RULES: readonly SkipRule[] = [
  {
    path: "/api/stripe/webhook",
    route: "app/api/stripe/webhook/route.ts",
    verification: "Stripe-Signature (per-region secrets under /uk + /us)",
  },
  {
    path: "/api/twilio/webhook",
    route: "app/api/twilio/webhook/route.ts",
    verification: "X-Twilio-Signature HMAC-SHA1",
  },
  {
    path: "/api/resend/webhook",
    route: "app/api/resend/webhook/route.ts",
    verification: "Svix signature",
  },
  {
    path: "/api/webhooks/resend-inbound",
    route: "app/api/webhooks/resend-inbound/route.ts",
    verification: "Svix signature (RESEND_INBOUND_SECRET)",
  },
  {
    path: "/api/webhooks/pos",
    route: "app/api/webhooks/pos",
    verification: "Provider HMAC (Square / Lightspeed), 256KB body cap",
  },
  {
    path: "/api/pos/ingest",
    route: "app/api/pos/ingest/route.ts",
    verification: "X-TableKit-POS-Signature shared-secret HMAC",
  },
  {
    path: "/api/health",
    route: "app/api/health/route.ts",
    verification: "Anonymous readiness probe — uptime monitor polls on an interval",
  },
  {
    path: "/monitoring",
    route: "next.config.ts (Sentry tunnelRoute)",
    verification: "Sentry browser-event tunnel; challenging it blinds error tracking",
  },
] as const;

/**
 * Zone-level toggles, recorded here for PR review. NOTE: the drift
 * script checks rules only — these toggles are verified by eye during
 * the quarterly review (Security → Overview / Bots / Edge Certificates).
 */
export const ZONE_SETTINGS = {
  botFightMode: true,
  // Paid add-ons — enabled only when the plan supports them; keep in
  // log mode first, then block after a false-positive soak.
  managedRuleset: "log-then-block",
  owaspCoreRuleset: "log-then-block",
  sslMode: "full_strict",
  minTlsVersion: "1.3",
  alwaysUseHttps: true,
  hstsPreload: true,
  dnssec: true,
  // Never IP-rate-limit Reserve-with-Google callbacks (Google retries
  // from many IPs). No RWG route exists yet — revisit when it lands.
  reserveWithGoogleNote: "exclude RWG paths from IP rate limits when implemented",
} as const;
