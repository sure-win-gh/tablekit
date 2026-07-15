// Application-layer cross-tenant test for GET /api/v1/guests.
//
// /api/v1 enforces org ownership in the application layer (the withApiAuth
// wrapper resolves the bearer key to an org id; the list query filters on it)
// rather than via RLS, so the audit asked for a spot-check that a key in org A
// cannot see org B's guests. RLS-layer isolation is covered separately by
// tests/integration/rls-guests.test.ts; this proves the public-API path.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as GetList } from "@/app/api/v1/guests/route";
import { GET as GetOne } from "@/app/api/v1/guests/[id]/route";
import { issueApiKey } from "@/lib/api-keys/issue";
import * as schema from "@/lib/db/schema";
import { encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = {
  orgAId: string;
  orgBId: string;
  guestAId: string;
  guestBId: string;
  keyA: string;
  keyB: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `API-G-A ${run}`, slug: `api-g-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `API-G-B ${run}`, slug: `api-g-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });

  const mkGuest = async (orgId: string, tag: string) => {
    await encryptPii(orgId, "" as Plaintext); // warm the DEK
    const [lastNameCipher, emailCipher] = await Promise.all([
      encryptPii(orgId, "Test" as Plaintext),
      encryptPii(orgId, `${tag}@example.com` as Plaintext),
    ]);
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "Test",
        lastNameCipher,
        emailCipher,
        emailHash: `h-${run}-${tag}`,
      })
      .returning({ id: schema.guests.id });
    return g!.id;
  };
  const guestAId = await mkGuest(orgA!.id, "a");
  const guestBId = await mkGuest(orgB!.id, "b");

  const issueA = await issueApiKey({
    organisationId: orgA!.id,
    label: "test-A",
    createdByUserId: null as unknown as string,
  });
  const issueB = await issueApiKey({
    organisationId: orgB!.id,
    label: "test-B",
    createdByUserId: null as unknown as string,
  });

  ctx = {
    orgAId: orgA!.id,
    orgBId: orgB!.id,
    guestAId,
    guestBId,
    keyA: issueA.plaintext,
    keyB: issueB.plaintext,
  };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

function listReq(auth?: string): Request {
  return new Request("http://localhost:3000/api/v1/guests", {
    method: "GET",
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
}

describe("GET /api/v1/guests — auth + cross-org scoping", () => {
  it("401 with no Authorization header", async () => {
    const res = await GetList(listReq() as never);
    expect(res.status).toBe(401);
  });

  it("key in org A sees org A's guest, never org B's", async () => {
    const res = await GetList(listReq(ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ctx.guestAId);
    expect(ids).not.toContain(ctx.guestBId);
  });

  it("400s on a non-UUID guest id", async () => {
    const res = await GetOne(
      new Request("http://localhost:3000/api/v1/guests/not-a-uuid", {
        method: "GET",
        headers: { authorization: `Bearer ${ctx.keyA}` },
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("key in org B sees org B's guest, never org A's", async () => {
    const res = await GetList(listReq(ctx.keyB) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ctx.guestBId);
    expect(ids).not.toContain(ctx.guestAId);
  });
});
