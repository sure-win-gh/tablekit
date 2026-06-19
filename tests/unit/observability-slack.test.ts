// Unit tests for the Slack alert helper. We stub global.fetch and the
// env var so the test runs offline and deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendSlackAlert } from "@/lib/observability/slack";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sendSlackAlert", () => {
  it("no-ops (returns false) when no webhook is configured", async () => {
    delete process.env["SLACK_ALERT_WEBHOOK_URL"];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ok = await sendSlackAlert({ title: "x" });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the webhook and reports success", async () => {
    process.env["SLACK_ALERT_WEBHOOK_URL"] = "https://hooks.slack.test/abc";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const ok = await sendSlackAlert({
      title: "Health check failed",
      level: "critical",
      fields: { check: "database", latencyMs: 42 },
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.test/abc");
    const body = JSON.parse((init as RequestInit).body as string) as { text: string };
    // Title and fields are rendered into the message text.
    expect(body.text).toContain("Health check failed");
    expect(body.text).toContain("check:");
    expect(body.text).toContain("database");
  });

  it("never throws and returns false on a network error", async () => {
    process.env["SLACK_ALERT_WEBHOOK_URL"] = "https://hooks.slack.test/abc";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const ok = await sendSlackAlert({ title: "x" });
    expect(ok).toBe(false);
  });

  it("returns false when Slack responds non-2xx", async () => {
    process.env["SLACK_ALERT_WEBHOOK_URL"] = "https://hooks.slack.test/abc";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    const ok = await sendSlackAlert({ title: "x" });
    expect(ok).toBe(false);
  });
});
