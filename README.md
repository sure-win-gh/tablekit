# TableKit

Lightweight UK table booking SaaS for independent hospitality — cafés, restaurants, bars, pubs. Freemium (up to 50 bookings/month), paid tiers at £19 and £39. Built solo, in the open.

Positioning, pricing and non-goals live in [CLAUDE.md](CLAUDE.md). Feature detail lives in [docs/specs/](docs/specs/index.md). Cross-cutting rules live in [docs/playbooks/](docs/playbooks/).

## Prerequisites

- **Node 22.11.0** (see [.nvmrc](.nvmrc) — `nvm use` to match)
- **pnpm 9.15.0** — enable via corepack: `corepack enable pnpm`
- **A Supabase project in the EU region** — free tier is enough for dev. Create one at [supabase.com](https://supabase.com); we use it for Postgres, Auth and Storage. The database password you set at project creation goes into `DATABASE_URL`.
- **Stripe CLI** for webhook testing (optional until the payments spec): `brew install stripe/stripe-cli/stripe`

> **Why hosted, not local?** We tried the local Supabase CLI route (Docker-based) and backed out — it's a heavy install for a solo dev, and the wire format is identical. A hosted dev project matches staging and production exactly, which keeps RLS surprises out of later releases. If you want fully offline dev later, see [docs/playbooks/deploy.md](docs/playbooks/deploy.md).

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local env file
cp .env.local.example .env.local
```

Then fill in `.env.local` — at minimum, for the auth phase:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **Project Settings → API**.
- `SUPABASE_SERVICE_ROLE_KEY` from the same place (`sb_secret_...`). **Never commit this.** Bypasses RLS.
- `DATABASE_URL` from **Project Settings → Database → Connection string → Session pooler** (not Direct, not Transaction pooler).
- `SESSION_SIGNING_SECRET` — generate with `openssl rand -base64 48`.

Sanity check the DB wiring:

```bash
pnpm check:rls   # "no public-schema tables found. OK." means you're good.
```

Then:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The health endpoint at [http://localhost:3000/api/health](http://localhost:3000/api/health) returns a JSON `ok` payload.

## Common scripts

| Command                             | What it does                                                |
| ----------------------------------- | ----------------------------------------------------------- |
| `pnpm dev`                          | Next.js dev server on :3000 (Turbopack)                     |
| `pnpm build && pnpm start`          | Production build and run                                    |
| `pnpm typecheck`                    | `tsc --noEmit` with strict + exactOptionalPropertyTypes     |
| `pnpm lint`                         | ESLint flat config, Next.js rules                           |
| `pnpm format` / `pnpm format:check` | Prettier write / verify                                     |
| `pnpm test`                         | Vitest unit tests (one-shot)                                |
| `pnpm test:watch`                   | Vitest watch mode                                           |
| `pnpm test:e2e`                     | Playwright smoke tests (auto-starts the dev server)         |
| `pnpm db:generate`                  | Drizzle: generate migration from schema changes             |
| `pnpm db:migrate`                   | Drizzle: apply migrations                                   |
| `pnpm db:studio`                    | Drizzle Studio browser                                      |
| `pnpm check:rls`                    | Fails if any public table has RLS disabled or zero policies |

## Repo layout

```
app/
  (marketing)/          public landing, pricing, legal
  (dashboard)/          operator app (authenticated)
  (widget)/             embeddable booking widget + hosted booking page
  api/                  API routes (REST + webhooks)
components/             React components (shadcn/ui based)
lib/
  db/                   Drizzle schema, queries, migrations
  stripe/               Stripe helpers, webhook handlers
  email/                Resend templates and senders
  sms/                  Twilio helpers
  security/             RLS helpers, encryption, audit log
  server/admin/         service_role clients — importable from here only
scripts/                Ops tools (check-rls, etc.)
tests/
  unit/                 Vitest
  e2e/                  Playwright
drizzle/                Generated migrations (checked in, forward-only)
docs/
  specs/                One markdown file per feature
  playbooks/            GDPR, payments, security, deploy, incident
.claude/                Project instructions, subagents, slash commands
```

## Working with Claude Code

This repo is designed for [Claude Code](https://claude.com/claude-code) as the primary dev loop.

- [CLAUDE.md](CLAUDE.md) is loaded on every session. Read it.
- Feature work starts with reading or writing the matching spec in [docs/specs/](docs/specs/).
- Slash commands in [.claude/commands/](.claude/commands/): `/spec`, `/plan-feature`, `/ship`, `/migrate`, `/review`, `/audit`.
- Subagents in [.claude/agents/](.claude/agents/): `code-reviewer`, `gdpr-auditor`, `security-reviewer`.
- Hooks in [.claude/hooks/](.claude/hooks/) run on tool use to guard against committing PII, card data, or service_role misuse.

Plans for multi-file work live in [.claude/plans/](.claude/plans/).

## Rules that matter (non-negotiable)

These are load-bearing — read them before your first PR:

1. **RLS on every tenant table, plus a cross-tenant test.** `pnpm check:rls` is the CI gate.
2. **No raw card data, ever.** Stripe Elements / Checkout only. Stay in PCI SAQ-A. See [payments.md](docs/playbooks/payments.md).
3. **PII columns are column-encrypted** via [lib/security/crypto.ts](lib/security/crypto.ts) (stub until design review). See [gdpr.md](docs/playbooks/gdpr.md).
4. **UK/EU data residency only.** Any new sub-processor needs the playbook updated and 30 days customer notice.
5. **Secrets in `.env.local` only.** [.env.local.example](.env.local.example) documents what's needed. `.env` is reserved for non-secret defaults.
6. **Conventional commits, small.** One concern per commit. Forward-only migrations. Two-phase drops.

## Environments and deploy

See [docs/playbooks/deploy.md](docs/playbooks/deploy.md) for the environment matrix, release flow, migrations, feature flags and pre-launch checklist.

When things break, [docs/playbooks/incident.md](docs/playbooks/incident.md) has the severity levels, kill switches and rollback playbook.

## Licence

Source-available; not yet open source. TBD.
