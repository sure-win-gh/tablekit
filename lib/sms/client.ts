// Singleton Twilio client.
//
// Same shape as lib/email/client.ts and lib/stripe/client.ts: lazy
// construction, placeholder detection, kill switch (shared with
// email via messagingDisabled).

import "server-only";

import twilio, { type Twilio } from "twilio";

let _client: Twilio | null = null;

export class SmsNotConfiguredError extends Error {
  constructor() {
    super("lib/sms/client.ts: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN not set (or placeholder).");
    this.name = "SmsNotConfiguredError";
  }
}

function isRealSid(sid: string | undefined): sid is string {
  if (!sid) return false;
  if (sid.includes("YOUR_")) return false;
  return sid.startsWith("AC");
}

function isRealToken(token: string | undefined): token is string {
  if (!token) return false;
  if (token.includes("YOUR_")) return false;
  return token.length >= 20;
}

export function twilioClient(): Twilio {
  if (_client) return _client;
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  if (!isRealSid(sid) || !isRealToken(token)) throw new SmsNotConfiguredError();
  _client = twilio(sid, token);
  return _client;
}

export function smsEnabled(): boolean {
  return (
    isRealSid(process.env["TWILIO_ACCOUNT_SID"]) && isRealToken(process.env["TWILIO_AUTH_TOKEN"])
  );
}

// Same kill switch as the email client — defined locally rather than
// re-exported so vi.resetModules in tests doesn't trip over the
// re-export chain.
export function messagingDisabled(): boolean {
  return process.env["MESSAGING_DISABLED"] === "true";
}

export function fromNumber(): string {
  const num = process.env["TWILIO_FROM_NUMBER"];
  if (!num || num.includes("YOUR_")) {
    throw new SmsNotConfiguredError();
  }
  return num;
}

export function _resetSmsClientForTests(): void {
  _client = null;
}
