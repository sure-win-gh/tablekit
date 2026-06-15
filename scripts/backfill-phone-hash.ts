#!/usr/bin/env tsx
// One-off backfill: populate guests.phone_hash for rows created before
// migration 0050 (which added the column). New guests get the hash via
// upsertGuest automatically; this fills the legacy gap so POS hash matching
// works for existing guests too.
//
// Idempotent + resumable: only touches rows that have a stored cipher but no
// lookup hash, so re-running is safe. PII-safe: the plaintext is held only
// transiently to compute the HMAC; nothing is printed but counts + the DB
// host (no credentials).
//
// Run AFTER migration 0050 is applied to the target DB. The npm script bakes
// in the `--conditions=react-server` flag (so the `server-only` guard resolves
// to a no-op under tsx); run it that way rather than raw tsx:
//   pnpm db:backfill-phone-hash --dry-run   # count only, no writes
//   pnpm db:backfill-phone-hash             # backfill
//
// Production: cut the prod deploy first (Vercel pre-deploy hook applies the
// migration), then run with DATABASE_URL pointed at the prod Supabase, e.g.
//   DATABASE_URL="<prod>" pnpm db:backfill-phone-hash --dry-run
// The script prints the target DB host (no credentials) so you can confirm
// you're hitting prod, not dev, before writing.

import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { and, isNotNull, isNull, sql } from "drizzle-orm";

// Match the app's env-file precedence: .env.local overrides .env.
loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

import { guests } from "@/lib/db/schema";
import { backfillGuestPhoneHash } from "@/lib/guests/backfill-phone-hash";
import { adminDb } from "@/lib/server/admin/db";

const TAG = "[lookup-hash-backfill]";

function dbHost(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) return "<DATABASE_URL not set>";
  try {
    return new URL(url).host; // host only — never the credentials
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

// Rows that have a stored contact cipher but no lookup hash yet.
async function countPending(): Promise<number> {
  const [row] = await adminDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(guests)
    .where(and(isNotNull(guests.phoneCipher), isNull(guests.phoneHash)));
  return Number(row?.n ?? 0);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`${TAG} target DB host: ${dbHost()}`);

  const pending = await countPending();
  console.log(`${TAG} rows needing the lookup hash: ${pending}`);

  if (dryRun) {
    console.log(`${TAG} --dry-run: no writes performed.`);
    return;
  }

  if (pending === 0) {
    console.log(`${TAG} nothing to do.`);
    return;
  }

  const result = await backfillGuestPhoneHash();
  console.log(`${TAG} done — scanned ${result.scanned}, updated ${result.updated}.`);

  const remaining = await countPending();
  console.log(`${TAG} remaining after run: ${remaining}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // Bland error only — never echo row data.
    console.error(`${TAG} failed:`, err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
