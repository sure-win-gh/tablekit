import Link from "next/link";

import { requirePlatformAdmin } from "@/lib/server/admin/auth";

// Tablekit-staff admin chrome. Distinct from operator dashboard:
// rose-coloured ADMIN pill so this surface can never be mistaken for
// a customer-facing view. Every (admin) page also calls
// requirePlatformAdmin() in its server component — proxy.ts is
// the first line of defence; this layout is the second.

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePlatformAdmin();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-hairline bg-white px-6 py-3">
        <div className="flex items-center gap-4">
          <span className="rounded-full bg-rose px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white">
            Admin
          </span>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="font-medium text-ink hover:underline">
              Overview
            </Link>
            <Link href="/admin/venues" className="font-medium text-ink hover:underline">
              Venues
            </Link>
            <Link href="/admin/financials" className="font-medium text-ink hover:underline">
              Financials
            </Link>
            <Link href="/admin/operations" className="font-medium text-ink hover:underline">
              Operations
            </Link>
            <Link href="/admin/feature-adoption" className="font-medium text-ink hover:underline">
              Adoption
            </Link>
          </nav>
        </div>
        <div className="text-xs text-ash">{session.email}</div>
      </header>
      <main className="flex flex-1 flex-col p-6">{children}</main>
    </div>
  );
}
