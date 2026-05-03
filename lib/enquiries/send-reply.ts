// Send an operator-approved enquiry reply via Resend.
//
// Distinct from `lib/email/send.ts` because that helper bakes in
// List-Unsubscribe headers for marketing/transactional flows; an
// enquiry reply is a 1:1 conversation the guest started, so the
// unsubscribe semantics don't apply. We also set `Reply-To` to the
// venue's slug-routed enquiries address so guest replies route back
// to the venue's inbox (not into our enquiries inbox a second time).
//
// v1 sends from the platform `RESEND_FROM_EMAIL`. The spec calls for
// a venue-verified sending domain so replies don't show "via
// tablekit.uk" — that's substantially more infrastructure (per-venue
// DKIM/SPF/DMARC, verification flow, fallback handling) and is
// tracked separately. Until then, `Reply-To` keeps the conversation
// pointing at the right inbox.
//
// PII / Logging note (per gdpr.md §Logs and error tracking): Resend
// SDK error messages can embed the recipient email verbatim on
// validation failures (e.g. `invalid_to_address`). The recipient is
// the decrypted guest email — that's PII. We sanitise the SDK's
// message into a bland error code before constructing the typed
// `EmailSendError`, and we deliberately do NOT attach the raw SDK
// error as `.cause` (so Sentry / log aggregators only ever see the
// bland code, even on an unhandled rethrow further up the stack).

import "server-only";

import { fromEmail, messagingDisabled, resend } from "@/lib/email/client";
import { EmailSendError } from "@/lib/email/send";

export type SendEnquiryReplyInput = {
  to: string;
  replyTo: string;
  subject: string;
  body: string;
  // Stable across retries — Resend dedupes on this. The action layer
  // uses `enquiry-reply:${enquiryId}` so a double-click can't fire a
  // second send.
  idempotencyKey: string;
};

export type SendEnquiryReplyResult = {
  providerId: string;
};

export async function sendEnquiryReply(
  input: SendEnquiryReplyInput,
): Promise<SendEnquiryReplyResult> {
  if (messagingDisabled()) {
    throw new EmailSendError("messaging kill-switch engaged", "messaging-disabled", false);
  }

  let r: Awaited<ReturnType<ReturnType<typeof resend>["emails"]["send"]>>;
  try {
    r = await resend().emails.send(
      {
        from: fromEmail(),
        to: input.to,
        replyTo: input.replyTo,
        subject: input.subject,
        text: input.body,
      },
      { idempotencyKey: input.idempotencyKey },
    );
  } catch (err) {
    // Network / SDK throw — sanitise before re-raising. Don't attach
    // .cause; the SDK exception text can carry the recipient email.
    throw new EmailSendError(sanitiseSendError(err), "provider-error", true);
  }

  if (r.error) {
    // Resend returned a structured error. Map its `name` to a bland
    // code; never copy `r.error.message` (can echo recipient address).
    throw new EmailSendError(`resend:${r.error.name ?? "unknown"}`, "provider-error", true);
  }
  if (!r.data?.id) {
    throw new EmailSendError("resend:no-id-returned", "no-id-returned", true);
  }
  return { providerId: r.data.id };
}

// Map an unknown thrown error to a PII-free string. We accept losing
// some debug detail here in exchange for a guarantee that no guest
// email or message body content reaches log aggregators via this
// path. Keep the surface tiny — just the SDK error `name` (which is
// a class identifier, not user text).
function sanitiseSendError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err && typeof err.name === "string") {
    return `resend:${err.name}`;
  }
  return "resend:unknown";
}
