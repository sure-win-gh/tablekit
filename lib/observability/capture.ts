// Central error/alert sink.
//
// Everything that wants to report an error goes through here rather
// than calling Sentry directly. That keeps a single seam: today it
// forwards to Sentry; swapping or adding a provider later touches
// only this file.
//
// Design rules, matching lib/public/rate-limit.ts:
//   • Never throw. Observability must not take down the request it's
//     observing. Every path is wrapped and falls back to console.
//   • Degrade gracefully when Sentry isn't configured — before
//     Sentry.init() runs (no DSN set), the SDK's capture* functions
//     are safe no-ops, so local dev and CI stay quiet.
//
// Importable from client, server and edge: @sentry/nextjs resolves to
// the correct SDK per runtime and is safe to import everywhere.

import * as Sentry from "@sentry/nextjs";

import { redactContext } from "./sentry-scrub";

export type CaptureContext = Record<string, string | number | boolean | null | undefined>;
type Severity = "warning" | "error" | "fatal";

const isServer = typeof window === "undefined";

/**
 * Report an exception. Safe to call from anywhere. Forwards to Sentry
 * (no-op if uninitialised) and always logs server-side so it lands in
 * Vercel logs as a fallback.
 */
export function captureException(error: unknown, context?: CaptureContext): void {
  const extra = context ? redact(context) : undefined;
  try {
    Sentry.captureException(error, extra ? { extra } : undefined);
  } catch {
    // never let reporting throw
  }

  if (isServer) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[capture]", message, extra);
  }
}

/**
 * Report a message (no Error object) — e.g. a degraded-but-handled
 * condition worth surfacing.
 */
export function captureMessage(
  message: string,
  level: Severity = "warning",
  context?: CaptureContext,
): void {
  const extra = context ? redact(context) : undefined;
  try {
    Sentry.captureMessage(message, extra ? { level, extra } : { level });
  } catch {
    // never let reporting throw
  }
  if (isServer) {
    console.warn("[capture]", message, extra);
  }
}

// Strip anything that looks like PII before it reaches Sentry or a log
// line. Shares the key set + matching with the Sentry `beforeSend` hook
// (lib/observability/sentry-scrub.ts) so both surfaces redact the same
// fields. The Sentry payload is additionally scrubbed by `beforeSend` as
// a catch-all; this is the first line for the context we attach ourselves.
function redact(context: CaptureContext): Record<string, unknown> {
  return redactContext(context);
}
