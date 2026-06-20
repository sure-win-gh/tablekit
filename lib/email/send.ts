// Send a rendered email via Resend.
//
// Returns { providerId } on success, throws EmailSendError on
// transport failure. Callers (the dispatch worker in wave 4) catch
// and decide whether to retry based on the error code.
//
// `headers.List-Unsubscribe` + RFC 8058 one-click compatibility is
// stamped on every send so Gmail/Outlook treat us as well-behaved
// transactional senders.

import "server-only";

import { fromEmail, messagingDisabled, resend } from "./client";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // The full one-click unsubscribe URL — generated per (guest, venue,
  // channel) by the dispatch layer so the same guest can opt out of
  // one venue without affecting another.
  unsubscribeUrl: string;
  // RFC 8058 one-click compatibility. Default true — guest-facing
  // emails accept POST against the unsubscribe URL. Operational
  // alerts (escalation alerts to operators) should set this to false:
  // their unsubscribe URL is a dashboard settings link that 405s on
  // POST, and a mismatched header would let mailbox providers
  // downgrade sender reputation.
  oneClickUnsubscribe?: boolean;
  // Optional per-venue reply-to (operator branding). When set, guest
  // replies go to the venue's own address rather than the platform from.
  replyTo?: string;
  // Forwarded to Resend so they can dedupe on retries.
  idempotencyKey: string;
};

export type SendEmailResult = {
  providerId: string;
};

export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly code: "messaging-disabled" | "provider-error" | "no-id-returned",
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EmailSendError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (messagingDisabled()) {
    throw new EmailSendError("messaging kill-switch engaged", "messaging-disabled", false);
  }

  const oneClick = input.oneClickUnsubscribe !== false;
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
  };
  if (oneClick) {
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  try {
    const r = await resend().emails.send(
      {
        from: fromEmail(),
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        headers,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (r.error) {
      // Bland code only. Resend validation errors (e.g. invalid_to_address)
      // echo the recipient address in r.error.message, and that string is
      // persisted to messages.error / campaign_sends.error. Mirror the
      // twilio:<code> pattern in lib/sms/send.ts (gdpr.md §Outbound messaging
      // SDK errors). The structured cause carries only the bland error name —
      // never the raw message or request payload.
      throw new EmailSendError(
        `resend:${r.error.name}`,
        "provider-error",
        retryableEmail(r.error.name),
        { name: r.error.name },
      );
    }
    if (!r.data?.id) {
      throw new EmailSendError("Resend returned no message id", "no-id-returned", true);
    }
    return { providerId: r.data.id };
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    // Unexpected throw (network / SDK). Don't surface err.message or attach
    // the raw err as .cause — either can carry the recipient address or the
    // request payload. Bland code + the error's class name only.
    throw new EmailSendError("resend:exception", "provider-error", true, {
      name: err instanceof Error ? err.name : "unknown",
    });
  }
}

// Resend error names that indicate a transient failure worth retrying
// vs a permanent rejection (bad email, suppressed address, etc.).
function retryableEmail(name: string): boolean {
  const permanent = new Set([
    "validation_error",
    "missing_required_field",
    "invalid_to_address",
    "invalid_from_address",
    "suppressed",
    "domain_not_verified",
  ]);
  return !permanent.has(name);
}
