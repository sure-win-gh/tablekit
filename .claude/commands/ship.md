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
9. **Open the PR.** Push, open PR against `main` with a description that references the spec and lists acceptance criteria. Do not merge — I will.

## Rules

- Never skip a failing check to "deal with later."
- Never disable RLS, even temporarily, even in a migration.
- Never include card data, tokens, or real PII in tests.
- If a task is larger than ~300 lines of diff, split it into multiple PRs.
- If you hit something underspecified in the spec, stop and ask me — don't improvise.
