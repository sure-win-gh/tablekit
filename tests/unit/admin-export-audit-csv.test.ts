import { describe, expect, it } from "vitest";

import { toCsv } from "@/lib/server/admin/dashboard/csv";
import type { AuditFeedRow } from "@/lib/server/admin/dashboard/metrics/audit-feed";

const FIXTURE: AuditFeedRow = {
  id: "00000000-0000-0000-0000-000000000099",
  organisationId: "00000000-0000-0000-0000-000000000001",
  organisationName: "Test Cafe",
  actorUserId: "00000000-0000-0000-0000-000000000002",
  actorEmail: "owner@example.com",
  action: "stripe.intent.succeeded",
  targetType: "payment",
  targetId: "pi_test_123",
  metadata: { intent_id: "pi_test_123", amount_minor: 2000 },
  createdAt: new Date("2026-04-27T12:00:00Z"),
};

const COLUMNS = [
  { header: "created_at", value: (r: AuditFeedRow) => r.createdAt },
  { header: "action", value: (r: AuditFeedRow) => r.action },
  { header: "organisation_id", value: (r: AuditFeedRow) => r.organisationId },
  { header: "organisation_name", value: (r: AuditFeedRow) => r.organisationName },
  { header: "actor_user_id", value: (r: AuditFeedRow) => r.actorUserId },
  { header: "actor_email", value: (r: AuditFeedRow) => r.actorEmail },
  { header: "target_type", value: (r: AuditFeedRow) => r.targetType },
  { header: "target_id", value: (r: AuditFeedRow) => r.targetId },
  { header: "metadata", value: (r: AuditFeedRow) => JSON.stringify(r.metadata) },
];

describe("admin audit CSV export shape", () => {
  it("emits headers + the fixture row in column order", () => {
    const csv = toCsv([FIXTURE], COLUMNS);
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const lines = csv.slice(1).split("\r\n").filter(Boolean);
    const [headerLine, dataLine] = lines;
    expect(headerLine).toBe(
      "created_at,action,organisation_id,organisation_name,actor_user_id,actor_email,target_type,target_id,metadata",
    );
    expect(dataLine).toContain("2026-04-27T12:00:00.000Z");
    expect(dataLine).toContain("stripe.intent.succeeded");
    // Metadata JSON contains a comma → must be quoted in the CSV cell.
    expect(dataLine).toMatch(/"\{""intent_id""/);
  });
});
