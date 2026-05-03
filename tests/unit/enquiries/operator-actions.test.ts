// Unit tests for the pure status-transition helpers. Each
// `decide*` function is a guard the server-action layer consults
// before writing — so the rules need to be tight, well-documented,
// and unit-testable in isolation.

import { describe, expect, it } from "vitest";

import {
  ORPHAN_PARSING_STALE_MS,
  decideDismiss,
  decideResetOrphan,
  decideRetryFailed,
  decideSendDraft,
} from "@/lib/enquiries/operator-actions";

describe("decideSendDraft", () => {
  const now = new Date("2026-05-03T10:00:00Z");

  it("transitions draft_ready → replied when a draft exists", () => {
    const r = decideSendDraft({ status: "draft_ready", hasDraft: true, now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next.status).toBe("replied");
      expect(r.next.repliedAt).toEqual(now);
    }
  });

  it("rejects when status is not draft_ready", () => {
    const r = decideSendDraft({ status: "received", hasDraft: true, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe("wrong-status");
  });

  it("rejects when no draft is persisted", () => {
    const r = decideSendDraft({ status: "draft_ready", hasDraft: false, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe("no-draft");
  });

  it("rejects from replied to prevent double-send", () => {
    const r = decideSendDraft({ status: "replied", hasDraft: true, now });
    expect(r.ok).toBe(false);
  });
});

describe("decideDismiss", () => {
  it.each(["received", "parsing", "draft_ready", "failed"] as const)(
    "allows dismiss from %s",
    (status) => {
      const r = decideDismiss({ status });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.next.status).toBe("discarded");
    },
  );

  it("rejects dismiss from replied (already sent)", () => {
    const r = decideDismiss({ status: "replied" });
    expect(r.ok).toBe(false);
  });

  it("rejects dismiss from discarded (idempotent guard)", () => {
    const r = decideDismiss({ status: "discarded" });
    expect(r.ok).toBe(false);
  });
});

describe("decideResetOrphan", () => {
  const now = new Date("2026-05-03T10:00:00Z");

  it("rejects when not in parsing state", () => {
    const r = decideResetOrphan({
      status: "draft_ready",
      updatedAt: new Date(now.getTime() - ORPHAN_PARSING_STALE_MS - 1000),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe("wrong-status");
  });

  it("rejects when the row was updated more recently than the stale window", () => {
    const r = decideResetOrphan({
      status: "parsing",
      updatedAt: new Date(now.getTime() - 60_000),
      now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe("not-stale-enough");
  });

  it("allows reset once the row exceeds the stale window", () => {
    const r = decideResetOrphan({
      status: "parsing",
      updatedAt: new Date(now.getTime() - ORPHAN_PARSING_STALE_MS - 1),
      now,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.status).toBe("received");
  });
});

describe("decideRetryFailed", () => {
  it("transitions failed → received with attempts reset", () => {
    const r = decideRetryFailed({ status: "failed" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next.status).toBe("received");
      expect(r.next.parseAttempts).toBe(0);
      expect(r.next.error).toBeNull();
    }
  });

  it.each(["received", "parsing", "draft_ready", "replied", "discarded"] as const)(
    "rejects retry from %s",
    (status) => {
      const r = decideRetryFailed({ status });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.rejection.reason).toBe("wrong-status");
    },
  );
});
