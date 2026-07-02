import { Skeleton } from "@/components/ui";

// Streamed while the insights queries run — several independent report
// aggregations (lead time, no-show trend, channel performance, guest
// engagement) that each touch the bookings history, so the wait is
// real. Header + range nav, a comparison band, then the card grid.

function CardSkeleton() {
  return (
    <div className="rounded-card border-hairline shadow-panel flex flex-col gap-4 border bg-white p-5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-36" /> {/* card title */}
        <Skeleton className="h-3 w-14" /> {/* aside metric */}
      </div>
      <Skeleton className="rounded-input h-40 w-full" /> {/* chart area */}
    </div>
  );
}

export default function InsightsLoading() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true" aria-label="Loading insights">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-6 w-40" /> {/* "Insights" */}
          <Skeleton className="h-3 w-52" /> {/* range subtitle */}
        </div>
        <Skeleton className="rounded-input h-9 w-48" /> {/* date range nav */}
      </header>

      <div className="rounded-card border-hairline grid grid-cols-2 gap-px overflow-hidden border md:grid-cols-4">
        {[0, 1, 2, 3].map((cell) => (
          <div key={cell} className="flex flex-col gap-2 bg-white p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((card) => (
          <CardSkeleton key={card} />
        ))}
      </div>
    </section>
  );
}
