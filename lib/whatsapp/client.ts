// WhatsApp-over-Twilio config.
//
// WhatsApp rides the same Twilio account/SDK as SMS. We keep this
// client self-contained (own singleton + kill switch read) rather than
// re-export from lib/sms/client — the SMS client's own comment warns
// that re-export chains trip vi.resetModules in tests, and WhatsApp
// would inherit that fragility. Only the sender address differs:
// WhatsApp goes from a WhatsApp-enabled number (or the sandbox number),
// addressed with the `whatsapp:` channel prefix.

import "server-only";

import twilio, { type Twilio } from "twilio";

let _client: Twilio | null = null;

export class WhatsAppNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`lib/whatsapp/client.ts: ${detail}`);
    this.name = "WhatsAppNotConfiguredError";
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

function isRealNumber(num: string | undefined): num is string {
  if (!num) return false;
  if (num.includes("YOUR_")) return false;
  return true;
}

export function twilioClient(): Twilio {
  if (_client) return _client;
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  if (!isRealSid(sid) || !isRealToken(token)) {
    throw new WhatsAppNotConfiguredError("TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN not set");
  }
  _client = twilio(sid, token);
  return _client;
}

// Same kill switch as the email/SMS clients — read locally to avoid a
// re-export chain.
export function messagingDisabled(): boolean {
  return process.env["MESSAGING_DISABLED"] === "true";
}

export function whatsappEnabled(): boolean {
  return (
    isRealSid(process.env["TWILIO_ACCOUNT_SID"]) &&
    isRealToken(process.env["TWILIO_AUTH_TOKEN"]) &&
    isRealNumber(process.env["TWILIO_WHATSAPP_FROM"])
  );
}

// Twilio expects the WhatsApp sender as `whatsapp:+E164`. We store the
// bare number in env and add the prefix here so the env value matches
// the SMS one's shape.
export function whatsappFrom(): string {
  const num = process.env["TWILIO_WHATSAPP_FROM"];
  if (!isRealNumber(num)) {
    throw new WhatsAppNotConfiguredError("TWILIO_WHATSAPP_FROM not set (or placeholder)");
  }
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

// Wrap a bare E.164 recipient number in the WhatsApp channel prefix.
export function whatsappTo(e164: string): string {
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

export function _resetWhatsAppClientForTests(): void {
  _client = null;
}
