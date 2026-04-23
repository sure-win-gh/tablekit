---
description: Produce a detailed implementation plan for a spec, without coding.
allowed-tools: Read, Grep, Glob, Write
---

# /plan-feature <spec-name>

Read `docs/specs/<spec-name>.md`, its dependencies, and the relevant playbooks. Then produce an implementation plan written to `.claude/plans/<spec-name>.md`.

The plan must include:

1. **Files to create** — absolute paths, one line each.
2. **Files to modify** — path and what changes.
3. **Migrations** — SQL DDL, migration filename.
4. **RLS policies** — exact policy SQL for every new org-scoped table.
5. **Tests** — unit and e2e. One line each.
6. **Risks** — what could go wrong, what to watch for at review time.
7. **Rollback plan** — what undoes this change if it breaks in production.
8. **Estimated diff size** — lines added, files touched.

## Rules

- Do not write implementation code. Plans only.
- If the plan would produce more than ~300 lines of diff, recommend splitting into multiple PRs and draft the split.
- Flag anything that expands PCI scope beyond SAQ-A. Stop and ask.
- Flag any new sub-processor. Stop and ask.
- Flag any plaintext PII handling outside `lib/security/crypto.ts`. Stop and ask.
