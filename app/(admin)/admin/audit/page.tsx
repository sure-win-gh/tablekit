import { Download } from "lucide-react";
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
        <h1 className="text-ink text-2xl font-bold tracking-tight">Audit feed</h1>
        <p className="text-ash text-sm">
          Last 200 events platform-wide from public.audit_log. Filter by action prefix or drill into
          a single organisation by id.
        </p>
      </header>

      <form action="/admin/audit" method="get" className="flex items-end gap-2">
        <label className="text-ash flex flex-col gap-1 text-xs">
          Action
          <select
            name="prefix"
            defaultValue={prefix}
            className="rounded-card border-hairline text-ink border bg-white px-2 py-1.5 text-xs"
          >
            {AUDIT_PREFIX_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-ash flex flex-col gap-1 text-xs">
          Organisation id
          <Input type="text" name="org_id" defaultValue={org_id} placeholder="uuid" size="sm" />
        </label>
        <button
          type="submit"
          className="rounded-pill bg-ink inline-flex items-center px-3 py-1.5 text-xs font-semibold text-white"
        >
          Apply
        </button>
        {prefix || org_id ? (
          <Link href="/admin/audit" className="text-ash text-xs underline-offset-2 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      <Card padding="lg">
        <CardHeader>
          <CardTitle>{rows.length} events</CardTitle>
          <a
            href={`/admin/export/audit${buildExportQs({ prefix, org_id })}`}
            className="rounded-pill border-hairline text-ink hover:border-ink inline-flex items-center gap-1.5 border bg-white px-3 py-1 text-xs font-semibold transition"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            CSV
          </a>
        </CardHeader>
        <CardBody>
          {rows.length === 0 ? (
            <p className="text-ash text-xs">No matching events.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-ash text-left">
                  <tr>
                    <th className="py-1 font-medium">When</th>
                    <th className="py-1 font-medium">Action</th>
                    <th className="py-1 font-medium">Organisation</th>
                    <th className="py-1 font-medium">Actor</th>
                    <th className="py-1 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody className="divide-hairline divide-y">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="text-ash py-1.5 tabular-nums">
                        {row.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                      </td>
                      <td className="text-ink py-1.5 font-medium">{row.action}</td>
                      <td className="py-1.5">
                        <Link
                          href={`/admin/venues/${row.organisationId}`}
                          className="text-ink underline-offset-2 hover:underline"
                        >
                          {row.organisationName ?? row.organisationId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="text-ash py-1.5">{row.actorEmail ?? "—"}</td>
                      <td className="text-ash py-1.5">
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

function buildExportQs(params: { prefix: string; org_id: string }): string {
  const parts: string[] = [];
  if (params.prefix) parts.push(`prefix=${encodeURIComponent(params.prefix)}`);
  if (params.org_id) parts.push(`org_id=${encodeURIComponent(params.org_id)}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}
