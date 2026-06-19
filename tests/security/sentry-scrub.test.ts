// Proves the Sentry PII scrubber mandated by docs/playbooks/gdpr.md strips
// email / phone / last_name / dob / notes (and variants) from event payloads
// before they leave the process, without corrupting Sentry's own metadata.

import { describe, expect, it } from "vitest";

import { redactContext, scrubEvent } from "@/lib/observability/sentry-scrub";

describe("scrubEvent", () => {
  it("redacts the playbook's PII keys wherever they appear in the event", () => {
    const event = {
      message: "boom",
      extra: { email: "guest@example.com", phone: "+447700900123", booking_id: "bk_1" },
      contexts: { guest: { last_name: "Smith", dob: "1990-01-01", notes: "allergic to nuts" } },
      request: { data: { firstName: "Jane", full_name: "Jane Smith" } },
    };

    const scrubbed = scrubEvent(event);

    expect(scrubbed.extra.email).toBe("[redacted]");
    expect(scrubbed.extra.phone).toBe("[redacted]");
    expect(scrubbed.contexts.guest.last_name).toBe("[redacted]");
    expect(scrubbed.contexts.guest.dob).toBe("[redacted]");
    expect(scrubbed.contexts.guest.notes).toBe("[redacted]");
    expect(scrubbed.request.data.firstName).toBe("[redacted]");
    expect(scrubbed.request.data.full_name).toBe("[redacted]");
    // Non-PII fields are preserved.
    expect(scrubbed.extra.booking_id).toBe("bk_1");
    expect(scrubbed.message).toBe("boom");
  });

  it("matches keys case-insensitively and ignoring separators", () => {
    const scrubbed = scrubEvent({ Email: "a@b.com", "Phone-Number": "123", LASTNAME: "X" });
    expect(scrubbed.Email).toBe("[redacted]");
    expect(scrubbed["Phone-Number"]).toBe("[redacted]");
    expect(scrubbed.LASTNAME).toBe("[redacted]");
  });

  it("does not redact a bare `name` so Sentry metadata survives", () => {
    const event = {
      sdk: { name: "sentry.javascript.nextjs" },
      contexts: { os: { name: "macOS" }, runtime: { name: "node" } },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.sdk.name).toBe("sentry.javascript.nextjs");
    expect(scrubbed.contexts.os.name).toBe("macOS");
    expect(scrubbed.contexts.runtime.name).toBe("node");
  });

  it("walks arrays (e.g. breadcrumbs)", () => {
    const event = { breadcrumbs: [{ data: { email: "a@b.com", url: "/book" } }] };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.breadcrumbs[0]!.data.email).toBe("[redacted]");
    expect(scrubbed.breadcrumbs[0]!.data.url).toBe("/book");
  });

  it("never throws and bottoms out on cyclic structures", () => {
    const cyclic: Record<string, unknown> = { email: "a@b.com" };
    cyclic["self"] = cyclic;
    expect(() => scrubEvent(cyclic)).not.toThrow();
    expect((scrubEvent(cyclic) as { email: string }).email).toBe("[redacted]");
  });
});

describe("redactContext", () => {
  it("redacts PII keys (including a bare `name`) in a flat context bag", () => {
    const out = redactContext({ name: "Jane", email: "a@b.com", route: "api/health" });
    expect(out["name"]).toBe("[redacted]");
    expect(out["email"]).toBe("[redacted]");
    expect(out["route"]).toBe("api/health");
  });
});
