// Unit tests for the Google OAuth state token. The state token is the
// CSRF + binding mechanism between /start and /callback — if forgery
// or tampering passes, an attacker can complete an OAuth flow against
// a victim's account.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalMaster = process.env["TABLEKIT_MASTER_KEY"];

beforeAll(() => {
  process.env["TABLEKIT_MASTER_KEY"] = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
});
afterAll(() => {
  if (originalMaster === undefined) delete process.env["TABLEKIT_MASTER_KEY"];
  else process.env["TABLEKIT_MASTER_KEY"] = originalMaster;
});

const VENUE = "00000000-0000-0000-0000-000000000aaa";
const USER = "00000000-0000-0000-0000-000000000bbb";

describe("oauth state token", () => {
  it("sign + verify round-trip recovers the payload", async () => {
    const { signOAuthState, verifyOAuthState } = await import("@/lib/oauth/google");
    const token = signOAuthState({ venueId: VENUE, userId: USER });
    const r = verifyOAuthState(token);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.venueId).toBe(VENUE);
    expect(r.payload.userId).toBe(USER);
  });

  it("rejects tampered signatures as bad-sig", async () => {
    const { signOAuthState, verifyOAuthState } = await import("@/lib/oauth/google");
    const token = signOAuthState({ venueId: VENUE, userId: USER });
    const last = token.charAt(token.length - 1);
    const tampered = token.slice(0, -1) + (last === "f" ? "0" : "f");
    const r = verifyOAuthState(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-sig");
  });

  it("rejects states older than 10 minutes as expired", async () => {
    const { signOAuthState, verifyOAuthState } = await import("@/lib/oauth/google");
    const oldIat = Math.floor(Date.now() / 1000) - 11 * 60;
    const token = signOAuthState({ venueId: VENUE, userId: USER, iat: oldIat });
    const r = verifyOAuthState(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects states with iat in the future as future", async () => {
    const { signOAuthState, verifyOAuthState } = await import("@/lib/oauth/google");
    const futureIat = Math.floor(Date.now() / 1000) + 60 * 60;
    const token = signOAuthState({ venueId: VENUE, userId: USER, iat: futureIat });
    const r = verifyOAuthState(token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("future");
  });

  it("rejects payloads without a signature as bad-format", async () => {
    const { verifyOAuthState } = await import("@/lib/oauth/google");
    const r = verifyOAuthState("notasignedtoken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-format");
  });
});
