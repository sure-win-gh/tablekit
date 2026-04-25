// Unit tests for lib/email/client.ts + lib/sms/client.ts.
//
// Same shape as stripe-client.test.ts — placeholder detection, kill
// switch, singleton behaviour. The send helpers are exercised by
// tests/unit/messaging-send.test.ts.

import { afterEach, describe, expect, it } from "vitest";

import {
  EmailNotConfiguredError,
  _resetEmailClientForTests,
  emailEnabled,
  messagingDisabled,
  resend,
} from "@/lib/email/client";
import {
  SmsNotConfiguredError,
  _resetSmsClientForTests,
  smsEnabled,
  twilioClient,
} from "@/lib/sms/client";

const originalResend = process.env["RESEND_API_KEY"];
const originalSid = process.env["TWILIO_ACCOUNT_SID"];
const originalToken = process.env["TWILIO_AUTH_TOKEN"];
const originalFromNum = process.env["TWILIO_FROM_NUMBER"];
const originalDisabled = process.env["MESSAGING_DISABLED"];

afterEach(() => {
  function restore(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  restore("RESEND_API_KEY", originalResend);
  restore("TWILIO_ACCOUNT_SID", originalSid);
  restore("TWILIO_AUTH_TOKEN", originalToken);
  restore("TWILIO_FROM_NUMBER", originalFromNum);
  restore("MESSAGING_DISABLED", originalDisabled);
  _resetEmailClientForTests();
  _resetSmsClientForTests();
});

describe("resend() client factory", () => {
  it("throws when RESEND_API_KEY is unset", () => {
    delete process.env["RESEND_API_KEY"];
    _resetEmailClientForTests();
    expect(() => resend()).toThrow(EmailNotConfiguredError);
  });

  it("throws on the .env.local.example placeholder", () => {
    process.env["RESEND_API_KEY"] = "re_YOUR_RESEND_API_KEY";
    _resetEmailClientForTests();
    expect(() => resend()).toThrow(EmailNotConfiguredError);
  });

  it("throws when the key isn't re_ shaped", () => {
    process.env["RESEND_API_KEY"] = "sk_test_thisiswrong";
    _resetEmailClientForTests();
    expect(() => resend()).toThrow(EmailNotConfiguredError);
  });

  it("constructs + caches a singleton for a real-looking key", () => {
    process.env["RESEND_API_KEY"] = "re_" + "a".repeat(40);
    _resetEmailClientForTests();
    const a = resend();
    const b = resend();
    expect(a).toBe(b);
  });
});

describe("emailEnabled()", () => {
  it("is false for placeholder / unset keys", () => {
    process.env["RESEND_API_KEY"] = "re_YOUR_RESEND_API_KEY";
    expect(emailEnabled()).toBe(false);
    delete process.env["RESEND_API_KEY"];
    expect(emailEnabled()).toBe(false);
  });

  it("is true for a real-looking re_ key", () => {
    process.env["RESEND_API_KEY"] = "re_real";
    expect(emailEnabled()).toBe(true);
  });
});

describe("twilioClient() factory", () => {
  it("throws when SID is unset / placeholder / wrong shape", () => {
    delete process.env["TWILIO_ACCOUNT_SID"];
    process.env["TWILIO_AUTH_TOKEN"] = "x".repeat(32);
    _resetSmsClientForTests();
    expect(() => twilioClient()).toThrow(SmsNotConfiguredError);
  });

  it("throws when the token is the placeholder", () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC" + "x".repeat(32);
    process.env["TWILIO_AUTH_TOKEN"] = "YOUR_TWILIO_AUTH_TOKEN";
    _resetSmsClientForTests();
    expect(() => twilioClient()).toThrow(SmsNotConfiguredError);
  });

  it("constructs + caches when both vars are real-looking", () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC" + "x".repeat(32);
    process.env["TWILIO_AUTH_TOKEN"] = "x".repeat(32);
    _resetSmsClientForTests();
    const a = twilioClient();
    const b = twilioClient();
    expect(a).toBe(b);
  });
});

describe("smsEnabled()", () => {
  it("is true only when both SID + token are real", () => {
    process.env["TWILIO_ACCOUNT_SID"] = "AC" + "x".repeat(32);
    process.env["TWILIO_AUTH_TOKEN"] = "x".repeat(32);
    expect(smsEnabled()).toBe(true);

    process.env["TWILIO_AUTH_TOKEN"] = "YOUR_TWILIO_AUTH_TOKEN";
    expect(smsEnabled()).toBe(false);
  });
});

describe("messagingDisabled() kill switch", () => {
  it("is false unless explicitly 'true'", () => {
    delete process.env["MESSAGING_DISABLED"];
    expect(messagingDisabled()).toBe(false);
    process.env["MESSAGING_DISABLED"] = "false";
    expect(messagingDisabled()).toBe(false);
    process.env["MESSAGING_DISABLED"] = "1";
    expect(messagingDisabled()).toBe(false);
    process.env["MESSAGING_DISABLED"] = "true";
    expect(messagingDisabled()).toBe(true);
  });
});
