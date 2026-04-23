// Pure role-comparison helpers, split out so they can be unit-tested
// without any DB / Supabase / cookies plumbing. requireRole lives in
// ./require-role.ts and uses these.

export type OrgRole = "owner" | "manager" | "host";

export const roleLevel: Record<OrgRole, number> = {
  host: 1,
  manager: 2,
  owner: 3,
};

export function hasRole(userRole: OrgRole, min: OrgRole): boolean {
  return roleLevel[userRole] >= roleLevel[min];
}
