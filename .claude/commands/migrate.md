---
description: Generate a safe forward-only Drizzle migration.
allowed-tools: Bash, Read, Write, Edit, Grep
---

# /migrate <change-description>

Produce a Drizzle migration for the change described.

## Safety rules (non-negotiable)

- **Forward-only.** No down-migrations.
- New columns must be nullable or have a default value.
- Drops happen in two releases: first release stops writing the column, second release drops it. Never in one migration.
- Renames: add new, backfill, dual-write, cut reads, then drop old. Never `ALTER ... RENAME` in one step.
- RLS must be preserved: if a new table is created, its migration includes `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and at least one policy.
- Migrations must complete in under 10 seconds. Large backfills happen in a background job, not a migration.
- No destructive operations on tables containing PII without an explicit `-- CONFIRMED: erasing X` comment on the SQL line, and an `audit_log` insert in the same migration.

## Output

1. Generate the migration with `pnpm db:generate`.
2. Review the generated SQL against the rules above.
3. If unsafe, rewrite it into the safe multi-step form.
4. Include a migration note at the top explaining what the change does and why it's safe.
5. Stop before applying to any environment. I apply migrations by hand the first few times.
