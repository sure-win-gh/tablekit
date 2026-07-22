// Integration test setup: load .env.local so DATABASE_URL and the
// Supabase keys are available. Runs before every integration test
// file (configured via tests/integration/vitest.config.ts).

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

// Supabase Auth intermittently rejects a valid admin request with
// 403 bad_jwt ("unrecognized JWT kid <nil> for algorithm ES256"). Measured
// against two different projects, including a freshly created one: roughly
// 7% of createUser calls, serial or concurrent, with a key that serves every
// other request in the same run. It is a platform-side flake, not our
// credential — and the rejected request creates nothing, so retrying is safe.
//
// Every suite seeds users in beforeAll, so ~100 calls per run reliably lost a
// handful and failed whole suites on a hook error. A retry clears it on the
// next attempt (measured: 2/30 first attempts failed, 0/30 after retry).
//
// Scoped as tightly as possible: only 403 + error_code "bad_jwt" is retried,
// so a genuinely bad key still fails fast and loudly rather than stalling
// through five attempts.
const BAD_JWT_RETRIES = 4;
const baseFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const response = await baseFetch(input, init);
    if (response.status !== 403 || attempt >= BAD_JWT_RETRIES) return response;

    // Read from a clone so the caller still gets an unconsumed body. GoTrue
    // reports this two ways depending on the endpoint — {"error_code":"bad_jwt"}
    // and {"code":"bad_jwt"} — so check both rather than the one curl shows.
    let isBadJwt = false;
    try {
      const body = (await response.clone().json()) as {
        error_code?: unknown;
        code?: unknown;
      };
      isBadJwt = body.error_code === "bad_jwt" || body.code === "bad_jwt";
    } catch {
      isBadJwt = false; // Non-JSON 403 — not ours to retry.
    }
    if (!isBadJwt) return response;

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * 2 ** attempt));
  }
};
