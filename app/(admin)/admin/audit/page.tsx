import Link from "next/link";

import { Card, CardBody, CardHeader, CardTitle, Input } from "@/components/ui";
import { requirePlatformAdmin } from "@/lib/server/admin/auth";
import { adminDb } from "@/lib/server/admin/db";
import {
  AUDIT_PREFIX_OPTIONS,
  getAuditFeed,
} from "@/lib/server/admin/dashboard/metrics/audit-feed";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ prefix?: string; org_id?: string }>;
}) {
  await requirePlatformAdmin();
  const { prefix = "", org_id = "" } = await searchParams;

  const rows = await getAuditFeed(adminDb(), {
    actionPrefix: prefix || undefined,
    orgId: org_id || undefined,
    limit: 200,
  });

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Audit feed</h1>
        <p className="text-sm text-ash">
          Last 200 events platform-wide from public.audit_log. Filter by action prefix or
          drill into a single organisation by id.
        </p>
      </header>

      <form action="/admin/audit" method="get" className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ash">
          Action
          <select
            name="prefix"
            defaultValue={prefix}
            className="rounded-card border border-hairline bg-white px-2 py-1.5 text-xs text-ink"
          >
            {AUDIT_PREFIX_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ash">
          Organisation id
          <Input type="text" name="org_id" defaultValue={org_id} placeholder="uuid" size="sm" />
        </label>
        <button
          type="submit"
          className="inline-flex items-center rounded-pill bg-ink px-3 py-1.5 text-xs font-semibold text-white"
        >
          Apply
        </button>
        {prefix || org_id ? (
          <Link href="/admin/audit" className="text-xs text-ash underline-offset-2 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>{rows.length} events</CardTitle>
        </CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <p className="text-xs text-ash">No matching events.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-ash">
                  <tr>
                    <th className="py-1 font-medium">When</th>
                    <th className="py-1 font-medium">Action</th>
                    <th className="py-1 font-medium">Organisation</th>
                    <th className="py-1 font-medium">Actor</th>
                    <th className="py-1 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-1.5 tabular-nums text-ash">
                        {row.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="py-1.5 font-medium text-ink">{row.action}</td>
                      <td className="py-1.5">
                        <Link
                          href={`/admin/venues/${row.organisationId}`}
                          className="text-ink underline-offset-2 hover:underline"
                        >
                          {row.organisationName ?? row.organisationId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-1.5 text-ash">{row.actorEmail ?? "—"}</td>
                      <td className="py-1.5 text-ash">
                        {row.targetType ? (
                          <span>
                            {row.targetType}
                            {row.targetId ? `: ${row.targetId.slice(0, 8)}…` : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
