import { asc, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { areas, venueTables } from "@/lib/db/schema";

import { AreaHeader, NewAreaForm, NewTableForm, TableRow } from "./forms";

export const metadata = {
  title: "Floor plan · TableKit",
};

export default async function FloorPlanPage({ params }: { params: Promise<{ venueId: string }> }) {
  await requireRole("host");
  const { venueId } = await params;

  const { areaRows, tableRows } = await withUser(async (db) => {
    const a = await db
      .select({
        id: areas.id,
        name: areas.name,
        sort: areas.sort,
      })
      .from(areas)
      .where(eq(areas.venueId, venueId))
      .orderBy(asc(areas.sort), asc(areas.createdAt));

    const t = await db
      .select({
        id: venueTables.id,
        areaId: venueTables.areaId,
        label: venueTables.label,
        minCover: venueTables.minCover,
        maxCover: venueTables.maxCover,
        shape: venueTables.shape,
        position: venueTables.position,
      })
      .from(venueTables)
      .where(eq(venueTables.venueId, venueId))
      .orderBy(asc(venueTables.label));

    return { areaRows: a, tableRows: t };
  });

  const tablesByArea = new Map<string, typeof tableRows>();
  for (const t of tableRows) {
    const list = tablesByArea.get(t.areaId) ?? [];
    list.push(t);
    tablesByArea.set(t.areaId, list);
  }

  return (
    <section className="flex flex-col gap-6">
      {areaRows.length === 0 ? (
        <p className="text-sm text-ash">
          No areas yet. Add one below to start laying out tables.
        </p>
      ) : (
        areaRows.map((area) => {
          const tables = tablesByArea.get(area.id) ?? [];
          return (
            <div key={area.id} className="rounded-md border border-hairline">
              <div className="border-b border-hairline px-4 pt-4 pb-3">
                <AreaHeader areaId={area.id} name={area.name} />
              </div>
              <div className="px-4 py-2">
                {tables.length === 0 ? (
                  <p className="py-2 text-xs text-ash">No tables yet.</p>
                ) : (
                  tables.map((t) => {
                    const pos = t.position as { x: number; y: number; w: number; h: number };
                    return (
                      <TableRow
                        key={t.id}
                        tableId={t.id}
                        label={t.label}
                        minCover={t.minCover}
                        maxCover={t.maxCover}
                        shape={t.shape}
                        position={pos}
                      />
                    );
                  })
                )}
                <div className="mt-3">
                  <NewTableForm areaId={area.id} />
                </div>
              </div>
            </div>
          );
        })
      )}

      <NewAreaForm venueId={venueId} />
    </section>
  );
}
