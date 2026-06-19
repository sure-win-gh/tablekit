// Browser-side Sentry init. Next.js loads this on the client before
// hydration. Guarded on the public DSN so an unconfigured build ships
// no Sentry network calls.
//
// NEXT_PUBLIC_SENTRY_DSN is the same EU-region DSN as the server, but
// exposed to the browser bundle (hence the NEXT_PUBLIC_ prefix). It is
// safe to expose — a DSN only permits sending events, not reading them.

import * as Sentry from "@sentry/nextjs";

import { scrubEvent } from "@/lib/observability/sentry-scrub";

const dsn = process.env["NEXT_PUBLIC_SENTRY_DSN"];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env["NEXT_PUBLIC_VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "development",
    tracesSampleRate: 0.1,
    // No session replay / PII by default — keep the diner-facing widget
    // free of anything that captures personal data.
    sendDefaultPii: false,
    // Same GDPR-mandated PII scrub as the server runtimes — a stray guest
    // identifier in a client error must not reach Sentry. See
    // lib/observability/sentry-scrub.ts and docs/playbooks/gdpr.md.
    beforeSend: (event) => scrubEvent(event),
  });
}

// Instruments client-side navigations so route changes are traced.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
