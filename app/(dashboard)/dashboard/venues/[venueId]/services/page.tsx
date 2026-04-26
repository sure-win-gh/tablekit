import { asc, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { services } from "@/lib/db/schema";

import { NewServiceForm, ServiceRow } from "./forms";

export const metadata = {
  title: "Services · TableKit",
};

// Schedule jsonb shape — the service action writes and reads this
// exact structure. Declared here so the RSC can narrow safely.
type Schedule = {
  days: string[];
  start: string;
  end: string;
};

export default async function ServicesPage({ params }: { params: Promise<{ venueId: string }> }) {
  await requireRole("host");
  const { venueId } = await params;

  const rows = await withUser(async (db) => {
    return db
      .select({
        id: services.id,
        name: services.name,
        schedule: services.schedule,
        turnMinutes: services.turnMinutes,
      })
      .from(services)
      .where(eq(services.venueId, venueId))
      .orderBy(asc(services.name));
  });

  return (
    <section className="flex flex-col gap-6">
      <div>
        {rows.length === 0 ? (
          <p className="text-sm text-ash">
            No services yet. A service is a named window of time (like Lunch or Dinner) with a turn
            length — bookings pick a service at check-in.
          </p>
        ) : (
          rows.map((s) => {
            const sched = s.schedule as Schedule;
            return (
              <ServiceRow
                key={s.id}
                serviceId={s.id}
                name={s.name}
                days={sched.days ?? []}
                start={sched.start ?? "18:00"}
                end={sched.end ?? "22:00"}
                turnMinutes={s.turnMinutes}
              />
            );
          })
        )}
      </div>

      <NewServiceForm venueId={venueId} />
    </section>
  );
}
