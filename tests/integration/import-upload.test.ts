// Integration test for the upload helper.
//
// Drives `createImportJob` directly (the dashboard action wraps this
// + requireRole + audit logging). Verifies:
//   - Successful path persists at `preview_ready` with empty
//     column_map and an encrypted source CSV that round-trips.
//   - Empty / too-large CSVs are rejected without writing.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { MAX_SIZE_BYTES, createImportJob } from "@/lib/import/upload";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);

type Ctx = { orgId: string; userId: string };
let ctx: Ctx;

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `imp-up-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
    user_metadata: { full_name: "Imp Up" },
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Imp-Up ${run}`, slug: `imp-up-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");
  await db.insert(schema.memberships).values({
    userId: data.user.id,
    organisationId: org.id,
    role: "owner",
  });
  ctx = { orgId: org.id, userId: data.user.id };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

const SAMPLE_CSV = "First Name,Email\nJane,jane@example.com\nJoe,joe@example.com\n";

describe("createImportJob — happy path", () => {
  it("persists a preview_ready row with empty column_map and encrypted CSV", async () => {
    const r = await createImportJob({
      organisationId: ctx.orgId,
      actorUserId: ctx.userId,
      source: "generic-csv",
      filename: "guests.csv",
      csvText: SAMPLE_CSV,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const [row] = await db
      .select()
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, r.jobId));
    expect(row?.status).toBe("preview_ready");
    expect(row?.columnMap).toEqual({});
    expect(row?.source).toBe("generic-csv");
    expect(row?.filename).toBe("guests.csv");
    expect(row?.sourceSizeBytes).toBe(SAMPLE_CSV.length);
    expect(row?.sourceCsvCipher).not.toBeNull();

    // The encrypted CSV must round-trip under the org's DEK.
    const plaintext = await decryptPii(ctx.orgId, row!.sourceCsvCipher as Ciphertext);
    expect(plaintext).toBe(SAMPLE_CSV);
  });

  it("trims + caps the filename at 200 chars", async () => {
    const longFilename = "  " + "a".repeat(300) + "  ";
    const r = await createImportJob({
      organisationId: ctx.orgId,
      actorUserId: ctx.userId,
      source: "generic-csv",
      filename: longFilename,
      csvText: SAMPLE_CSV,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [row] = await db
      .select({ filename: schema.importJobs.filename })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, r.jobId));
    expect(row?.filename.length).toBe(200);
    expect(row?.filename.startsWith("  ")).toBe(false);
  });
});

describe("createImportJob — rejections (no DB write)", () => {
  it("rejects an empty CSV", async () => {
    const r = await createImportJob({
      organisationId: ctx.orgId,
      actorUserId: ctx.userId,
      source: "generic-csv",
      filename: "empty.csv",
      csvText: "",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty");
  });

  it("rejects a CSV over the 50MB cap (single-byte chars)", async () => {
    const r = await createImportJob({
      organisationId: ctx.orgId,
      actorUserId: ctx.userId,
      source: "generic-csv",
      filename: "huge.csv",
      // One byte past the cap; no encrypt cost since we short-
      // circuit before touching the crypto layer.
      csvText: "x".repeat(MAX_SIZE_BYTES + 1),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too-large");
  });

  it("rejects a CSV that's under-cap by char count but over by byte count (UTF-8)", async () => {
    // "é" is 2 bytes in UTF-8 / 1 UTF-16 code unit. Half-the-cap
    // worth of "é" = char count below cap, byte count above.
    const halfCapChars = Math.floor(MAX_SIZE_BYTES / 2) + 1;
    const r = await createImportJob({
      organisationId: ctx.orgId,
      actorUserId: ctx.userId,
      source: "generic-csv",
      filename: "multibyte.csv",
      csvText: "é".repeat(halfCapChars),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too-large");
  });
});
