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

import { isProdLike, missingRequiredEnv } from "@/lib/env-check";
import { scrubEvent } from "@/lib/observability/sentry-scrub";

export async function register(): Promise<void> {
  // Boot tripwire: Upstash missing means the rate limiter (lib/public/
  // rate-limit.ts) is degraded — but which way depends on the environment,
  // because this tripwire and the limiter gate on DIFFERENT predicates:
  //
  //   • This tripwire  → isProdLike(): VERCEL_ENV=production OR
  //     TABLEKIT_ENV=staging. Fires in both.
  //   • The limiter    → isProduction(): (VERCEL_ENV ?? NODE_ENV) ===
  //     "production". True in production only.
  //
  // So in PRODUCTION missingConfigResult() returns ok:false for every caller
  // and each rate-limited route answers 429 with retry-after set to that
  // bucket's window — a hard outage of the booking flow and every credential
  // endpoint, not a silent degradation. In STAGING (a Vercel preview, so
  // VERCEL_ENV=preview) it returns ok:true instead: the limiter fails OPEN
  // and there is no throttling at all. Both are worth waking up for, which
  // is why the tripwire deliberately spans both. Surface it loudly in logs
  // (and to Sentry below once it's initialised) so it's diagnosed in
  // seconds. See docs/playbooks/{security,deploy}.md.
  const upstashMissing = missingUpstashInProdLike();
  if (upstashMissing.length > 0) {
    console.error(
      `[boot] CRITICAL: Upstash not configured (${upstashMissing.join(", ")}) — in production the rate limiter fails CLOSED (bookings, availability, events/purchase, login, signup, password reset, api-key auth and enquiries all return 429); in staging it fails OPEN, so there is no throttling at all.`,
    );
  }

  // Env parity tripwire (deployment-pipeline.md Phase 2): every required
  // variable must be set and non-placeholder. Same posture as the Upstash
  // check — loud log + Sentry page in prod-like envs, warn elsewhere; never
  // crash the server over it. Node runtime only, so it fires once.
  const envMissing = missingEnvParity();
  if (envMissing.length > 0) {
    const line = `[boot] ${isProdLike(process.env) ? "CRITICAL: " : ""}required env vars missing or placeholder: ${envMissing.join(", ")} (see .env.local.example)`;
    if (isProdLike(process.env)) console.error(line);
    else console.warn(line);
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
        `rate limiter degraded: Upstash not configured (${upstashMissing.join(", ")}) — in production it fails CLOSED and every rate-limited route returns 429; in staging it fails OPEN, so there is no throttling at all`,
        "fatal",
      );
    }
    // …and on the env-parity misconfig, prod-like only.
    if (envMissing.length > 0 && isProdLike(process.env)) {
      Sentry.captureMessage(
        `env parity: required vars missing or placeholder (${envMissing.join(", ")})`,
        "fatal",
      );
    }
  }
  if (process.env["NEXT_RUNTIME"] === "edge") {
    Sentry.init(common);
  }
}

// Which Upstash env vars are missing in a prod-like Node runtime (empty
// otherwise). Uses isProdLike() — the SAME "environment that matters"
// definition as the env-parity tripwire below (Vercel production OR
// TABLEKIT_ENV=staging) — so a broken Upstash config alarms on staging too,
// not just production. Gated to the Node server runtime so it fires once, not
// also on edge. Exported for the unit test.
export function missingUpstashInProdLike(): string[] {
  if (!isProdLike(process.env)) return [];
  const runtime = process.env["NEXT_RUNTIME"];
  if (runtime && runtime !== "nodejs") return [];
  return ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"].filter((k) => !process.env[k]);
}

// Which required env vars (lib/env-check.ts tiers) are missing, gated to the
// Node server runtime so the check fires once, not also on edge. The
// production tier applies only in prod-like envs (Vercel production /
// explicit staging) — NOT under bare NODE_ENV=production, so local
// `pnpm start` and CI's e2e server stay quiet about live-only keys.
// Exported for the unit test.
export function missingEnvParity(): string[] {
  const runtime = process.env["NEXT_RUNTIME"];
  if (runtime && runtime !== "nodejs") return [];
  return missingRequiredEnv(process.env, { prodLike: isProdLike(process.env) });
}

// Forwards React Server Component / route-handler errors to Sentry.
// Next.js calls this for server-side request errors.
export const onRequestError = Sentry.captureRequestError;
