// Send a WhatsApp message via Twilio.
//
// Same shape as lib/sms/send.ts: returns { providerId } on success,
// throws WhatsAppSendError on failure with a `retryable` hint so the
// dispatch worker's existing retry/backoff path treats it identically
// to an SMS failure.
//
// Two send modes:
//   * Template (contentSid + contentVariables) — required for
//     business-initiated messages outside the 24h customer-service
//     window. The copy must already be approved in Twilio/Meta.
//   * Freeform (body) — only valid inside an open 24h session. We keep
//     it for the Twilio sandbox + future session replies.
// A renderer supplies contentSid when the template is approved; we
// prefer it and fall back to body.

import "server-only";

import { messagingDisabled, twilioClient, whatsappFrom, whatsappTo } from "./client";

export type SendWhatsAppInput = {
  to: string; // bare E.164; we add the whatsapp: prefix
  body: string;
  // Approved-template send (business-initiated, outside the session window).
  contentSid?: string;
  contentVariables?: Record<string, string>;
  // Forwarded to Twilio's status callback so we can correlate provider
  // events back to our messages row.
  statusCallback?: string;
};

export type SendWhatsAppResult = {
  providerId: string;
};

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    public readonly code: "messaging-disabled" | "provider-error",
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  if (messagingDisabled()) {
    throw new WhatsAppSendError("messaging kill-switch engaged", "messaging-disabled", false);
  }

  try {
    const msg = await twilioClient().messages.create({
      to: whatsappTo(input.to),
      from: whatsappFrom(),
      // Prefer the approved template; Twilio ignores `body` when
      // contentSid is set. Freeform body is the session-window path.
      ...(input.contentSid
        ? {
            contentSid: input.contentSid,
            ...(input.contentVariables
              ? { contentVariables: JSON.stringify(input.contentVariables) }
              : {}),
          }
        : { body: input.body }),
      ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}),
    });
    return { providerId: msg.sid };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const code = (err as { code?: number }).code;
    // Same Twilio classification as SMS: 21000–21999 are validation
    // errors (bad number, opt-out, not on WhatsApp, regulatory) and are
    // non-retryable; everything else retries by default.
    const retryable = !(typeof code === "number" && code >= 21000 && code < 22000);
    // PII-safe: Twilio validation errors (e.g. 21211 "Invalid 'To'
    // Phone Number") echo the recipient E.164 verbatim in err.message.
    // That message is persisted to messages.error + the audit reason, so
    // carry only a bland code — mirrors the resend:<name> pattern in
    // gdpr.md §Outbound messaging SDK errors. Do NOT attach the raw err
    // to .cause (it can carry the request payload = the number).
    throw new WhatsAppSendError(`twilio:${code ?? "send-failed"}`, "provider-error", retryable, {
      status,
      code,
    });
  }
}
