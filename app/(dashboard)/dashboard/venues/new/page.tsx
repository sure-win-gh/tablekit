import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";

import { NewVenueForm } from "./form";

export const metadata = {
  title: "New venue · TableKit",
};

export default async function NewVenuePage() {
  // Manager or higher. requireRole redirects otherwise.
  await requireRole("manager");

  return (
    <main className="flex flex-1 flex-col py-6 pr-8">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard/venues" className="hover:text-ink">
          Venues
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="text-ink">New</span>
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Create a venue</h1>
        <p className="mt-1 text-sm text-ash">
          We&apos;ll seed it with a starter floor plan and service schedule based on the type you
          pick. Everything&apos;s editable afterwards.
        </p>
      </header>

      <div className="mt-6 w-full max-w-xl">
        <NewVenueForm />
      </div>
    </main>
  );
}
