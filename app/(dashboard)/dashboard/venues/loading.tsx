import { Skeleton } from "@/components/ui";

// Streamed while the org's venue list loads. This route renders its
// own page chrome (not the per-venue layout), so the skeleton carries
// the same <main> wrapper, header, and row list as page.tsx.

export default function VenuesLoading() {
  return (
    <main className="flex flex-1 flex-col px-8 py-6" aria-busy="true" aria-label="Loading venues">
      <header className="border-hairline flex flex-wrap items-baseline justify-between gap-3 border-b pb-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-32" /> {/* "Venues" */}
          <Skeleton className="h-4 w-64" /> {/* count line */}
        </div>
        <Skeleton className="rounded-input h-10 w-32" /> {/* new venue */}
      </header>

      <ul className="mt-6 flex flex-col gap-2">
        {[0, 1, 2, 3].map((row) => (
          <li
            key={row}
            className="rounded-card border-hairline flex items-center justify-between border bg-white px-4 py-3"
          >
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" /> {/* venue name */}
              <Skeleton className="h-3 w-28" /> {/* type · timezone */}
            </div>
            <Skeleton className="h-4 w-4 rounded" /> {/* arrow */}
          </li>
        ))}
      </ul>
    </main>
  );
}
