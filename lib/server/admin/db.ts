// service_role Drizzle client — BYPASSES RLS.
//
// Import this ONLY from modules under lib/server/admin/*. The
// code-reviewer subagent (.claude/agents/code-reviewer.md) is
// configured to flag any import of this path from elsewhere. See
// docs/playbooks/security.md §Cross-tenant bugs.
//
// Lands for real with the auth spec; until then, calling adminDb()
// throws so no domain code can silently fall back to service_role.

export function adminDb(): never {
  throw new Error(
    "lib/server/admin/db.ts: service_role Drizzle client not yet wired — lands with the auth spec. " +
      "See docs/playbooks/security.md §Cross-tenant bugs before using this.",
  );
}
