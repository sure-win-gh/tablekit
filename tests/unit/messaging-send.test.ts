// Unit tests for lib/email/send.ts + lib/sms/send.ts.
//
// Mocks the Resend / Twilio SDKs to assert: kill switch
// short-circuits, success returns the provider id, retryable-vs-
// permanent error classification matches the spec.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env["RESEND_API_KEY"] = "re_" + "a".repeat(40);
  process.env["RESEND_FROM_EMAIL"] = "TableKit <test@tablekit.test>";
  process.env["TWILIO_ACCOUNT_SID"] = "AC" + "x".repeat(32);
  process.env["TWILIO_AUTH_TOKEN"] = "x".repeat(32);
  process.env["TWILIO_FROM_NUMBER"] = "+441234567890";
  delete process.env["MESSAGING_DISABLED"];
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("short-circuits when MESSAGING_DISABLED=true", async () => {
    process.env["MESSAGING_DISABLED"] = "true";
    const { sendEmail } = await import("@/lib/email/send");
    await expect(
      sendEmail({
        to: "guest@example.com",
        subject: "x",
        html: "<p>x</p>",
        unsubscribeUrl: "https://example.com/u",
        idempotencyKey: "x",
      }),
    ).rejects.toMatchObject({
      name: "EmailSendError",
      code: "messaging-disabled",
      retryable: false,
    });
  });

  it("returns providerId on success + forwards List-Unsubscribe + idempotency key", async () => {
    const sendMock = vi.fn(async (_body: unknown, _opts: unknown) => ({
      data: { id: "re_test_1" },
      error: null,
    }));
    vi.doMock("@/lib/email/client", () => ({
      resend: () => ({ emails: { send: sendMock } }),
      fromEmail: () => "TableKit <test@tablekit.test>",
      messagingDisabled: () => false,
    }));

    const { sendEmail } = await import("@/lib/email/send");
    const r = await sendEmail({
      to: "guest@example.com",
      subject: "Confirmed",
      html: "<p>Yo</p>",
      unsubscribeUrl: "https://app.tablekit.test/unsubscribe?t=abc",
      idempotencyKey: "msg_uuid_v1",
    });
    expect(r.providerId).toBe("re_test_1");

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [body, opts] = sendMock.mock.calls[0]!;
    expect(body).toMatchObject({
      from: "TableKit <test@tablekit.test>",
      to: "guest@example.com",
      subject: "Confirmed",
      html: "<p>Yo</p>",
      headers: {
        "List-Unsubscribe": "<https://app.tablekit.test/unsubscribe?t=abc>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(opts).toMatchObject({ idempotencyKey: "msg_uuid_v1" });
  });

  it("classifies a validation_error as non-retryable", async () => {
    vi.doMock("@/lib/email/client", () => ({
      resend: () => ({
        emails: {
          send: async () => ({
            data: null,
            error: { name: "validation_error", message: "bad email" },
          }),
        },
      }),
      fromEmail: () => "x",
      messagingDisabled: () => false,
    }));
    const { sendEmail } = await import("@/lib/email/send");
    await expect(
      sendEmail({
        to: "bad",
        subject: "x",
        html: "x",
        unsubscribeUrl: "x",
        idempotencyKey: "x",
      }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("classifies an unknown provider error as retryable", async () => {
    vi.doMock("@/lib/email/client", () => ({
      resend: () => ({
        emails: {
          send: async () => ({
            data: null,
            error: { name: "rate_limit_exceeded", message: "slow down" },
          }),
        },
      }),
      fromEmail: () => "x",
      messagingDisabled: () => false,
    }));
    const { sendEmail } = await import("@/lib/email/send");
    await expect(
      sendEmail({
        to: "ok@example.com",
        subject: "x",
        html: "x",
        unsubscribeUrl: "x",
        idempotencyKey: "x",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("sendSms", () => {
  it("short-circuits when MESSAGING_DISABLED=true", async () => {
    process.env["MESSAGING_DISABLED"] = "true";
    const { sendSms } = await import("@/lib/sms/send");
    await expect(sendSms({ to: "+447", body: "x" })).rejects.toMatchObject({
      name: "SmsSendError",
      code: "messaging-disabled",
      retryable: false,
    });
  });

  it("returns providerId on success", async () => {
    const createMock = vi.fn(async () => ({ sid: "SM_test_1" }));
    vi.doMock("@/lib/sms/client", () => ({
      twilioClient: () => ({ messages: { create: createMock } }),
      fromNumber: () => "+441234567890",
      messagingDisabled: () => false,
    }));
    const { sendSms } = await import("@/lib/sms/send");
    const r = await sendSms({
      to: "+447700900123",
      body: "Reminder: 7pm tonight at TableKit Café.",
    });
    expect(r.providerId).toBe("SM_test_1");
    expect(createMock).toHaveBeenCalledWith({
      to: "+447700900123",
      from: "+441234567890",
      body: "Reminder: 7pm tonight at TableKit Café.",
    });
  });

  it("classifies a Twilio 21000-range error as non-retryable", async () => {
    const err = Object.assign(new Error("invalid number"), { code: 21211 });
    vi.doMock("@/lib/sms/client", () => ({
      twilioClient: () => ({
        messages: {
          create: async () => {
            throw err;
          },
        },
      }),
      fromNumber: () => "+x",
      messagingDisabled: () => false,
    }));
    const { sendSms } = await import("@/lib/sms/send");
    await expect(sendSms({ to: "+1", body: "x" })).rejects.toMatchObject({ retryable: false });
  });

  it("classifies a 30000-range error as retryable", async () => {
    const err = Object.assign(new Error("delivery temporarily failed"), { code: 30007 });
    vi.doMock("@/lib/sms/client", () => ({
      twilioClient: () => ({
        messages: {
          create: async () => {
            throw err;
          },
        },
      }),
      fromNumber: () => "+x",
      messagingDisabled: () => false,
    }));
    const { sendSms } = await import("@/lib/sms/send");
    await expect(sendSms({ to: "+1", body: "x" })).rejects.toMatchObject({ retryable: true });
  });
});
