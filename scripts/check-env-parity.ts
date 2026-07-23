#!/usr/bin/env tsx
// CLI for the env parity check (deployment-pipeline.md Phase 2 step 1).
//
// Two checks:
//   1. Required variables (lib/env-check.ts tiers) are set and not
//      placeholders. Missing → exit 1.
//   2. Drift against .env.local.example, the canonical name list: any
//      Tablekit-shaped variable set in the environment but not documented
//      there is reported as a warning (usually a typo or an orphaned
//      secret). Warn-only — does not fail the run.
//
// The same required-tier logic runs at boot via instrumentation.ts, which
// imports lib/env-check.ts directly (no filesystem access there — this CLI
// is the only place the example file is read).
//
// Usage:
//   pnpm check:env                 # local: REQUIRED_ALWAYS only
//   pnpm check:env -- --prod       # also enforce the production tier
//
// Exit codes: 0 ok, 1 required vars missing, 2 could not read the example.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

import { isProdLike, missingRequiredEnv } from "../lib/env-check";

const EXAMPLE_PATH = ".env.local.example";

// Prefixes that mark a variable as "ours" for the drift check — anything
// else in process.env (PATH, CI, VERCEL_*, …) is none of our business.
const OURS =
  /^(NEXT_PUBLIC_|STRIPE_|SUPABASE_|DATABASE_|SESSION_|TABLEKIT_|TWILIO_|RESEND_|UPSTASH_|SENTRY_|CRON_|RWG_|HCAPTCHA_|SQUARE_|LIGHTSPEED_|GOOGLE_|ADMIN_|EMAIL_|FEATURE_|REGION_|CSP_|SLACK_)/;

// Names documented in .env.local.example — both `NAME=` lines and
// commented-but-documented `# NAME=` lines count.
export function documentedNames(exampleText: string): Set<string> {
  const names = new Set<string>();
  for (const raw of exampleText.split("\n")) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(raw);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

export function undocumentedNames(
  env: Record<string, string | undefined>,
  documented: Set<string>,
): string[] {
  return Object.keys(env)
    .filter((name) => OURS.test(name) && !documented.has(name))
    .sort();
}

function main(): void {
  // Mirror Next.js env-file precedence, same as scripts/check-rls.ts.
  loadEnv({ path: resolve(process.cwd(), ".env.local") });
  loadEnv({ path: resolve(process.cwd(), ".env") });

  let exampleText: string;
  try {
    exampleText = readFileSync(resolve(process.cwd(), EXAMPLE_PATH), "utf8");
  } catch (err: unknown) {
    console.error(`check-env: cannot read ${EXAMPLE_PATH}:`, err);
    process.exit(2);
  }

  const prodLike = process.argv.includes("--prod") || isProdLike(process.env);

  const undocumented = undocumentedNames(process.env, documentedNames(exampleText));
  for (const name of undocumented) {
    console.warn(`check-env: WARN '${name}' is set but not documented in ${EXAMPLE_PATH}`);
  }

  const missing = missingRequiredEnv(process.env, { prodLike });
  if (missing.length > 0) {
    console.error(
      `check-env: FAIL — required env vars missing or placeholder (${prodLike ? "production tier" : "base tier"}):`,
    );
    for (const name of missing) console.error(`  - ${name}`);
    console.error(`\nFix: set real values (names documented in ${EXAMPLE_PATH}).`);
    process.exit(1);
  }

  console.log(
    `check-env: OK — ${prodLike ? "base + production tiers" : "base tier"} satisfied` +
      (undocumented.length > 0
        ? `; ${undocumented.length} undocumented name(s) warned above.`
        : "."),
  );
}

// Only run when invoked directly (tests import the pure helpers).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
