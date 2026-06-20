// Next.js instrumentation hook. Runs once per server/edge runtime at
// startup. We use it to initialise Sentry for the Node and Edge
// runtimes (the browser is initialised separately in
// instrumentation-client.ts).
//
// Everything is guarded on SENTRY_DSN: with no DSN set, Sentry.init
// is a no-op, so local dev and CI run clean. The DSN must point at
// Sentry's EU ingest host (…ingest.de.sentry.io / .eu.sentry.io) to
// keep error data in-region per docs/playbooks/gdpr.md.

import * as Sentry from "@sentry/nextjs";

import { scrubEvent } from "@/lib/observability/sentry-scrub";

export async function register(): Promise<void> {
  // Boot tripwire: the rate limiter (lib/public/rate-limit.ts) fails OPEN if
  // Upstash isn't configured, silently disabling all auth/abuse throttling.
  // In production that's a serious misconfiguration — surface it loudly in
  // logs (and to Sentry below once it's initialised) rather than degrade
  // silently. See docs/playbooks/{security,deploy}.md.
  const upstashMissing = missingUpstashInProd();
  if (upstashMissing.length > 0) {
    console.error(
      `[boot] CRITICAL: rate limiter fails OPEN — Upstash not configured (${upstashMissing.join(", ")}). Auth/abuse throttling is DISABLED.`,
    );
  }

  const dsn = process.env["SENTRY_DSN"];
  if (!dsn) return;

  const common = {
    dsn,
    environment: process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "development",
    // Conservative sampling for a bootstrap app — capture all errors,
    // a slice of traces. Tune up once volume/cost is understood.
    tracesSampleRate: 0.1,
    // Don't send default PII (IP, headers, cookies). We attach our own
    // scrubbed context where useful. Required for GDPR posture.
    sendDefaultPii: false,
    // Last-line PII scrub mandated by docs/playbooks/gdpr.md: strip
    // email/phone/last_name/dob/notes from every outbound event,
    // including request data and breadcrumbs the SDK gathers itself.
    beforeSend: (event: Sentry.ErrorEvent) => scrubEvent(event),
  } as const;

  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    Sentry.init(common);
    // Now that Sentry is up, also page on the Upstash misconfig.
    if (upstashMissing.length > 0) {
      Sentry.captureMessage(
        `rate limiter fails open: Upstash not configured in production (${upstashMissing.join(", ")})`,
        "fatal",
      );
    }
  }
  if (process.env["NEXT_RUNTIME"] === "edge") {
    Sentry.init(common);
  }
}

// Which Upstash env vars are missing in a production Node runtime (empty
// otherwise). Gated to the Node server runtime so the check fires once, not
// also on edge. Exported for the unit test.
export function missingUpstashInProd(): string[] {
  const isProd = (process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"]) === "production";
  if (!isProd) return [];
  const runtime = process.env["NEXT_RUNTIME"];
  if (runtime && runtime !== "nodejs") return [];
  return ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"].filter((k) => !process.env[k]);
}

// Forwards React Server Component / route-handler errors to Sentry.
// Next.js calls this for server-side request errors.
export const onRequestError = Sentry.captureRequestError;
