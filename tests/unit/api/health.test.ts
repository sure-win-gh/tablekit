// Unit tests for the /api/health readiness probe. The DB client is mocked so
// no real Postgres is touched; we assert the 200 body shape — in particular
// that it carries the build's commit SHA (the promote/rollback canary).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_SHA = process.env["VERCEL_GIT_COMMIT_SHA"];

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_SHA === undefined) delete process.env["VERCEL_GIT_COMMIT_SHA"];
  else process.env["VERCEL_GIT_COMMIT_SHA"] = ORIGINAL_SHA;
});

/** Load the route with the DB check succeeding (so we hit the 200 path). */
async function loadHealthy() {
  vi.doMock("@/lib/db/client", () => ({
    anonymous: async (fn: (db: { execute: (q: unknown) => Promise<void> }) => Promise<void>) =>
      fn({ execute: async () => {} }),
  }));
  vi.doMock("@/lib/observability/capture", () => ({ captureException: vi.fn() }));
  vi.doMock("@/lib/observability/slack", () => ({ sendSlackAlert: vi.fn() }));
  return import("@/app/api/health/route");
}

describe("GET /api/health — 200 body", () => {
  it("includes the build commit SHA from VERCEL_GIT_COMMIT_SHA", async () => {
    process.env["VERCEL_GIT_COMMIT_SHA"] = "abc1234def5678";
    const { GET } = await loadHealthy();
    const res = await GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; commit: string };
    expect(body.ok).toBe(true);
    expect(body.commit).toBe("abc1234def5678");
  });

  it('falls back to "unknown" when the SHA is not set', async () => {
    delete process.env["VERCEL_GIT_COMMIT_SHA"];
    const { GET } = await loadHealthy();
    const res = await GET();

    const body = (await res.json()) as { commit: string };
    expect(body).toHaveProperty("commit");
    expect(body.commit).toBe("unknown");
  });
});
