// Send an SMS via Twilio.
//
// Same shape as lib/email/send.ts: returns { providerId } on success,
// throws SmsSendError on failure with a `retryable` hint.
//
// Twilio SMS doesn't have an Idempotency-Key header equivalent — the
// DB-level idempotency (messages unique index) plus the worker's
// optimistic-claim update is the real defence.

import "server-only";

import { fromNumber, messagingDisabled, twilioClient } from "./client";

export type SendSmsInput = {
  to: string;
  body: string;
  // Forwarded to Twilio's status callback so we can correlate
  // provider events back to our messages row.
  statusCallback?: string;
};

export type SendSmsResult = {
  providerId: string;
};

export class SmsSendError extends Error {
  constructor(
    message: string,
    public readonly code: "messaging-disabled" | "provider-error",
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SmsSendError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  if (messagingDisabled()) {
    throw new SmsSendError("messaging kill-switch engaged", "messaging-disabled", false);
  }

  try {
    const msg = await twilioClient().messages.create({
      to: input.to,
      from: fromNumber(),
      body: input.body,
      ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}),
    });
    return { providerId: msg.sid };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: number }).code;
    // Twilio error codes 21000–21999 are validation errors (bad
    // number, opt-out, regulatory). 30000–30999 are message delivery
    // failures, mostly retryable. Anything else: retry by default.
    const retryable = !(typeof code === "number" && code >= 21000 && code < 22000);
    // PII-safe: Twilio validation errors (e.g. 21211 "Invalid 'To' Phone
    // Number") echo the recipient number verbatim in err.message, and
    // that string is persisted to messages.error / campaign_sends.error.
    // Carry only a bland code — mirrors lib/whatsapp/send.ts + the
    // gdpr.md §"Outbound messaging SDK errors" rule. Don't attach the raw
    // err to .cause (it can carry the request payload = the number).
    throw new SmsSendError(`twilio:${code ?? "send-failed"}`, "provider-error", retryable, {
      status,
      code,
    });
  }
}
