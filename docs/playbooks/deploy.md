# Playbook: Deployment & environments

**Audience:** Claude Code and the operator.
**Read before:** running migrations, cutting a release, or changing infrastructure.

## Environments

| Env        | URL                          | Branch   | Data      |
|------------|------------------------------|----------|-----------|
| Local      | http://localhost:3000        | any      | local docker Postgres |
| Preview    | Vercel preview per PR        | PR branch| shared preview Supabase |
| Staging    | staging.tablekit.uk          | `main`   | staging Supabase (EU-central) |
| Production | app.tablekit.uk / book.tablekit.uk | tag `v*` | prod Supabase (EU-west, London) |

## Release flow

1. Work on a feature branch. Open PR against `main`.
2. Preview deploy runs. Smoke test manually on the Vercel preview URL.
3. CI must pass: typecheck, lint, unit tests, e2e smoke, `scripts/check-rls.ts`, `pnpm audit`.
4. Review with the `code-reviewer` subagent (`/review`). For anything touching PII or payments, also run `/audit gdpr` and `/audit payments`.
5. Merge to `main`. Staging deploys automatically.
6. Test on staging: new flow, happy path, one edge case.
7. Tag `vYYYY.MM.DD.N`. GitHub action promotes the staging build to production (Vercel alias swap — zero-downtime).

For solo operation: steps 2–4 are where Claude Code earns its keep. Use subagents to review before you merge.

## Migrations

- Drizzle Kit generates migrations into `drizzle/migrations/`.
- Migrations are applied by `pnpm db:migrate` running in a Vercel build step.
- **Forward-only.** No down-migrations. If you need to reverse, write a new compensating migration.
- **Safe by default:**
  - New columns: nullable or with default.
  - Drops: two-phase. First release stops writing; second release drops the column. Never in one PR.
  - Renames: add new, backfill, dual-write, cut reads, drop old. Never `ALTER COLUMN ... RENAME TO` in a live release.
- Migrations run before the new app version is live (Vercel's pre-deploy hook).
- Large backfills: use a background job, not a migration. Migrations must be fast (<10s).

## Feature flags

- Use env vars for binary flags (most cases): `FEATURE_WAITLIST=true`.
- For gradual rollout (per-org): `feature_flags` table, joined at request time, cached 60s.
- Every flag has an owner and a removal date. Kill switches are a subset of flags (see `incident.md`).

## Config & secrets

- `.env.local.example` committed with placeholder values.
- Real secrets: Vercel env vars for app, Supabase Vault for database-side secrets (encryption master key).
- Changes to env vars are deployed by re-triggering the current build.
- Per-environment values: local (dev), preview (shared), staging, production.

## Domains

- Primary: `tablekit.uk` (marketing site).
- Dashboard: `app.tablekit.uk`.
- Widget: `book.tablekit.uk` (and customer subpaths like `book.tablekit.uk/<venue-slug>`).
- API: `api.tablekit.uk` (public API — Plus tier).
- Status: `status.tablekit.uk` (hosted externally, e.g. Better Stack).

TLS via Cloudflare in front of Vercel (orange-cloud proxy). DNSSEC on.

## Cron & background jobs

- Vercel Cron for short jobs (<5 min): reminders, report refreshes, flag evaluations.
- Supabase Edge Functions for scheduled DB-heavy work: nightly aggregations, GDPR erasure scrubs.
- Long backfills: Supabase pg_cron or a one-off dyno.
- All job runs logged to `job_runs(id, name, started_at, finished_at, status, notes)` — visible in the dashboard's ops view.

## Observability

- Sentry for errors (app + edge).
- Vercel Analytics for traffic (privacy-preserving, no PII).
- Supabase dashboard for DB metrics (p95 query time, slow queries).
- Uptime checks: homepage, login, health endpoint, webhook endpoint.

## Pre-launch checklist

Before flipping from "private beta" to "public beta":
- [ ] All playbooks read and understood (gdpr, payments, security, incident, this one).
- [ ] RLS tests green on every org-scoped table.
- [ ] Stripe live mode keys in production. Test payment end-to-end.
- [ ] Webhooks pointing at production URL, signatures verified.
- [ ] DPA click-through live, `/legal/sub-processors` page live.
- [ ] Backups verified (actually restore one to a throwaway DB).
- [ ] Kill switches tested on staging.
- [ ] Status page live.
- [ ] Rate limits set to production values (not dev).
- [ ] Encryption master key wrapped in Supabase Vault; rotation tested.
- [ ] Cookie banner / privacy notice on widget and dashboard.
- [ ] `/.well-known/security.txt` published.
- [ ] Domain email (SPF, DKIM, DMARC) configured for `@tablekit.uk`.
