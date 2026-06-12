---
description: End-to-end: implement a spec, run checks, open PR.
allowed-tools: Bash, Edit, Write, Read, Grep, Glob
---

# /ship <spec-name-or-feature>

You are shipping a change. Follow this loop strictly:

1. **Read the relevant spec.** If an argument is given (e.g. `/ship waitlist`), read `docs/specs/<arg>.md`. Otherwise ask me which feature we're shipping.
2. **Read every playbook the spec depends on.** Always `gdpr.md` and `security.md`. Also `payments.md` if the change touches money.
3. **Draft a plan.** Don't start coding. Write the plan to `.claude/plans/<feature>.md` with: scope, files to add/modify, data model changes, RLS policy changes, test list. Then stop and wait for my confirmation.
4. **Implement in small commits.** One logical change per commit. Use `git add -p` granularity — stage only the relevant hunks.
5. **Write tests first when the change is risky** (RLS, payments, availability). Otherwise test immediately after the implementation, before moving on.
6. **Run the checks locally:**
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm e2e:smoke` (if UI changed)
   - `pnpm db:check-rls`
7. **Self-review.** Run `/review` on the diff.
8. **GDPR / payments audit.** If the diff touches PII, `/audit gdpr`. If it touches cards/payments, `/audit payments`.
9. **Marketing sync.** If the feature is customer-visible (per the spec's Marketing impact section), it is **not done** until the marketing site reflects it — this gate sits alongside tests + migration + security:
   - Add or update the feature's entry in `lib/marketing/features.ts` (`status: "live"` once shipped, `"coming-soon"` if pre-launch).
   - If the spec says `Needs feature page: yes`, add/update `/features/<slug>` with real benefit copy and a real-app screenshot slot.
   - Verify the pricing matrix and `/features` index render correctly (they read from the registry — no per-page edits needed).
   - Update the feature's Status row in `docs/specs/index.md`.
   - See `docs/playbooks/marketing-frontend.md`. A customer-visible diff with no `lib/marketing/features.ts` change is a review failure.
10. **Open the PR.** Push, open PR against `main` with a description that references the spec and lists acceptance criteria. Do not merge — I will.

## Rules

- Never skip a failing check to "deal with later."
- Never disable RLS, even temporarily, even in a migration.
- Never include card data, tokens, or real PII in tests.
- Never mark a customer-visible feature done without its marketing-sync step (registry entry + any feature page) — it ranks with tests, migration and security.
- If a task is larger than ~300 lines of diff, split it into multiple PRs.
- If you hit something underspecified in the spec, stop and ask me — don't improvise.
