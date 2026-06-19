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
  }
  if (process.env["NEXT_RUNTIME"] === "edge") {
    Sentry.init(common);
  }
}

// Forwards React Server Component / route-handler errors to Sentry.
// Next.js calls this for server-side request errors.
export const onRequestError = Sentry.captureRequestError;
