// Environment-variable parity check (pure logic, no filesystem access —
// safe to import from instrumentation.ts, which also bundles for the edge
// runtime). The CLI wrapper with the .env.local.example drift check lives
// in scripts/check-env-parity.ts.
//
// Two tiers:
//   REQUIRED_ALWAYS      — the app cannot boot safely without these anywhere.
//   REQUIRED_PRODUCTION  — additionally required when serving real traffic
//                          (Vercel production; later also staging).
//
// Curation rule: a variable belongs here only if its absence breaks or
// silently degrades a live surface. Optional integrations (Google OAuth,
// Places, Slack alerting, POS partners, WhatsApp templates, Bedrock) are
// deliberately NOT listed — their code paths degrade by design.
// See docs/specs/deployment-pipeline.md §Phase 2.

export const REQUIRED_ALWAYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_WIDGET_URL",
  "SESSION_SIGNING_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "TABLEKIT_MASTER_KEY",
] as const;

export const REQUIRED_PRODUCTION = [
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "CRON_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
] as const;

// The repo-wide "documented but not set" sentinels (.env.local.example,
// lib/stripe/client.ts treat these as unset).
const PLACEHOLDER = /YOUR_|changeme/i;

export type Env = Record<string, string | undefined>;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

function isSet(env: Env, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0 && !isPlaceholder(value);
}

// Names from the required tiers that are missing or still placeholders.
// `prodLike` selects whether the production tier applies.
export function missingRequiredEnv(env: Env, opts: { prodLike: boolean }): string[] {
  const required: readonly string[] = opts.prodLike
    ? [...REQUIRED_ALWAYS, ...REQUIRED_PRODUCTION]
    : REQUIRED_ALWAYS;
  return required.filter((name) => !isSet(env, name));
}

// Whether this environment serves real traffic. Today: Vercel production
// only. When staging.tablekitapp.com lands (deployment-pipeline.md Phase 2
// step 4) it deploys as a branch-scoped preview, so enforcement there keys
// on an explicit TABLEKIT_ENV=staging value set in that env — not on
// NODE_ENV, which is also "production" for local `pnpm start` and CI e2e.
export function isProdLike(env: Env): boolean {
  return env["VERCEL_ENV"] === "production" || env["TABLEKIT_ENV"] === "staging";
}
