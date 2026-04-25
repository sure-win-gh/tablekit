// hCaptcha server-side verification.
//
// Called from the public API route before we ever call `createBooking`.
// If `HCAPTCHA_SECRET` is not set, we pass through — that's how local
// dev + CI run without needing a test key.

const VERIFY_URL = "https://api.hcaptcha.com/siteverify";

export type CaptchaResult =
  | { ok: true }
  | { ok: false; reason: "missing-token" | "invalid" | "verifier-down" };

export async function verifyCaptcha(
  token: string | undefined,
  ip?: string,
): Promise<CaptchaResult> {
  const secret = process.env["HCAPTCHA_SECRET"];
  // Permissive fallback — no secret configured.
  if (!secret) return { ok: true };

  if (!token || token.length === 0) return { ok: false, reason: "missing-token" };

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, reason: "verifier-down" };
    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    return data.success ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "verifier-down" };
  }
}

// Exposed so the UI can decide whether to render the widget at all.
export function captchaEnabled(): boolean {
  return Boolean(process.env["HCAPTCHA_SECRET"]);
}

// Short reference string from a UUID — for booking confirmations.
// "4e2d1f8a-..." → "4E2D-1F8A". Not unique enough for lookups; use
// the full UUID internally.
export function bookingReference(bookingId: string): string {
  const hex = bookingId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}
