# CLAUDE.md

This file is the project's primary instruction set for Claude Code. It is loaded at the start of every session. Keep it concise — link out to `docs/specs/*.md` for feature-level detail instead of restating it here.

## Project: Tablekit (working name) — UK table booking SaaS

A lightweight, freemium table booking and management platform for UK independent hospitality operators (cafés, restaurants, bars, pubs). Positioned against OpenTable, ResDiary and Collins at ~10× lower cost. Built by a solo founder using Claude Code.

### Commercial model
- **Free forever** up to 50 bookings/month.
- **Core** £19/month (unlimited bookings, deposits, Reserve with Google).
- **Plus** £39/month (multi-venue, AI enquiry handler, priority support).
- SMS and Stripe fees are pass-through at cost.

---

## Tech stack (canonical — do not deviate without updating this file)

- **Language:** TypeScript (strict mode on).
- **Framework:** Next.js 15 (App Router) deployed on Vercel.
- **Database:** PostgreSQL on Supabase (UK region, London).
- **Auth:** Supabase Auth (email+password, magic link, TOTP for owners).
- **ORM:** Drizzle ORM (preferred over Prisma — smaller, faster, SQL-first).
- **Payments:** Stripe (Stripe Connect Standard — venue is merchant of record).
- **Email:** Resend.
- **SMS:** Twilio (UK).
- **Edge / DNS / WAF:** Cloudflare.
- **Error tracking:** Sentry (EU region).
- **Jobs / queues:** Vercel Cron + Supabase Edge Functions. No Redis until we need it.
- **Testing:** Vitest (unit), Playwright (e2e smoke tests only).
- **Package manager:** pnpm.
- **Node version:** 22 LTS.

## Repo layout

```
.
├── app/                    Next.js routes (App Router)
│   ├── (marketing)/        Public landing, pricing, legal
│   ├── (dashboard)/        Operator app (authenticated)
│   ├── (widget)/           Embeddable booking widget + hosted page
│   └── api/                API routes (REST + webhooks)
├── components/             React components (shadcn/ui based)
├── lib/
│   ├── db/                 Drizzle schema, queries, migrations
│   ├── stripe/             Stripe helpers, webhook handlers
│   ├── email/              Resend templates and senders
│   ├── sms/                Twilio helpers
│   └── security/           RLS helpers, encryption, audit log
├── docs/
│   ├── specs/              Feature specs (read these before building a feature)
│   └── playbooks/          Ops, security, GDPR, incident playbooks
├── .claude/
│   ├── commands/           Project-scoped slash commands
│   └── agents/             Project-scoped subagents
└── CLAUDE.md               (this file)
```

---

## The rules (read these — they matter)

1. **Before starting any feature, read the matching spec.** Specs live in `docs/specs/`. If no spec exists, write one first (use `/spec <feature-name>`) before writing code.
2. **Every feature ends with three things: tests, a migration plan, and a security check.** Never mark work done without them.
3. **RLS first, always.** Every new table that contains tenant data must ship with a Postgres row-level security policy and an integration test that proves tenant A cannot see tenant B's data. No exceptions.
4. **No raw card data, ever.** Cards are only handled by Stripe Elements or Stripe Checkout. If you find yourself wanting to store a `pan` or `cvv`, stop and re-read `docs/playbooks/payments.md`.
5. **PII columns are encrypted.** Guest surname, phone, and DoB are encrypted at column level via `lib/security/crypto.ts`. Email is hashed for lookup, stored plaintext for display only on the venue that owns it.
6. **UK/EU data residency.** No sub-processor outside the UK/EU may receive PII unless explicitly approved and added to `docs/playbooks/gdpr.md` sub-processor list.
7. **Use `/plan` for anything over 3 files.** It's cheaper to re-plan than to re-code.
8. **Use subagents for review.** Before merging a PR, run `@code-reviewer` and `@gdpr-auditor` from `.claude/agents/`.
9. **Commits are small and reversible.** Conventional commits (`feat:`, `fix:`, `chore:`). One concern per commit.
10. **Secrets go in `.env.local` only.** Never committed. `.env.local.example` documents the required names with no values.

## Common commands

```bash
pnpm dev                 # Dev server on :3000
pnpm build && pnpm start # Production build locally
pnpm test                # Vitest unit tests
pnpm test:e2e            # Playwright e2e (requires dev server running)
pnpm typecheck           # tsc --noEmit
pnpm lint                # eslint + prettier
pnpm db:generate         # Drizzle: generate migration from schema changes
pnpm db:migrate          # Apply migrations to local DB
pnpm db:studio           # Drizzle Studio
```

## Style & conventions

- TypeScript strict. No `any`. Prefer `unknown` then narrow.
- React Server Components by default. `"use client"` only when interactive state or effects are needed.
- Server actions for mutations where possible; API routes only for webhooks, public API, and cross-origin widget calls.
- Errors: return typed `Result<T, E>` from domain functions; throw only at the HTTP boundary.
- Files: kebab-case filenames, PascalCase component names.
- No default exports except where Next.js requires them (pages, layouts).
- Tailwind: use design tokens from `tailwind.config.ts`. Don't hand-roll colours.

## Development loop (the expected flow)

For any feature:
1. Read `docs/specs/<feature>.md`. If missing, run `/spec <feature>` to create one.
2. Run `/plan` if the change touches more than three files.
3. Write a failing test first when the logic is non-trivial.
4. Implement.
5. Run `pnpm typecheck && pnpm lint && pnpm test`.
6. Run `@code-reviewer` subagent on the diff.
7. If the feature touches guest or payment data, run `@gdpr-auditor`.
8. Run `/ship` to commit and push.

## Non-goals (year 1)

No marketplace, no dedicated mobile app, no native POS integrations beyond webhooks, no enterprise CRM features, no kitchen display, no ordering, no custom loyalty engine. These are explicitly out of scope — resist scope creep.

## Where to look for more

- `docs/specs/index.md` — list of all feature specs
- `docs/playbooks/gdpr.md` — data protection playbook
- `docs/playbooks/payments.md` — PCI-safe payment handling
- `docs/playbooks/security.md` — app security checklist
- `docs/playbooks/incident.md` — what to do if something breaks in prod
- `docs/playbooks/deploy.md` — deployment process
