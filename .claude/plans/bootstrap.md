# Plan: bootstrap

**Goal:** stand up the TableKit Next.js repo skeleton from the existing scaffold (specs, playbooks, CLAUDE.md, subagents) so we can start shipping the `auth` spec next.

**Scope:** repo init + tooling + repo layout only. **No domain code, no schema, no real crypto, no Stripe/Supabase calls.** Those land with their respective specs.

## Decisions (confirmed by operator)

| # | Question | Decision |
|---|----------|----------|
| 1 | Merge `claude/` → `.claude/`? | Yes |
| 2 | Env filename `.env.example` vs `.env.local.example`? | `.env.local.example`; update `CLAUDE.md` line 87 to match |
| 3 | Wire a GitHub remote? | No — `git init` only |
| 4 | Node 22 pin | `22.11.0` (first 22 LTS — conservative baseline) |

## Commits (small, conventional, one concern each)

1. `chore: initialise repo and merge claude config`
   - `git init`
   - Move `claude/*` → `.claude/` (agents, commands, hooks, settings.json)
   - `chmod +x .claude/hooks/*.js`
   - Delete `.DS_Store` files; add `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc` (22.11.0)
   - Fix `CLAUDE.md` line 87 (`.env.example` → `.env.local.example`)

2. `feat: scaffold next.js 15 app`
   - Create Next.js 15 App Router app *in place* (no `src/`), TypeScript, Tailwind, ESLint, import alias `@/*`
   - `package.json` `engines.node = "22.11.0"`, `packageManager = "pnpm@..."`
   - Remove Next.js default marketing boilerplate, keep a minimal home page

3. `chore: tighten typescript and add prettier`
   - `tsconfig.json`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `forceConsistentCasingInFileNames`
   - `.prettierrc`, `.prettierignore`
   - Scripts: `typecheck`, `lint`, `format`, `format:check`

4. `chore: scaffold repo layout`
   - `app/(marketing)/page.tsx` (simple placeholder)
   - `app/(dashboard)/layout.tsx` + placeholder page
   - `app/(widget)/layout.tsx` + placeholder page
   - `app/api/health/route.ts` (returns `{ ok: true, ts }`)
   - `components/.gitkeep`
   - `lib/db/.gitkeep`, `lib/stripe/.gitkeep`, `lib/email/.gitkeep`, `lib/sms/.gitkeep`, `lib/security/.gitkeep`
   - `docs/specs/` and `docs/playbooks/` already present (keep untouched)

5. `chore: install canonical stack (pinned)`
   - Runtime (exact pins, no `^`/`~`):
     - `drizzle-orm`, `drizzle-kit` (dev), `pg`, `@types/pg` (dev)
     - `@supabase/supabase-js`, `@supabase/ssr`
     - `stripe`
     - `resend`
     - `twilio`
     - `zod`
   - Dev: `vitest`, `@vitest/coverage-v8`, `@playwright/test`, `tsx`, `dotenv`

6. `feat(db): add drizzle config and supabase clients`
   - `drizzle.config.ts` (schema in `lib/db/schema.ts` — empty export for now)
   - `lib/db/client.ts`:
     - `authed()` — RLS-respecting client built from user session (placeholder TODO)
     - `admin()` — service_role client, throws if imported outside `lib/server/admin/`
   - `lib/db/schema.ts` — empty module
   - `lib/security/crypto.ts` — throws `NotImplementedError("envelope encryption pending design review — see docs/playbooks/gdpr.md")`. Exports the interface shape we expect (`encryptPii`, `decryptPii`, `hashForLookup`).
   - NO schema yet — lands with `auth` spec plus RLS + cross-tenant test

7. `feat(ci): add RLS check script`
   - `scripts/check-rls.ts` queries `pg_class` + `pg_policies`:
     - Fails if any `public.*` table has `relrowsecurity = false`
     - Fails if any RLS-enabled table has zero policies (policy-less RLS blocks everything, which usually means misconfigured)
     - Allowlist file: `scripts/rls-allowlist.txt` for known-safe tables (e.g. `drizzle_migrations`)
   - `pnpm check:rls` script in `package.json`

8. `chore: add env.local.example`
   - Every var referenced in specs/playbooks, placeholder values only
   - Grouped: App, Supabase, Stripe, Resend, Twilio, Sentry, Upstash (rate limit), Kill switches, Encryption (Vault key ref)
   - No real URLs, no real secrets

9. `test: add vitest and playwright harnesses`
   - `vitest.config.ts`, `tests/unit/smoke.test.ts`
   - `playwright.config.ts`, `tests/e2e/smoke.spec.ts` (hits `/api/health`)

10. `docs: add developer readme`
    - Overwrite `README.md` with a human-facing "how to run locally" README
    - Move the scaffold-meta notes (what's in here, how subagents work) to `docs/scaffold.md`

11. `ci: add github actions workflow`
    - `.github/workflows/ci.yml`: typecheck, lint, unit tests, `pnpm check:rls` (skipped with a note if `DATABASE_URL` unset), `pnpm audit --audit-level=high`
    - No deploy job yet — wired with the deploy playbook later

## Explicitly out of scope

- Real Drizzle schema (lands with `auth` spec + RLS test)
- Real `lib/security/crypto.ts` implementation (needs Vault key design discussion)
- Sentry init (lands with first prod endpoint)
- hCaptcha / Upstash rate limiting (lands with widget spec)
- Stripe webhook route (lands with payments spec)
- Any `.env.local` creation — only `.env.local.example`

## Exit criteria

- `pnpm install && pnpm dev` serves [http://localhost:3000](http://localhost:3000) with a placeholder home and `/api/health` returns 200
- `pnpm typecheck && pnpm lint && pnpm test` all pass
- `pnpm check:rls` runs and reports (0 tables exist so it exits 0 with a "no tables yet" note)
- `.claude/` contains settings, hooks, agents, commands, plans
- Git history is a clean sequence of conventional commits, no push

## Next

Once this lands, propose the `auth` spec as the first feature. First migration introduces `organisations`, `memberships`, RLS, and the cross-tenant test — the template every future table will follow.
