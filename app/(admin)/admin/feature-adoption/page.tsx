import { permanentRedirect } from "next/navigation";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";

// Feature adoption folded into the Growth page (2026-07 admin
// redesign). Kept as a redirect so old bookmarks survive. The auth
// gate stays so *every* (admin) server component enforces the
// allowlist invariant, redirects included.
export default async function AdminFeatureAdoptionRedirect() {
  await requirePlatformAdmin();
  permanentRedirect("/admin/growth");
}
