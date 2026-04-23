#!/usr/bin/env tsx
// Fails CI if any public-schema table has RLS disabled, or RLS-enabled
// with zero policies (policy-less RLS blocks everything, which is
// almost always a misconfiguration rather than intent).
//
// Referenced by docs/playbooks/security.md §Authorisation. Every PR
// that adds a table must either (a) enable RLS and ship at least one
// policy, or (b) add the table to scripts/rls-allowlist.txt with a
// written justification.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

type TableRow = {
  table_name: string;
  rls_enabled: boolean;
  policy_count: number;
};

const ALLOWLIST_PATH = resolve(process.cwd(), "scripts/rls-allowlist.txt");

function loadAllowlist(): Set<string> {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const entries = readFileSync(ALLOWLIST_PATH, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
  return new Set(entries);
}

async function main(): Promise<void> {
  // Load .env.local first, then .env — mirrors Next.js precedence.
  loadEnv({ path: resolve(process.cwd(), ".env.local") });
  loadEnv({ path: resolve(process.cwd(), ".env") });

  if (process.env["SKIP_RLS_CHECK"] === "1") {
    console.log("check-rls: SKIP_RLS_CHECK=1 set, skipping.");
    return;
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error(
      "check-rls: DATABASE_URL is not set. Set it, or set SKIP_RLS_CHECK=1 to bypass.",
    );
    process.exit(2);
  }

  const allowlist = loadAllowlist();
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();

    const { rows } = await client.query<TableRow>(`
      select
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        (
          select count(*)::int
          from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname
        ) as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
      order by c.relname
    `);

    if (rows.length === 0) {
      console.log("check-rls: no public-schema tables found. OK.");
      return;
    }

    const rlsDisabled: string[] = [];
    const policyless: string[] = [];

    for (const row of rows) {
      if (allowlist.has(row.table_name)) continue;
      if (!row.rls_enabled) {
        rlsDisabled.push(row.table_name);
        continue;
      }
      if (row.policy_count === 0) {
        policyless.push(row.table_name);
      }
    }

    const checked = rows.length - allowlist.size;
    console.log(
      `check-rls: checked ${checked} table(s) (${allowlist.size} allowlisted).`,
    );

    if (rlsDisabled.length === 0 && policyless.length === 0) {
      console.log("check-rls: OK — every table has RLS enabled and at least one policy.");
      return;
    }

    if (rlsDisabled.length > 0) {
      console.error("\ncheck-rls: FAIL — tables with RLS disabled:");
      for (const name of rlsDisabled) console.error(`  - ${name}`);
    }
    if (policyless.length > 0) {
      console.error("\ncheck-rls: FAIL — tables with RLS enabled but zero policies:");
      for (const name of policyless) console.error(`  - ${name}`);
    }
    console.error(
      "\nFix: add a policy in the same migration, or allowlist in scripts/rls-allowlist.txt.",
    );
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("check-rls: unexpected error:", err);
  process.exit(2);
});
