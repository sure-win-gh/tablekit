#!/usr/bin/env tsx
// Fails CI if a NEW Drizzle migration contains a destructive or
// rewrite-unsafe statement. This mechanically enforces the two-phase /
// expand-contract rules in docs/playbooks/deploy.md §Migrations, and is
// what keeps one-click rollback safe (docs/specs/deployment-pipeline.md
// §Workstream 3): the previous (N-1) release must always run correctly
// against the current schema, so rollback never has to touch the DB.
//
// Only migrations *added or modified in the current change set* are
// scanned — the committed migration history is immutable and grandfathered.
// The change set is computed by diffing against a base ref (default
// `origin/main`; override with MIGRATION_SAFETY_BASE).
//
// Escape hatch: a deliberate second-phase drop can acknowledge the risk
// with a file-level marker, e.g.
//   -- migration-safety-ack: phase 2 of dropping legacy_col; 0068 stopped writes
// The file is then skipped and the acknowledgement is echoed loudly.
//
// Usage:
//   pnpm check:migrations
//   MIGRATION_SAFETY_BASE=origin/main pnpm check:migrations
//
// Exit codes: 0 = clean (or nothing to check), 1 = unsafe statement found,
// 2 = could not determine the change set (misconfig — does not gate).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MIGRATIONS_DIR = "drizzle/migrations";
const ACK_RE = /--\s*migration-safety-ack:\s*(.+)/i;

export type Rule = {
  id: string;
  test: (statement: string) => boolean;
  message: string;
};

export type Finding = {
  rule: string;
  message: string;
  statement: string;
};

// Each rule receives a single SQL statement with comments and
// dollar-quoted bodies already stripped and whitespace collapsed.
export const RULES: readonly Rule[] = [
  {
    id: "drop-table",
    test: (s) => /\bDROP\s+TABLE\b/i.test(s),
    message:
      "DROP TABLE loses data and breaks the still-live N-1 release. Two-phase it: stop using the table first, drop it in a later release (deploy.md §Migrations).",
  },
  {
    id: "drop-column",
    test: (s) =>
      /\bDROP\s+COLUMN\b/i.test(s) ||
      /\bALTER\s+TABLE\b.*\bDROP\s+(?!CONSTRAINT|NOT\s+NULL|DEFAULT)/i.test(s),
    message:
      "DROP COLUMN breaks the N-1 release still reading it (and blocks safe rollback). Stop reading/writing it first; drop in a later release (deploy.md §Migrations).",
  },
  {
    id: "rename-column",
    test: (s) => /\bRENAME\s+COLUMN\b/i.test(s),
    message:
      "RENAME COLUMN is not backward-compatible. Use add-new → backfill → dual-write → cut-reads → drop-old across releases (deploy.md §Migrations).",
  },
  {
    id: "rename-table",
    test: (s) => /\bALTER\s+TABLE\b[\s\S]*\bRENAME\s+TO\b/i.test(s),
    message:
      "RENAME TABLE is not backward-compatible in a live release. Use the expand/contract pattern instead (deploy.md §Migrations).",
  },
  {
    id: "set-not-null",
    test: (s) => /\bSET\s+NOT\s+NULL\b/i.test(s),
    message:
      "SET NOT NULL fails if any existing row is NULL and rejects the N-1 release's NULL writes. Backfill first, then constrain in a later release.",
  },
  {
    id: "add-not-null-no-default",
    test: (s) =>
      /\bADD\s+COLUMN\b/i.test(s) &&
      /\bNOT\s+NULL\b/i.test(s) &&
      !/\bDEFAULT\b/i.test(s) &&
      !/\bGENERATED\b/i.test(s),
    message:
      "ADD COLUMN … NOT NULL without a DEFAULT fails on a non-empty table and rejects the N-1 release's inserts. Add it nullable (or with a default), backfill, then constrain.",
  },
];

// Remove comments and dollar-quoted bodies so keywords inside function
// bodies or comments never trip a rule, then split into statements.
export function statementsOf(sql: string): string[] {
  const cleaned = sql
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // line comments (covers Drizzle's `--> statement-breakpoint` marker)
    .replace(/--[^\n]*/g, " ")
    // tagged dollar-quoted bodies: $tag$ ... $tag$
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ")
    // anonymous dollar-quoted bodies: $$ ... $$
    .replace(/\$\$[\s\S]*?\$\$/g, " ");

  return cleaned
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

export function scanSql(sql: string): Finding[] {
  const findings: Finding[] = [];
  for (const statement of statementsOf(sql)) {
    for (const rule of RULES) {
      if (rule.test(statement)) {
        findings.push({
          rule: rule.id,
          message: rule.message,
          statement: statement.length > 140 ? `${statement.slice(0, 137)}…` : statement,
        });
      }
    }
  }
  return findings;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function refExists(ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveBase(): string | null {
  const candidates = [process.env["MIGRATION_SAFETY_BASE"], "origin/main", "main"].filter(
    (c): c is string => Boolean(c),
  );
  for (const ref of candidates) {
    if (refExists(ref)) return ref;
  }
  return null;
}

function changedMigrationFiles(base: string): string[] {
  // base → working tree: added/modified tracked files, plus untracked ones.
  const tracked = git(["diff", "--name-only", "--diff-filter=AM", base, "--", MIGRATIONS_DIR]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", MIGRATIONS_DIR]);
  const all = `${tracked}\n${untracked}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"));
  return [...new Set(all)].sort();
}

function main(): void {
  const base = resolveBase();
  if (base === null) {
    console.error(
      "check-migrations: could not resolve a base ref (tried MIGRATION_SAFETY_BASE, origin/main, main).",
    );
    console.error(
      "check-migrations: in CI, check out with fetch-depth: 0 so origin/main is available. " +
        "Failing (exit 2) so the check is never silently skipped.",
    );
    process.exit(2);
  }

  let files: string[];
  try {
    files = changedMigrationFiles(base);
  } catch (err: unknown) {
    console.error("check-migrations: git failed while computing the change set:", err);
    process.exit(2);
  }

  if (files.length === 0) {
    console.log(`check-migrations: no new/changed migrations vs ${base}. OK.`);
    return;
  }

  const problems: { file: string; findings: Finding[] }[] = [];
  for (const file of files) {
    const content = readFileSync(resolve(process.cwd(), file), "utf8");
    const ack = ACK_RE.exec(content);
    if (ack) {
      console.log(`check-migrations: ${file} acknowledged — skipping. Reason: ${ack[1]?.trim()}`);
      continue;
    }
    const findings = scanSql(content);
    if (findings.length > 0) problems.push({ file, findings });
  }

  const scanned = files.length;
  if (problems.length === 0) {
    console.log(`check-migrations: OK — scanned ${scanned} new/changed migration(s) vs ${base}.`);
    return;
  }

  console.error(`\ncheck-migrations: FAIL — unsafe statements in new migration(s):\n`);
  for (const { file, findings } of problems) {
    console.error(`  ${file}`);
    for (const f of findings) {
      console.error(`    [${f.rule}] ${f.message}`);
      console.error(`      → ${f.statement}`);
    }
    console.error("");
  }
  console.error(
    "Fix: rework as a backward-compatible (expand/contract) migration per deploy.md §Migrations,\n" +
      "or, for a deliberate second-phase change, add a file-level marker:\n" +
      "  -- migration-safety-ack: <why this is safe now>",
  );
  process.exit(1);
}

// Only run when invoked directly (so tests can import the pure helpers).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
