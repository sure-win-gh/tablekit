import { Skeleton } from "@/components/ui";

// Streamed while the floor-plan query (areas + tables + the day's
// bookings + per-table state derivation) runs. Header mirrors page.tsx;
// the canvas is a single large surface with a scattering of table
// blocks so the swap to the live floor reads as a fill, not a jump.

const TABLE_BLOCKS = [
  "left-[6%] top-[12%] h-16 w-16 rounded-card",
  "left-[26%] top-[10%] h-16 w-24 rounded-card",
  "left-[52%] top-[14%] h-16 w-16 rounded-full",
  "left-[74%] top-[10%] h-20 w-20 rounded-card",
  "left-[10%] top-[44%] h-16 w-24 rounded-card",
  "left-[40%] top-[46%] h-16 w-16 rounded-full",
  "left-[66%] top-[44%] h-16 w-16 rounded-card",
  "left-[14%] top-[74%] h-16 w-16 rounded-full",
  "left-[38%] top-[76%] h-16 w-24 rounded-card",
  "left-[68%] top-[74%] h-20 w-20 rounded-card",
];

export default function FloorPlanLoading() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true" aria-label="Loading floor plan">
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-28" /> {/* "Floor plan" */}
          <Skeleton className="h-3 w-44" /> {/* table/area count */}
        </div>
      </header>

      <div className="rounded-card border-hairline relative h-[28rem] w-full overflow-hidden border bg-white">
        {TABLE_BLOCKS.map((pos, i) => (
          <Skeleton key={i} className={`absolute ${pos}`} />
        ))}
      </div>
    </section>
  );
}
