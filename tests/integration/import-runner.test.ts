// Integration test for the bulk-import runner.
//
// Drives a real `import_jobs` row through the runner end-to-end:
//   - Encrypts a real CSV via lib/security/crypto.ts:encryptPii
//   - Calls processImportJob
//   - Asserts: guests landed, counts are right, source CSV nulled,
//     re-running is idempotent (no double-insert)
//
// Uses the same Pool / asUser dance as rls-import-jobs.test.ts but
// drives writes via the superuser pool (the runner uses adminDb in
// production). RLS isn't under test here — we already test that on
// the read path in rls-import-jobs.test.ts.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { processImportJob } from "@/lib/import/runner/writer";
import { type Plaintext, encryptPii, hashForLookup } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = { orgId: string };
let ctx: Ctx;

const SAMPLE_CSV =
  "First Name,Last Name,Email,Phone,Notes\n" +
  "Jane,Doe,jane@example.com,07700900111,window seat\n" +
  "Joe,Bloggs,joe@example.com,07700900222,\n" +
  "Kit,Smith,kit@example.com,,allergic to nuts\n" +
  ",Anonymous,no-name@example.com,,\n" + // rejected: missing firstName
  "Liz,Brown,not-an-email,07700900333,\n"; // rejected: invalid email

const COLUMN_MAP = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  phone: "Phone",
  notes: "Notes",
};

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Imp-Run ${run}`, slug: `imp-run-${run}` })
    .returning({ id: schema.organisations.id });
  if (!org) throw new Error("org insert returned no row");
  ctx = { orgId: org.id };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

async function seedJob(): Promise<string> {
  const cipher = await encryptPii(ctx.orgId, SAMPLE_CSV as Plaintext);
  const [job] = await db
    .insert(schema.importJobs)
    .values({
      organisationId: ctx.orgId,
      source: "generic-csv",
      filename: "guests.csv",
      status: "queued",
      sourceCsvCipher: cipher,
      sourceSizeBytes: SAMPLE_CSV.length,
      columnMap: COLUMN_MAP,
    })
    .returning({ id: schema.importJobs.id });
  if (!job) throw new Error("import_jobs insert returned no row");
  return job.id;
}

describe("processImportJob — happy path", () => {
  it("writes valid rows, rejects malformed, nulls the source on completion", async () => {
    const jobId = await seedJob();
    const result = await processImportJob(jobId);

    expect(result.status).toBe("completed");
    expect(result.imported).toBe(3); // jane, joe, kit
    expect(result.rejected).toBe(2); // missing firstName + invalid email

    const [job] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, jobId));
    expect(job?.status).toBe("completed");
    expect(job?.rowCountTotal).toBe(5);
    expect(job?.rowCountImported).toBe(3);
    expect(job?.rowCountRejected).toBe(2);
    expect(job?.sourceCsvCipher).toBeNull();
    expect(job?.sourceSizeBytes).toBeNull();
    expect(job?.completedAt).not.toBeNull();

    // Each imported guest exists with imported_from + imported_at +
    // import_job_id linkage.
    const inserted = await db
      .select()
      .from(schema.guests)
      .where(eq(schema.guests.organisationId, ctx.orgId));
    expect(inserted).toHaveLength(3);
    for (const g of inserted) {
      expect(g.importedFrom).toBe("generic-csv");
      expect(g.importedAt).not.toBeNull();
      expect(g.importJobId).toBe(jobId);
      // Marketing consent stays null per gdpr.md — never imported as granted.
      expect(g.marketingConsentEmailAt).toBeNull();
      expect(g.marketingConsentSmsAt).toBeNull();
    }

    // Tidy: delete the inserted guests so the next test starts fresh.
    await db.delete(schema.guests).where(eq(schema.guests.organisationId, ctx.orgId));
  });
});

describe("processImportJob — collisions", () => {
  it("skips candidates whose email already exists in the org", async () => {
    // Pre-seed a guest with jane@example.com so the import collides.
    const emailHash = hashForLookup("jane@example.com", "email");
    const [emailCipher, lastNameCipher] = await Promise.all([
      encryptPii(ctx.orgId, "jane@example.com" as Plaintext),
      encryptPii(ctx.orgId, "Existing" as Plaintext),
    ]);
    await db.insert(schema.guests).values({
      organisationId: ctx.orgId,
      firstName: "Existing",
      lastNameCipher,
      emailCipher,
      emailHash,
    });

    const jobId = await seedJob();
    const result = await processImportJob(jobId);

    expect(result.status).toBe("completed");
    expect(result.imported).toBe(2); // joe + kit; jane collided
    expect(result.existingCollisions).toBe(1);

    const inserted = await db
      .select()
      .from(schema.guests)
      .where(eq(schema.guests.organisationId, ctx.orgId));
    expect(inserted).toHaveLength(3); // pre-seed + joe + kit

    // Tidy.
    await db.delete(schema.guests).where(eq(schema.guests.organisationId, ctx.orgId));
  });
});

describe("processImportJob — idempotency", () => {
  it("re-running a completed job is a no-op", async () => {
    const jobId = await seedJob();
    await processImportJob(jobId);
    const second = await processImportJob(jobId);
    expect(second.status).toBe("completed");
    // imported reflects the recorded count, not a new write.
    expect(second.imported).toBe(3);

    const inserted = await db
      .select()
      .from(schema.guests)
      .where(eq(schema.guests.organisationId, ctx.orgId));
    // No double-insert.
    expect(inserted).toHaveLength(3);

    await db.delete(schema.guests).where(eq(schema.guests.organisationId, ctx.orgId));
  });
});

describe("processImportJob — concurrency", () => {
  it("two concurrent calls on the same queued job do not double-insert", async () => {
    const jobId = await seedJob();
    // Fire two calls in parallel. The atomic claim
    // (UPDATE … WHERE status='queued' FOR UPDATE SKIP LOCKED) means
    // only one wins; the other sees the row as 'importing' (or
    // 'completed', if the winner is fast), the WHERE filters it
    // out, and the call returns a terminal-state no-op.
    await Promise.all([processImportJob(jobId), processImportJob(jobId)]);

    // The DB invariant — exactly 3 guests, regardless of which call
    // won the claim.
    const inserted = await db
      .select()
      .from(schema.guests)
      .where(eq(schema.guests.organisationId, ctx.orgId));
    expect(inserted).toHaveLength(3);

    // Job ends in 'completed' state.
    const [job] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, jobId));
    expect(job?.status).toBe("completed");
    expect(job?.rowCountImported).toBe(3);

    await db.delete(schema.guests).where(eq(schema.guests.organisationId, ctx.orgId));
  });
});

describe("processImportJob — failure path", () => {
  it("captures + sanitises the error when the CSV cannot be decrypted", async () => {
    // Insert a job whose cipher was encrypted under a different
    // org's DEK — decryptPii will throw with a tag-mismatch error.
    const [otherOrg] = await db
      .insert(schema.organisations)
      .values({ name: `Imp-Run-other ${run}`, slug: `imp-run-other-${run}` })
      .returning({ id: schema.organisations.id });
    if (!otherOrg) throw new Error("org insert returned no row");
    const wrongOrgCipher = await encryptPii(
      otherOrg.id,
      "won't decrypt under ctx.orgId" as Plaintext,
    );

    const [job] = await db
      .insert(schema.importJobs)
      .values({
        organisationId: ctx.orgId,
        source: "generic-csv",
        filename: "broken.csv",
        status: "queued",
        sourceCsvCipher: wrongOrgCipher,
        sourceSizeBytes: 12,
        columnMap: COLUMN_MAP,
      })
      .returning({ id: schema.importJobs.id });
    if (!job) throw new Error("import_jobs insert returned no row");

    const result = await processImportJob(job.id);
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error?.length).toBeGreaterThan(0);
    expect(result.error?.length).toBeLessThanOrEqual(480);

    const [row] = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.error).not.toBeNull();

    // Cleanup.
    await db.delete(schema.organisations).where(eq(schema.organisations.id, otherOrg.id));
  });
});
