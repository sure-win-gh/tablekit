"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button, IconButton, Input } from "@/components/ui";

// Day navigator — prev / today / next + native date input. Mirrors the
// timeline's TimelineDateNav; `today` is the venue-local today (computed
// server-side) so the Today button lands on the operator's calendar day.
export function ServiceSummaryDateNav({
  venueId,
  date,
  today,
}: {
  venueId: string;
  date: string;
  today: string;
}) {
  const router = useRouter();
  const setDate = (d: string) =>
    router.push(`/dashboard/venues/${venueId}/service-summary?date=${d}`);
  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };
  return (
    <div className="flex items-center gap-1.5">
      <IconButton aria-label="Previous day" size="sm" onClick={() => shift(-1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
      <Button variant="secondary" size="sm" onClick={() => setDate(today)} disabled={date === today}>
        Today
      </Button>
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        size="sm"
        className="w-auto"
      />
      <IconButton aria-label="Next day" size="sm" onClick={() => shift(1)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}
