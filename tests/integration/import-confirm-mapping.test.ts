// Integration test for the confirmMapping action's data path.
//
// We can't easily exercise the server action through requireRole
// without a Supabase Auth session, so this test drives the SQL
// transition directly + then runs the runner — same effect as the
// action minus the auth wrap. The auth wrap is exercised manually in
// dev.

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { processImportJob } from "@/lib/import/runner/writer";
import { type Plaintext, encryptPii } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = { orgId: string };
let ctx: Ctx;

const SAMPLE_CSV =
  "First Name,Last Name,Email,Phone\n" +
  "Jane,Doe,jane@example.com,07700900111\n" +
  "Joe,Bloggs,joe@example.com,\n";

const COLUMN_MAP = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  phone: "Phone",
};

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Conf-Map ${run}`, slug: `conf-map-${run}` })
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

async function seedPreviewReady(): Promise<string> {
  const cipher = await encryptPii(ctx.orgId, SAMPLE_CSV as Plaintext);
  const [job] = await db
    .insert(schema.importJobs)
    .values({
      organisationId: ctx.orgId,
      source: "generic-csv",
      filename: "guests.csv",
      status: "preview_ready",
      sourceCsvCipher: cipher,
      sourceSizeBytes: SAMPLE_CSV.length,
      columnMap: {},
    })
    .returning({ id: schema.importJobs.id });
  if (!job) throw new Error("import_jobs insert returned no row");
  return job.id;
}

// Mirror of the action's CAS — the action also calls processImportJob
// after the transition, but tests cover that separately.
async function confirmMappingDataPath(jobId: string, columnMap: Record<string, string>) {
  return db
    .update(schema.importJobs)
    .set({ status: "queued", columnMap })
    .where(
      and(
        eq(schema.importJobs.id, jobId),
        eq(schema.importJobs.organisationId, ctx.orgId),
        eq(schema.importJobs.status, "preview_ready"),
      ),
    )
    .returning({ id: schema.importJobs.id });
}

describe("confirmMapping — happy path", () => {
  it("transitions preview_ready → queued with the chosen column_map, then the runner imports", async () => {
    const jobId = await seedPreviewReady();
    const updated = await confirmMappingDataPath(jobId, COLUMN_MAP);
    expect(updated).toHaveLength(1);

    // Re-read to verify the transition.
    const [afterCas] = await db
      .select()
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, jobId));
    expect(afterCas?.status).toBe("queued");
    expect(afterCas?.columnMap).toEqual(COLUMN_MAP);

    // Runner picks up + processes the now-queued job.
    const result = await processImportJob(jobId);
    expect(result.status).toBe("completed");
    expect(result.imported).toBe(2);

    const guests = await db
      .select()
      .from(schema.guests)
      .where(eq(schema.guests.organisationId, ctx.orgId));
    expect(guests).toHaveLength(2);

    await db.delete(schema.guests).where(eq(schema.guests.organisationId, ctx.orgId));
  });
});

describe("confirmMapping — CAS guards", () => {
  it("refuses to transition a job that's already running", async () => {
    const jobId = await seedPreviewReady();
    // Move it to 'queued' first (simulates a prior confirmMapping).
    await db
      .update(schema.importJobs)
      .set({ status: "queued" })
      .where(eq(schema.importJobs.id, jobId));
    // Second confirmMapping must NOT re-transition.
    const updated = await confirmMappingDataPath(jobId, COLUMN_MAP);
    expect(updated).toHaveLength(0);
  });

  it("refuses to transition a job from another org", async () => {
    const jobId = await seedPreviewReady();
    // Pretend the caller's orgId is wrong.
    const updated = await db
      .update(schema.importJobs)
      .set({ status: "queued", columnMap: COLUMN_MAP })
      .where(
        and(
          eq(schema.importJobs.id, jobId),
          eq(schema.importJobs.organisationId, "00000000-0000-0000-0000-000000000000"),
          eq(schema.importJobs.status, "preview_ready"),
        ),
      )
      .returning({ id: schema.importJobs.id });
    expect(updated).toHaveLength(0);

    // The job's status remains preview_ready.
    const [row] = await db
      .select({ status: schema.importJobs.status })
      .from(schema.importJobs)
      .where(eq(schema.importJobs.id, jobId));
    expect(row?.status).toBe("preview_ready");
  });
});
