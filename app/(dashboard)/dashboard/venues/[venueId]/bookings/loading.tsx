import { Skeleton } from "@/components/ui";

// Streamed while the per-day bookings query (plus the inline no-show
// and messaging sweeps) runs. Mirrors page.tsx: header + filter bar,
// then the list/day-overview two-column grid. The venue chrome
// (breadcrumb + venue name) is owned by the parent layout and stays
// put — only this region swaps.

function RowSkeleton() {
  return (
    <li className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-12" /> {/* time */}
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" /> {/* guest name */}
          <Skeleton className="h-3 w-20" /> {/* party / table */}
        </div>
      </div>
      <Skeleton className="rounded-pill h-6 w-16" /> {/* status pill */}
    </li>
  );
}

export default function BookingsLoading() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true" aria-label="Loading bookings">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-6 w-56" /> {/* long date */}
          <Skeleton className="h-3 w-24" /> {/* count line */}
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="rounded-input h-9 w-36" /> {/* date nav */}
          <Skeleton className="rounded-input h-9 w-32" /> {/* new booking */}
        </div>
      </header>
      <Skeleton className="rounded-input h-10 w-full" /> {/* filter bar */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="flex flex-col gap-6">
          {[0, 1].map((group) => (
            <div key={group}>
              <Skeleton className="h-4 w-24" /> {/* service heading */}
              <ul className="divide-hairline rounded-card border-hairline mt-2 divide-y border bg-white">
                {[0, 1, 2].map((row) => (
                  <RowSkeleton key={row} />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <aside className="hidden lg:sticky lg:top-4 lg:block">
          <div className="rounded-card border-hairline shadow-panel flex flex-col gap-4 border bg-white p-4">
            <Skeleton className="h-4 w-28" /> {/* overview heading */}
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((line) => (
                <div key={line} className="flex items-center justify-between">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-8" />
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
