# Spec: Deployment pipeline — staging parity, gated CI/CD promotion, one-click rollback

**Status:** Phase 1 shipped — merged to `main` 2026-07-23 (PR #131, merge `9cf14bf`). Phases 2–4 planned; Phase 2 execution plan below.
**Owner:** Ben
**Related:** `docs/playbooks/deploy.md`, `docs/playbooks/incident.md`, `.github/workflows/ci.yml`
**Goal:** stop bugs reaching production by making every change pass through a production-mirroring staging path, promoting to production only on green tests, and making reversion a single action.

---

## Where we are today (audited 2026-07-22)

The repo already has good bones, but there are gaps between what `deploy.md` describes and what actually exists:

1. **CI runs, but its most valuable jobs are skipped.** `ci.yml` gates the RLS check, integration tests, and e2e tests on `secrets.DATABASE_URL`, which is not set — so every run emits the "wire this up" notice and skips them. Today a PR can go green having only passed typecheck, lint, format, and unit tests.
2. **E2E tests never touch a deployed environment.** `playwright.config.ts` spawns `pnpm dev` locally via `webServer`. Nothing exercises a real Vercel build, real edge behaviour, or real env-var wiring before production.
3. **The promotion step doesn't exist.** `deploy.md` says "Tag `vYYYY.MM.DD.N`. GitHub action promotes the staging build to production" — but `.github/workflows/` contains only `ci.yml`. Promotion is currently a manual act of faith.
4. **Rollback is manual CLI.** `incident.md` says "Vercel: `vercel rollback`". That requires a laptop, a logged-in CLI, and calm hands during an incident — exactly the "manual server intervention" this plan removes.
5. **Staging doesn't mirror production.** Staging Supabase is EU-central; production is EU-west (London). Different region, and no guarantee of matching Postgres version, extensions, or auth settings.
6. **Preview deployments share one database.** All PR previews point at a single shared preview Supabase, so two open PRs with conflicting migrations corrupt each other, and preview state drifts from the schema in `drizzle/`.

The plan below fixes these in four phases. Each phase is independently shippable and useful on its own — do them in order, but nothing blocks on a later phase.

---

## Implementation record — Phase 1 (shipped 2026-07-23, PR #131)

Green run: `30003259912` — checks, migrate, integration (94 files / 518 tests), e2e (10 passed, 5 skipped), all on their own merits. Thirty commits, merged unsquashed (`9cf14bf`) so the investigation history survives.

**What shipped (core scope):** the migration-safety linter (`scripts/check-migration-safety.ts`, 14 unit tests, `check:migrations` script) blocking destructive/rewrite-unsafe DDL in *new* migrations only, with a `-- migration-safety-ack:` escape hatch; CI wiring (`fetch-depth: 0`, Migration safety step in `checks`); a `migrate` job applying Drizzle migrations to the CI database before the DB-backed jobs; the five Supabase secrets plus `TABLEKIT_MASTER_KEY` wired, lighting up the RLS check, integration, and e2e jobs for the first time.

**What shipped beyond scope (pulled forward from Phase 2 by necessity):** e2e now runs against a **production build** (`pnpm build` + `pnpm start` in CI; local dev unchanged); per-spec isolation — every e2e spec seeds its own user/org/venues, enrols a real TOTP factor (`otplib`, dev-only), and starts from a programmatically established session (`tests/e2e/support/owner-session.ts` builds `@supabase/ssr` cookies via the library's own cookie jar plus the HMAC-signed `tk_active_org` cookie); only `auth.spec.ts` drives the login + MFA UI, keeping it inside the login rate limit; CI browsers send a per-run TEST-NET-3 `x-real-ip` so the limiter keys realistic per-client buckets; a CI Upstash Redis backs the limiter for real.

**Fixed because the suites finally ran:** nine high advisories (five via narrowly-scoped `pnpm.overrides` — `sharp`, `fast-uri` held in-major for ajv, `brace-expansion` range-scoped so minimatch@3 keeps 1.x, `axios` — and four in `next`, patched to 16.2.11); broken `api_keys` fixtures violating the 0029 shape constraints; `backfillGuestPhoneHash` gained an optional org scope (production sweep unchanged); the `atBst` test helper produced Invalid Dates at day rollover; a set of e2e specs stale against shipped UI (widget four-step wizard, dashboard redirect target, floor-plan canvas).

**Parked, explicitly:** `bookings.spec.ts` full-flow is `test.fixme` — the flow itself was proven end-to-end (run `29995374414`); the failure mode is runner-load-dependent hydration latency under local `pnpm start` + Chromium. **Un-fixme when Phase 2 moves e2e to Vercel preview deployments.** `password-reset` and `stripe-connect` skip loudly when their provider keys are unset (repo convention).

**CI infrastructure now load-bearing** (record these wherever you track infra): a dedicated CI Supabase project (throwaway data; schema maintained by the `migrate` job) and a CI Upstash Redis (`tablekit-ci`) backing the rate limiter. Neither is shared with staging or production, ever. Operational fact that cost a cycle: **GitHub Actions resolves secrets at job start** — a job already running does not see newly-set secrets; re-run the job.

### Watch-items & follow-ups (from Phase 1's findings)

1. **Supabase `bad_jwt` platform transient.** Auth admin API rejects ~7% of requests with 403 `bad_jwt` ("unrecognized JWT kid <nil> for algorithm ES256") using a key that serves every other request — reproduced with curl against two projects including a fresh one, so platform-side; the rejected call creates nothing. Shim: `tests/support/bad-jwt-retry.ts` (installed from integration setup + the e2e seeding specs) retries only 403 + `bad_jwt` (both `code` and `error_code` shapes), ≤5 attempts with backoff; a genuinely bad key still fails on attempt one. Test-harness only; production auth path confirmed unaffected. Worth a Supabase support ticket.
2. **CI pooler `EMAXCONNSESSION`.** The CI Supabase session-mode pooler caps at `pool_size: 15`; exceeding it surfaces as an unrelated-looking query error (`max clients reached in session mode`) — resource exhaustion, load-dependent, not random. Seen once (2026-07-22), not since. If it recurs: raise `pool_size` or trim concurrently-open pools; don't retry the test.
3. **`login:ip:unknown` shared bucket** (→ `security.md`). `ipFromHeaders()` falls back to `"unknown"` when no `cf-connecting-ip`/`x-real-ip`/`x-forwarded-for` is present, so any direct caller population shares one 5-per-15-min bucket — and Redis-backed budgets persist across processes. E2E now supplies a per-run RFC 5737 address, mirroring what real infrastructure always provides. Remember for any future non-browser caller.
4. **The limiter fails closed *silently*** (product follow-up, small + high-value). `rateLimit()` with `failOpen: false` returns "limited" on any Upstash problem — non-2xx, network error, or the 1500 ms timeout — and `outageResult()` logs nothing on that path, so an unreachable Redis is indistinguishable from a genuine lockout at the UI. It cost a full diagnostic cycle in CI; in production it would look like "users can't log in" with clean logs. Add a log line / Sentry breadcrumb on the outage path. (`incident.md` documents *that* auth fails closed; this makes it *observable*.)
5. **SlotPicker date-input hydration gap** (UX papercut, follow-up PR). `bookings/new/forms.tsx` renders the date as a controlled input with no local state — value from server `searchParams`, every change a router round-trip. A date picked pre-hydration is discarded on reconcile; post-hydration the field lags the server round-trip, reading as "ignored" on slow connections, and a second change mid-flight can drop. Re-entry not corruption. Fix shape: optimistic local state while the push is in flight.

---

## Workstream 1 — A staging environment that mirrors production

### 1.1 Environment topology (target)

| Env        | URL                       | Deploys from        | Database                                  | Third-party mode |
|------------|---------------------------|---------------------|-------------------------------------------|------------------|
| Local      | localhost:3000            | any branch          | local Postgres                             | test keys        |
| PR preview | Vercel preview URL per PR | every PR push       | **isolated Supabase preview branch per PR** | test keys        |
| Staging    | staging.tablekitapp.com   | `main`, automatic   | staging Supabase — **eu-west-2 (London)**  | test keys        |
| Production | my./book./api.tablekitapp.com | promote workflow only | prod Supabase, eu-west-2 (London)      | live keys        |

Staging is implemented as Vercel's preview environment scoped to the `main` branch: attach the `staging.tablekitapp.com` domain to the `main` branch in Vercel → Settings → Domains, and use branch-scoped environment variables (Preview env vars can be pinned to `main`) for staging-specific values. Production deployments are created **only** by the promote workflow (Workstream 2), so a push to `main` can never reach production directly.

### 1.2 Database parity

Recreate the staging Supabase project in **eu-west-2 (London)** — same region as production, same Postgres major version, same enabled extensions, "Confirm email" ON, session-pooler connection string (same shape as the prod `DATABASE_URL` documented in `.env.local.example`). The current EU-central staging project is a silent parity violation: region-dependent behaviour (latency, pooler hostnames, residency posture) differs from what production will do.

Schema parity comes from the migration path, not from copying: staging applies exactly the same `drizzle/` migrations as production, automatically on every staging deploy. Staging is therefore always **ahead of or equal to** production in schema — every migration runs on staging days before it runs on prod, which is the whole point.

Data parity comes from seeding, never from copying production. Rule 5 (encrypted PII) and the GDPR playbook make prod-to-staging copies a non-starter. Instead, add `scripts/seed-staging.ts`: synthetic venues, tables, guests, and bookings covering the shapes that matter (multi-venue org, org with deposits enabled, org at the free-tier booking cap, cancelled/no-show bookings, a waitlist entry). Make it idempotent and re-run it from a weekly cron so staging data never rots. RLS policies apply on staging identically — the `check:rls` script runs against staging in CI.

### 1.3 Environment variable parity

`.env.local.example` is already the canonical list of names. Enforce it: add `scripts/check-env-parity.ts`, which parses the example file for required (non-optional) names and fails if the current environment is missing any. Wire it into `instrumentation.ts`'s existing boot check pattern so a staging or production deploy with a missing variable fails loudly at boot, not at 2am when the code path is first hit. Staging carries the same **names** as production with staging **values**: Stripe test keys, a separate staging webhook signing secret, staging Twilio/Resend credentials, its own `CRON_SECRET`, its own Upstash database, and `SENTRY_DSN` shared with prod but with `environment: "staging"` tagging so alerts are distinguishable.

Edge parity: put `staging.tablekitapp.com` behind Cloudflare (orange-cloud) with the same ruleset that `infra/cloudflare/ruleset.ts` applies to production, so WAF and rate-limit behaviour is exercised on staging too. Add `X-Robots-Tag: noindex` and Vercel Deployment Protection (password or Vercel auth) on staging and previews.

### 1.4 Per-PR preview deployments with isolated databases

Vercel already builds a preview per PR. The fix is the database: enable **Supabase Branching** with the Supabase↔Vercel integration, so each PR gets its own ephemeral database branch (migrated + seeded on creation, destroyed on merge/close), and the integration injects that branch's `DATABASE_URL` / Supabase keys into that preview's env automatically.

One integration wrinkle to plan for: Supabase branching runs migrations from `supabase/migrations/`, while ours live in `drizzle/`. Two options, pick one during implementation:

- **Option A (preferred):** add a tiny sync step to `db:generate` that mirrors Drizzle's SQL output into `supabase/migrations/` (same files, prefixed timestamps). Branching then works natively, and the directory is generated-only, never hand-edited.
- **Option B:** skip Supabase's migration runner and keep applying migrations from the Vercel build step for previews (as today), pointed at the branch database. Slightly slower builds, no sync step.

If branching's per-branch-hour cost is unwelcome at this stage, the fallback is keeping the shared preview database but treating it as disposable: a nightly reset job (drop schema, re-migrate, re-seed) and a hard rule that conflicting-migration PRs coordinate. This is strictly worse — take branching unless cost forbids it.

Cron note: `vercel.json` crons fire only on production. On staging, test cron routes by invoking them directly with the staging `CRON_SECRET`; add a `pnpm cron:staging <name>` helper script so this is one command.

---

## Workstream 2 — CI/CD: automated tests gate promotion

### 2.1 Make the existing CI actually run (immediate, ~1 hour)

Set the five GitHub Actions secrets `ci.yml` already looks for — `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SIGNING_SECRET` — pointed at a **CI-dedicated** Supabase project (not staging: CI must be free to trash its database; staging must stay a stable rehearsal space). Cheapest option: a free-tier Supabase project reserved for CI. The skipped RLS check, integration tests, and e2e job all come alive with zero YAML changes.

### 2.2 Run e2e against the real preview deployment

Change the e2e job to test the deployed Vercel preview rather than a localhost dev server. `playwright.config.ts` already reads `PLAYWRIGHT_BASE_URL`; the only change needed is to skip the `webServer` block when the base URL isn't localhost:

```ts
// playwright.config.ts — replace the unconditional webServer block
const isExternal = !baseURL.includes("localhost");

export default defineConfig({
  // ...existing config...
  ...(isExternal
    ? {}
    : {
        webServer: {
          command: "pnpm dev",
          url: baseURL,
          reuseExistingServer: !isCI,
          timeout: 120_000,
        },
      }),
});
```

In CI, resolve the preview URL for the PR's head SHA (the `patrickedqvist/wait-for-vercel-preview` action, or `vercel ls` with the CLI) and export it as `PLAYWRIGHT_BASE_URL`. The e2e suite then exercises the real build, real env wiring, real middleware (`proxy.ts`), and — once Supabase branching is on — an isolated real database. Vercel Deployment Protection on previews: pass the protection bypass secret (`x-vercel-protection-bypass` header) via Playwright's `extraHTTPHeaders`.

### 2.3 Verify staging after every merge

New workflow `staging-verify.yml`: on push to `main`, wait for the staging deployment to be ready, run the e2e smoke suite against `https://staging.tablekitapp.com`, plus `check:rls` and `check-env-parity` against staging. Report failures to Slack via `SLACK_ALERT_WEBHOOK_URL`. A green `staging-verify` run for a given commit SHA is the precondition for promoting that SHA.

```yaml
# .github/workflows/staging-verify.yml
name: staging-verify
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: staging-verify-${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Wait for staging deployment of this SHA
        uses: patrickedqvist/wait-for-vercel-preview@v1.3.2
        id: staging
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          max_timeout: 600
      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps chromium
      - name: E2E smoke against staging
        env:
          PLAYWRIGHT_BASE_URL: https://staging.tablekitapp.com
        run: pnpm test:e2e
      - name: RLS check against staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: pnpm check:rls
      - name: Alert on failure
        if: failure()
        run: |
          curl -sf -X POST -H 'Content-Type: application/json' \
            -d '{"text":"🔴 staging-verify failed on main @ ${{ github.sha }} — production promotion is blocked. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}' \
            "${{ secrets.SLACK_ALERT_WEBHOOK_URL }}"
```

### 2.4 Gated promotion to production

Implement the promote workflow `deploy.md` promises. Design principles: production is built **from the tagged commit with production env vars** (Next.js bakes `NEXT_PUBLIC_*` at build time, so promoting a staging-built artifact would carry staging values — rebuild is correct here); the deployment is created **without domains**, smoke-tested and migrated, and only then aliased into service. The alias swap is atomic and zero-downtime, and — critically for Workstream 3 — every previous production deployment remains warm and addressable.

```yaml
# .github/workflows/promote.yml
name: promote-production
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
concurrency:
  group: promote-production        # never two promotions at once
  cancel-in-progress: false
jobs:
  promote:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production        # GitHub Environment: holds prod secrets,
                                   # optionally require manual approval here
    steps:
      - uses: actions/checkout@v4

      - name: Require green staging-verify for this SHA
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          conclusion=$(gh run list --workflow staging-verify.yml \
            --commit ${{ github.sha }} --json conclusion -q '.[0].conclusion')
          if [ "$conclusion" != "success" ]; then
            echo "::error::staging-verify is '$conclusion' for ${{ github.sha }} — refusing to promote."
            exit 1
          fi

      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      - name: Build with production env
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
        run: |
          pnpm dlx vercel pull --yes --environment=production --token=$VERCEL_TOKEN
          pnpm dlx vercel build --prod --token=$VERCEL_TOKEN

      - name: Deploy (staged — no domains yet)
        id: deploy
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: |
          url=$(pnpm dlx vercel deploy --prebuilt --prod --skip-domain --token=$VERCEL_TOKEN)
          echo "url=$url" >> "$GITHUB_OUTPUT"

      - name: Apply migrations to production
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
        run: pnpm db:migrate

      - name: Smoke-test the staged deployment
        env:
          VERCEL_BYPASS: ${{ secrets.VERCEL_PROTECTION_BYPASS }}
        run: |
          curl -sf -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \
            "${{ steps.deploy.outputs.url }}/api/health" | grep -q '"ok":true'

      - name: Promote (atomic alias swap)
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
        run: pnpm dlx vercel promote ${{ steps.deploy.outputs.url }} --token=$VERCEL_TOKEN

      - name: Verify production
        run: curl -sf https://my.tablekitapp.com/api/health | grep -q '"ok":true'

      - name: Record release (rollback registry)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create "${{ github.ref_name }}" \
            --title "${{ github.ref_name }}" \
            --notes "Deployment: ${{ steps.deploy.outputs.url }}
          SHA: ${{ github.sha }}"

      - name: Alert on failure
        if: failure()
        run: |
          curl -sf -X POST -H 'Content-Type: application/json' \
            -d '{"text":"🔴 Production promotion of ${{ github.ref_name }} FAILED before completing. Production is still on the previous release. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}' \
            "${{ secrets.SLACK_ALERT_WEBHOOK_URL }}"
```

Ordering note: migrations run **after** the staged deploy exists but **before** the alias swap, so the new code never serves traffic against an un-migrated schema, and (per the forward-only + expand/contract rules in `deploy.md`) the old code keeps working against the migrated schema if we roll back. If a migration fails, the workflow stops with production untouched.

Guardrails to set alongside the workflow: branch protection on `main` requiring the `checks`, `integration`, and `e2e` jobs; a GitHub `production` Environment holding the prod secrets (`PROD_DATABASE_URL`, `VERCEL_TOKEN`, org/project IDs), optionally with a required-reviewer approval step — for a solo founder this is a deliberate second look at 30 seconds' cost. Tag with the existing `vYYYY.MM.DD.N` convention; tagging **is** the release action, and everything after it is automatic and gated.

### 2.5 Migration-safety linter (keeps rollback safe forever)

Add `scripts/check-migration-safety.ts` to the CI `checks` job: scan any new SQL file in `drizzle/` for `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... RENAME`, and `NOT NULL` additions without a default, and fail with a pointer to the two-phase rules in `deploy.md`. This mechanically enforces the **N−1 compatibility rule**: the previous release must always run correctly against the current schema — which is precisely what makes one-click rollback (below) safe to use without thinking during an incident.

---

## Workstream 3 — One-click rollback

Two clicks available, both reaching the same mechanism — Vercel's alias swap back to a previous, still-warm production deployment. No rebuild, no server intervention; takes effect in seconds.

**Click path A — Vercel dashboard, Instant Rollback.** Project → Deployments → current production deployment → "Instant Rollback". Restores the previous production deployment. Fastest option when you're at a machine with the dashboard open. Document it in `incident.md` as the primary move for "the new release broke something".

**Click path B — GitHub Actions `rollback.yml` (works from a phone).** A `workflow_dispatch` workflow — one button in the Actions tab, with an optional input to target a specific release rather than just the previous one:

```yaml
# .github/workflows/rollback.yml
name: rollback-production
on:
  workflow_dispatch:
    inputs:
      target:
        description: "Release tag to roll back TO (blank = previous production deployment)"
        required: false
        type: string
permissions:
  contents: read
concurrency:
  group: promote-production        # shares the promotion lock — no races
  cancel-in-progress: false
jobs:
  rollback:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    steps:
      - name: Roll back
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if [ -n "${{ inputs.target }}" ]; then
            # Look up the deployment URL recorded by promote.yml in the release notes
            url=$(gh release view "${{ inputs.target }}" --repo "${{ github.repository }}" \
              --json body -q .body | grep -o 'https://[^ ]*vercel.app' | head -1)
            npx vercel rollback "$url" --token=$VERCEL_TOKEN --yes
          else
            npx vercel rollback --token=$VERCEL_TOKEN --yes
          fi
      - name: Verify production health
        run: |
          sleep 10
          curl -sf https://my.tablekitapp.com/api/health | grep -q '"ok":true'
      - name: Announce
        if: always()
        run: |
          curl -sf -X POST -H 'Content-Type: application/json' \
            -d '{"text":"⏪ Production rollback executed (${{ job.status }}). Target: ${{ inputs.target || 'previous deployment' }}. Root-cause before re-promoting."}' \
            "${{ secrets.SLACK_ALERT_WEBHOOK_URL }}"
```

**What makes this safe rather than merely fast** — three standing invariants, two of which this plan adds:

1. **Schema compatibility (Workstream 2.5).** Forward-only migrations plus the migration-safety linter mean the previous app version always runs against the current schema. Rollback never touches the database. If the *migration itself* is the bug, the fix is a new compensating migration rolled forward — never a down-migration — exactly as `incident.md` already states.
2. **Rollback registry (promote.yml).** Every promotion records its tag → deployment URL mapping as a GitHub Release, so "last known stable" is a lookup, not archaeology, and rolling back to any specific prior release is the same one click with a tag typed in.
3. **Baked-env integrity.** Because production deployments are always built with production env vars (2.4), any previous production deployment is safe to re-alias. (This is also why kill switches stay: an env-var flip + redeploy handles "turn the feature off" cases where the deployed code is fine — rollback and kill switches are complementary, per `incident.md`.)

Residual caveats to document in `incident.md`: webhooks keep arriving during the swap (Stripe retries for 3 days — already noted there); Vercel Cron runs against whatever production is aliased to, so a rollback also rolls back cron behaviour (desired); if a rollback crosses a `vercel.json` cron-schedule change, re-check the cron list in the dashboard.

**Drill it.** A rollback mechanism that's never been used is a hypothesis. Once `rollback.yml` lands: promote a trivial change to staging's equivalent flow, roll it back, time it. Repeat quarterly and after any change to the promote workflow. Add both to the pre-launch checklist in `deploy.md`.

---

## Phasing & effort

| Phase | What ships | Effort | Risk retired |
|-------|-----------|--------|--------------|
| **1** ✅ | Shipped 2026-07-23 (PR #131) — see Implementation record above. Scope grew in flight: prod-build e2e, per-spec isolation + TOTP + session injection, Upstash-backed limiter in CI all landed early | ~half a day planned; ~2 days actual | PRs can no longer go green without DB-touching tests; unsafe migrations blocked; 9 advisories fixed |
| **2** | Staging parity: London Supabase, seed script, env-parity check, Cloudflare + noindex on staging (1.2–1.3); e2e vs preview URL (2.2) | ~1–2 days | "Works on my machine" gap between CI and deployed reality |
| **3** | `staging-verify.yml` (2.3) + `promote.yml` (2.4) + branch protection + GitHub `production` environment | ~1 day | Untested code can no longer reach production; releases become boring |
| **4** | `rollback.yml` + Instant Rollback documentation + first drill (WS 3); Supabase branching for per-PR databases (1.4) | ~1 day | Incident recovery drops from "minutes of CLI under stress" to one click; PR previews stop sharing state |

Order rationale: Phase 1 is an hour of secrets configuration for the single biggest safety gain available. Per-PR database branching is deliberately last — it's the most valuable *convenience* but the least urgent *safety* item, and the shared preview DB is tolerable for a solo founder for a few more weeks.

## Phase 2 — execution plan (next)

Goal: close the gap between "green in CI" and "behaves in production" — staging that actually mirrors prod (Workstreams 1.1–1.3), and e2e pointed at real Vercel preview deployments (2.2). Explicitly deferred to Phase 4: per-PR isolated databases (1.4). Phase 1 already banked some of this ground: e2e runs a production build, per-spec isolation and the TOTP/session helper exist and carry over unchanged to preview-URL testing.

| Step | Work | Depends on | Effort |
|------|------|-----------|--------|
| 1 | `scripts/check-env-parity.ts` + `instrumentation.ts` boot wiring + unit test: parse `.env.local.example` for required names, fail a staging/prod boot on missing/placeholder values, warn locally. One judgement call: curate the prod-required list against how production actually boots before enabling the hard failure | nothing — pure code | ~half day |
| 2 | London staging Supabase: new project in eu-west-2 (matching prod), same Postgres major + extensions, "Confirm email" ON, session-pooler URL; retire the EU-central project | — | ~half day |
| 3 | Staging seed: adopt `scripts/seed-mock-data.ts` as `seed:staging` — make idempotent, cover the shapes that matter (multi-venue, deposits, free-tier cap, cancelled/no-show, waitlist), schedule weekly, and hard-guard against ever targeting a prod `DATABASE_URL` | step 2 | ~half–1 day |
| 4 | Staging Vercel env: `staging.tablekitapp.com` domain pinned to `main`, branch-scoped Preview env vars carrying production's *names* with staging *values* (Stripe test keys, own `CRON_SECRET`, own Upstash — the CI one stays CI-only), Sentry `environment: "staging"` tag | step 2 | ~half day |
| 5 | Edge + privacy: orange-cloud staging DNS with the `infra/cloudflare/ruleset.ts` rules, `X-Robots-Tag: noindex` for non-production `VERCEL_ENV`, Vercel Deployment Protection on previews + staging | step 4 | ~half day |
| 6 | e2e vs preview deployments: resolve the PR's preview URL in CI → `PLAYWRIGHT_BASE_URL` (config already reads it; skip `webServer` when external), pass the protection-bypass header, **un-fixme `bookings.spec.ts`**, and expect login-limiter behaviour behind Cloudflare/Vercel to key on real client IPs (the `x-real-ip` injection becomes unnecessary for preview runs) | step 5 | ~half day |

Phase 1 lessons that apply directly: preview deployments get real infrastructure (client IPs, fast hydration, no dev overlay), which is precisely what the parked bookings spec and the limiter workarounds are waiting for; and any new environment needs its secrets verified with a probe *before* the first CI run that depends on them — the silent fail-closed limiter (watch-item 4) turns a pasted trailing slash into an unexplained lockout.

## Follow-ups once the full plan lands

Update `deploy.md` §Release flow and `incident.md` §Rollback procedure to point at the workflows instead of manual CLI steps; add the rollback drill and staging-parity checks to the pre-launch checklist; consider a lightweight canary step in `promote.yml` later (route a single pilot venue's traffic first) once there are enough venues to warrant it. From Phase 1's ledger: the `outageResult()` log line (watch-item 4) and the SlotPicker optimistic-state fix (watch-item 5) are small standalone PRs that shouldn't wait for a phase.
