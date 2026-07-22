// Shared test-harness retry for Supabase Auth's intermittent 403 bad_jwt.
//
// Supabase Auth rejects roughly 7% of admin requests with
//   403 {"code":"bad_jwt"} / {"error_code":"bad_jwt"}
//   "invalid JWT: ... unrecognized JWT kid <nil> for algorithm ES256"
// using a key that serves every other request in the same run. Reproduced
// with plain curl against two separate projects — including a freshly created
// one — both serially and concurrently, so it is a platform-side flake rather
// than our credential. The rejected request never reaches the handler, so
// nothing is created and retrying is safe.
//
// Our suites seed users in beforeAll/beforeEach, so ~100 admin calls per CI
// run reliably lost a handful and failed whole suites on a hook error.
//
// Deliberately narrow: only 403 + bad_jwt is retried. A genuinely wrong key
// still fails on the first attempt, loudly, instead of stalling through five.
// Test harness only — the app's Supabase client is untouched, and the e2e
// dev server has never produced this error in CI.

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 100;

let installed = false;

async function isBadJwt(response: Response): Promise<boolean> {
  try {
    // Read a clone so the caller still gets an unconsumed body. GoTrue reports
    // this two ways depending on the endpoint — `error_code` over the wire,
    // `code` as surfaced through the client — so match either.
    const body = (await response.clone().json()) as {
      code?: unknown;
      error_code?: unknown;
    };
    return body.code === "bad_jwt" || body.error_code === "bad_jwt";
  } catch {
    return false; // Non-JSON 403 — not ours to retry.
  }
}

/**
 * Wrap global fetch so Supabase Auth's transient bad_jwt rejections are
 * retried. Idempotent: safe to call from several entry points.
 */
export function installBadJwtRetry(): void {
  if (installed) return;
  installed = true;

  const baseFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const response = await baseFetch(input, init);
      if (response.status !== 403 || attempt >= MAX_ATTEMPTS) return response;
      if (!(await isBadJwt(response))) return response;

      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  };
}
