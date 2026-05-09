// Unit tests for the v1 auth wrapper's rate-limit + auth + error
// behaviour. We mock both `lib/api-keys/auth` (so no DB) and
// `lib/public/rate-limit` (so we can control the limiter without
// running Upstash) — the wrapper itself becomes a small pure
// state-machine to test.

import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

type LoadResult = {
  withApiAuth: typeof import("@/lib/api/v1/auth-wrapper").withApiAuth;
  resolveMock: Mock;
  rateLimitMock: Mock;
};

async function loadWrapper(): Promise<LoadResult> {
  const resolveMock = vi.fn();
  const rateLimitMock = vi.fn();
  vi.doMock("@/lib/api-keys/auth", () => ({ resolveBearerToken: resolveMock }));
  vi.doMock("@/lib/public/rate-limit", () => ({ rateLimit: rateLimitMock }));
  const mod = await import("@/lib/api/v1/auth-wrapper");
  return { withApiAuth: mod.withApiAuth, resolveMock, rateLimitMock };
}

function makeReq(auth?: string): import("next/server").NextRequest {
  return new Request("http://localhost/v1/test", {
    method: "GET",
    ...(auth ? { headers: { authorization: `Bearer ${auth}` } } : {}),
  }) as unknown as import("next/server").NextRequest;
}

describe("withApiAuth — auth", () => {
  it("returns 401 when resolve returns null", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue(null);
    const handler = withApiAuth(async () => new Response("ok"));
    const res = await handler(makeReq() as never);
    expect(res.status).toBe(401);
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});

describe("withApiAuth — rate limit", () => {
  it("returns 429 with Retry-After when over the budget", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue({ id: "k1", organisationId: "o1" });
    rateLimitMock.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 42 });

    const inner = vi.fn(async () => new Response("ok"));
    const handler = withApiAuth(inner);
    const res = await handler(makeReq("token") as never);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(inner).not.toHaveBeenCalled();
  });

  it("buckets on keyId (not orgId) so two keys in one org are independent", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue({ id: "key-A", organisationId: "shared-org" });
    rateLimitMock.mockResolvedValue({ ok: true, remaining: 599 });

    const handler = withApiAuth(async () => new Response("ok"));
    await handler(makeReq("token") as never);

    expect(rateLimitMock).toHaveBeenCalledOnce();
    const [bucket] = rateLimitMock.mock.calls[0]!;
    expect(bucket).toBe("apikey:key-A");
  });

  it("attaches x-ratelimit headers on success", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue({ id: "k1", organisationId: "o1" });
    rateLimitMock.mockResolvedValue({ ok: true, remaining: 412 });

    const handler = withApiAuth(async () => new Response("ok"));
    const res = await handler(makeReq("token") as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("600");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("412");
  });

  it("falls back to RATE_WINDOW_SEC when the limiter omits retryAfterSec", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue({ id: "k1", organisationId: "o1" });
    rateLimitMock.mockResolvedValue({ ok: false, remaining: 0 });

    const handler = withApiAuth(async () => new Response("ok"));
    const res = await handler(makeReq("token") as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("withApiAuth — error mapping", () => {
  it("returns 500 internal_error when the handler throws", async () => {
    const { withApiAuth, resolveMock, rateLimitMock } = await loadWrapper();
    resolveMock.mockResolvedValue({ id: "k1", organisationId: "o1" });
    rateLimitMock.mockResolvedValue({ ok: true, remaining: 599 });

    const handler = withApiAuth(async () => {
      throw new Error("boom");
    });
    const res = await handler(makeReq("token") as never);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    // Crucially: the thrown message ("boom") is NOT in the response.
    expect(body.error.message).not.toContain("boom");
  });
});
