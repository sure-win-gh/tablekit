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
    <main className="flex flex-1 flex-col p-6">
      <nav className="text-sm">
        <Link href="/dashboard/venues" className="text-neutral-500 hover:underline">
          Venues
        </Link>
        <span className="text-neutral-400"> / </span>
        <span className="text-neutral-900">New</span>
      </nav>

      <header className="mt-4 border-b border-neutral-200 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Create a venue</h1>
        <p className="mt-1 text-sm text-neutral-500">
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
