// Unit test for the daily sending-domain verification sweep.
//
// Mocks adminDb's query chain + verifyDomain so the logic is
// deterministic. We're not testing the Resend wire format — that's
// the wrapper's job; here we just exercise the dispatch + DB
// branching.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock holders. Each test mutates these before running the
// sweep so the call counts + branch coverage are predictable.
const m = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    organisationId: string;
    venueId: string;
    resendDomainId: string;
  }>,
  verifyResults: new Map<string, unknown>(),
  updateCalls: [] as unknown[],
  deleteCalls: [] as string[],
  auditCalls: [] as unknown[],
}));

vi.mock("@/lib/server/admin/db", () => ({
  adminDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => m.rows,
        }),
      }),
    }),
    update: () => ({
      set: (patch: unknown) => ({
        where: () => {
          m.updateCalls.push(patch);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (clause: unknown) => {
        // We can't see the clause shape from outside Drizzle, so
        // tests check delete count via deleteCalls.length.
        m.deleteCalls.push(String(clause ?? ""));
        return Promise.resolve();
      },
    }),
  }),
}));

vi.mock("@/lib/email/sending-domains", () => ({
  verifyDomain: async (resendId: string) => {
    if (!m.verifyResults.has(resendId)) {
      throw new Error("simulated transient");
    }
    return m.verifyResults.get(resendId);
  },
}));

vi.mock("@/lib/server/admin/audit", () => ({
  audit: {
    log: async (input: unknown) => {
      m.auditCalls.push(input);
    },
  },
}));

import { sweepPendingSendingDomains } from "@/lib/email/verify-pending-domains";

beforeEach(() => {
  m.rows = [];
  m.verifyResults = new Map();
  m.updateCalls = [];
  m.deleteCalls = [];
  m.auditCalls = [];
});

describe("sweepPendingSendingDomains", () => {
  it("returns zeroes when there are no eligible rows", async () => {
    const r = await sweepPendingSendingDomains();
    expect(r).toEqual({ scanned: 0, verified: 0, unchanged: 0, errored: 0 });
  });

  it("flips status to verified + audits when Resend says verified", async () => {
    m.rows = [{ id: "r1", organisationId: "o1", venueId: "v1", resendDomainId: "rd1" }];
    m.verifyResults.set("rd1", {
      id: "rd1",
      name: "mail.jane.test",
      status: "verified",
      records: [],
    });

    const r = await sweepPendingSendingDomains();
    expect(r.scanned).toBe(1);
    expect(r.verified).toBe(1);
    expect(r.unchanged).toBe(0);
    expect(m.auditCalls).toHaveLength(1);
    expect(m.auditCalls[0]).toMatchObject({
      action: "enquiry.sending_domain.verified",
      targetType: "venue",
      targetId: "v1",
      metadata: { domain: "mail.jane.test", source: "cron" },
    });
  });

  it("keeps row pending without auditing when Resend still says pending", async () => {
    m.rows = [{ id: "r1", organisationId: "o1", venueId: "v1", resendDomainId: "rd1" }];
    m.verifyResults.set("rd1", {
      id: "rd1",
      name: "mail.jane.test",
      status: "pending",
      records: [],
    });

    const r = await sweepPendingSendingDomains();
    expect(r.verified).toBe(0);
    expect(r.unchanged).toBe(1);
    expect(m.auditCalls).toHaveLength(0);
  });

  it("deletes the local row when Resend returns null (domain gone)", async () => {
    m.rows = [{ id: "r1", organisationId: "o1", venueId: "v1", resendDomainId: "rd1" }];
    m.verifyResults.set("rd1", null);

    const r = await sweepPendingSendingDomains();
    expect(r.unchanged).toBe(1);
    expect(m.deleteCalls).toHaveLength(1);
  });

  it("counts errored rows and continues across the batch", async () => {
    m.rows = [
      { id: "r1", organisationId: "o1", venueId: "v1", resendDomainId: "rd-good" },
      { id: "r2", organisationId: "o1", venueId: "v2", resendDomainId: "rd-bad" },
      { id: "r3", organisationId: "o1", venueId: "v3", resendDomainId: "rd-pending" },
    ];
    m.verifyResults.set("rd-good", {
      id: "rd-good",
      name: "a.test",
      status: "verified",
      records: [],
    });
    // rd-bad omitted → throws "simulated transient" inside the mock.
    m.verifyResults.set("rd-pending", {
      id: "rd-pending",
      name: "c.test",
      status: "pending",
      records: [],
    });

    const r = await sweepPendingSendingDomains();
    expect(r.scanned).toBe(3);
    expect(r.verified).toBe(1);
    expect(r.errored).toBe(1);
    expect(r.unchanged).toBe(1);
  });
});
