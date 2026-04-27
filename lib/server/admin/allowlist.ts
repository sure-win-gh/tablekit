// Pure ADMIN_EMAILS parser. Shared by lib/server/admin/auth.ts (server
// components / actions) and proxy.ts (edge runtime), so it must
// NOT import server-only or any Node-only API.
//
// ADMIN_EMAILS is comma- or whitespace-separated; entries are trimmed
// and lowercased before comparison. Re-parsed on every call so a
// hot-reload / redeploy picks up changes without a process restart.

export function platformAdminAllowlist(): Set<string> {
  const raw = process.env["ADMIN_EMAILS"] ?? "";
  const entries = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(entries);
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allow = platformAdminAllowlist();
  if (allow.size === 0) return false;
  return allow.has(email.trim().toLowerCase());
}
