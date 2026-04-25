// Singleton Resend client.
//
// Mirrors lib/stripe/client.ts: lazy construction, placeholder
// detection, kill switch. Every server-side caller goes through
// resend() so we construct at most once per process and tests can
// flip RESEND_API_KEY between cases without import gymnastics.

import "server-only";

import { Resend } from "resend";

let _client: Resend | null = null;

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("lib/email/client.ts: RESEND_API_KEY is not set (or is a placeholder).");
    this.name = "EmailNotConfiguredError";
  }
}

function isRealKey(key: string | undefined): key is string {
  if (!key) return false;
  if (key.includes("YOUR_")) return false;
  return key.startsWith("re_");
}

export function resend(): Resend {
  if (_client) return _client;
  const key = process.env["RESEND_API_KEY"];
  if (!isRealKey(key)) throw new EmailNotConfiguredError();
  _client = new Resend(key);
  return _client;
}

export function emailEnabled(): boolean {
  return isRealKey(process.env["RESEND_API_KEY"]);
}

// Global messaging kill switch — applies to both email + SMS. Set in
// an incident response to stop all outbound sends immediately. Both
// `lib/email/send.ts` and `lib/sms/send.ts` short-circuit on this.
export function messagingDisabled(): boolean {
  return process.env["MESSAGING_DISABLED"] === "true";
}

// The sender address — already validated as a real value at config
// load. Placeholder ("no-reply@example.com") is only flagged at send
// time when send.ts checks the result.
export function fromEmail(): string {
  return process.env["RESEND_FROM_EMAIL"] ?? "TableKit <no-reply@example.com>";
}

// Test helper — drop the cached singleton.
export function _resetEmailClientForTests(): void {
  _client = null;
}
