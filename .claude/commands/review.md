---
description: Delegate a diff to the code-reviewer subagent.
allowed-tools: Bash, Read
argument-hint: [optional branch or commit range]
---

# /review

Run the `code-reviewer` subagent on the current diff (or a specified range).

## What to do

1. Capture the diff:
   - If arguments are given (e.g. `/review main...HEAD`), use that range.
   - Otherwise use `git diff main...HEAD`.
2. Invoke the `code-reviewer` subagent with the diff and a brief summary of the feature being shipped (read from `.claude/plans/<feature>.md` if one exists).
3. Return the subagent's findings verbatim, then list the 3 most important action items with file and line numbers.

## What the reviewer is checking for

- Correctness on the happy path and at least two edge cases.
- RLS coverage for every new table and query.
- Drizzle parameterisation (no string-concat SQL).
- Zod validation on every new server action / route.
- No raw card data anywhere (SAQ-A scope).
- No plaintext PII in logs, errors, or responses crossing org boundaries.
- Tests exist for the acceptance criteria in the relevant spec.
- No new dependency pulled in without justification.
- Migration safety (forward-only, two-phase drops/renames).

Trust the reviewer's output but verify high-stakes claims (security, RLS) by reading the cited files yourself.
