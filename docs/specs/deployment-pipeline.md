# Spec: Deployment pipeline — staging parity, gated CI/CD promotion, one-click rollback

**Status:** Phase 1 shipped (2026-07-22); Phases 2–4 planned
**Owner:** Ben
**Related:** `docs/playbooks/deploy.md`, `docs/playbooks/incident.md`, `.github/workflows/ci.yml`
**Goal:** stop bugs reaching production by making every change pass through a production-mirroring staging path, promoting to production only on green tests, and making reversion a single action.

---

## Implementation status

**Phase 1 — shipped 2026-07-22.** The CI safety floor is in place: PRs can no longer go green on typecheck/lint/unit alone, and unsafe migrations are blocked mechanically.

- `scripts/check-migration-safety.ts` — migration-safety linter (2.5). Scans only migrations *added/changed* vs `origin/main` (history is grandfathered); blocks `DROP TABLE`/`DROP COLUMN`, `RENAME COLUMN`/`RENAME TABLE`, `SET NOT NULL`, and `ADD COLUMN … NOT NULL` without a default. Comments and dollar-quoted function bodies are stripped so they can't trip it. Escape hatch: a file-level `-- migration-safety-ack: <reason>` marker. Validated: 0 false positives across all 70 existing migrations.
- `tests/unit/check-migration-safety.test.ts` — 14 unit tests over the detection logic (safe vs unsafe, comment/dollar-quote handling, statement splitting).
- `package.json` — `check:migrations` script.
- `.github/workflows/ci.yml` — `fetch-depth: 0` on the `checks` checkout (so the linter can diff against `origin/main`); a **Migration safety** step in `checks`; and a dedicated **`migrate`** job that applies migrations to the CI database before the `integration`/`e2e` jobs (which now `needs: [checks, migrate]`), keeping CI's schema in lockstep automatically.
- CI infrastructure: a dedicated CI Supabase project with the five secrets wired in GitHub Actions (`DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SIGNING_SECRET`). This lit up the previously-skipped RLS check, integration tests, and e2e job. Schema seeded via a one-time `pnpm db:migrate`; the CI `migrate` job maintains it thereafter.

Outstanding verification: a throwaway PR adding a `DROP COLUMN` migration to confirm, in one run, that the linter blocks it *and* that the DB-backed jobs execute and pass against the CI database.

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
| **1** ✅ | CI secrets wired (2.1); skipped jobs now run; migration-safety linter (2.5); CI `migrate` job keeps the CI DB in schema-sync | ~half a day | PRs can no longer go green without DB-touching tests; unsafe migrations blocked |
| **2** | Staging parity: London Supabase, seed script, env-parity check, Cloudflare + noindex on staging (1.2–1.3); e2e vs preview URL (2.2) | ~1–2 days | "Works on my machine" gap between CI and deployed reality |
| **3** | `staging-verify.yml` (2.3) + `promote.yml` (2.4) + branch protection + GitHub `production` environment | ~1 day | Untested code can no longer reach production; releases become boring |
| **4** | `rollback.yml` + Instant Rollback documentation + first drill (WS 3); Supabase branching for per-PR databases (1.4) | ~1 day | Incident recovery drops from "minutes of CLI under stress" to one click; PR previews stop sharing state |

Order rationale: Phase 1 is an hour of secrets configuration for the single biggest safety gain available. Per-PR database branching is deliberately last — it's the most valuable *convenience* but the least urgent *safety* item, and the shared preview DB is tolerable for a solo founder for a few more weeks.

## Follow-ups once this lands

Update `deploy.md` §Release flow and `incident.md` §Rollback procedure to point at the workflows instead of manual CLI steps; add the rollback drill and staging-parity checks to the pre-launch checklist; consider a lightweight canary step in `promote.yml` later (route a single pilot venue's traffic first) once there are enough venues to warrant it.
