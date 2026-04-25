// Message dispatch worker.
//
// Called by the daily cron (eventually pg_cron with finer cadence)
// and by inline triggers immediately after enqueue, so confirmations
// land within seconds rather than waiting on the next sweep.
//
// Concurrency: the claim step is atomic — we UPDATE rows with WHERE
// id IN (SELECT … FOR UPDATE SKIP LOCKED) so two concurrent workers
// can never grab the same row. Stuck-in-sending rows (worker crashed
// mid-send) are reclaimed once their updated_at exceeds
// STUCK_SENDING_THRESHOLD_MS — best-effort, but Resend/Twilio's
// idempotency keys cover the duplicate-send risk for retries inside
// that window.

import "server-only";

import { eq, sql } from "drizzle-orm";

import { messages } from "@/lib/db/schema";
import { EmailSendError, sendEmail } from "@/lib/email/send";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { SmsSendError, sendSms } from "@/lib/sms/send";

import { backoffMs, truncateError } from "./enqueue";
import { loadMessageContext } from "./load-context";
import { renderForChannel, type MessageChannel, type MessageTemplate } from "./registry";

export type DispatchResult = {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
};

type ClaimedRow = {
  id: string;
  organisationId: string;
  bookingId: string;
  template: string;
  channel: string;
  attempts: number;
};

export async function processNextBatch(
  opts: { limit?: number; now?: Date; appUrl?: string } = {},
): Promise<DispatchResult> {
  const limit = opts.limit ?? 25;
  const appUrl = opts.appUrl ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "https://app.tablekit.test";

  const db = adminDb();

  // Atomic claim. Two predicates cover normal queued rows + stuck
  // 'sending' rows where a previous worker crashed mid-send.
  const claimed = (await db.execute(sql`
    update messages
    set status = 'sending',
        attempts = attempts + 1,
        updated_at = now()
    where id in (
      select id from messages
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'sending' and updated_at < now() - interval '5 minutes')
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, organisation_id as "organisationId",
              booking_id as "bookingId",
              template, channel, attempts
  `)) as unknown as { rows?: ClaimedRow[] } | ClaimedRow[];

  // node-postgres returns { rows: [...] }; some Drizzle versions hand
  // back the array directly. Normalise.
  const rows: ClaimedRow[] = Array.isArray(claimed) ? claimed : (claimed.rows ?? []);

  if (rows.length === 0) return { processed: 0, sent: 0, failed: 0, retried: 0 };

  let sent = 0;
  let failed = 0;
  let retried = 0;

  for (const row of rows) {
    const outcome = await processOne(row, appUrl);
    if (outcome === "sent") sent += 1;
    else if (outcome === "retried") retried += 1;
    else failed += 1;
  }

  return { processed: rows.length, sent, failed, retried };
}

type ProcessOutcome = "sent" | "retried" | "failed";

async function processOne(row: ClaimedRow, appUrl: string): Promise<ProcessOutcome> {
  const channel = row.channel as MessageChannel;
  const template = row.template as MessageTemplate;

  // Load context (decrypts recipient). On failure, mark failed —
  // these are non-retryable (booking missing, decrypt key wrong, opt-out).
  const ctxResult = await loadMessageContext({
    bookingId: row.bookingId,
    channel,
    appUrl,
  });
  if (!ctxResult.ok) {
    return markFailed(row, `load-context: ${ctxResult.reason}`);
  }

  // Render.
  const rendered = await renderForChannel(template, channel, ctxResult.ctx);
  if (rendered.kind === "no-renderer") {
    return markFailed(row, `no-renderer: ${template}/${channel}`);
  }

  // Send.
  try {
    if (rendered.kind === "email") {
      const r = await sendEmail({
        to: ctxResult.recipient,
        subject: rendered.rendered.subject,
        html: rendered.rendered.html,
        text: rendered.rendered.text,
        unsubscribeUrl: ctxResult.ctx.unsubscribeUrl,
        idempotencyKey: `msg_${row.id}_v1`,
      });
      return markSent(row, r.providerId);
    }
    const r = await sendSms({ to: ctxResult.recipient, body: rendered.rendered.body });
    return markSent(row, r.providerId);
  } catch (err) {
    const retryable =
      (err instanceof EmailSendError || err instanceof SmsSendError) && err.retryable;
    return retryable ? scheduleRetry(row, err) : markFailed(row, truncateError(err));
  }
}

async function markSent(row: ClaimedRow, providerId: string): Promise<"sent"> {
  const db = adminDb();
  await db
    .update(messages)
    .set({
      status: "sent",
      providerId,
      sentAt: sql`now()`,
      error: null,
    })
    .where(eq(messages.id, row.id));
  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "message.sent",
    targetType: "message",
    targetId: row.id,
    metadata: {
      bookingId: row.bookingId,
      template: row.template,
      channel: row.channel,
      providerId,
    },
  });
  return "sent";
}

async function markFailed(row: ClaimedRow, reason: string): Promise<"failed"> {
  const db = adminDb();
  await db.update(messages).set({ status: "failed", error: reason }).where(eq(messages.id, row.id));
  await audit.log({
    organisationId: row.organisationId,
    actorUserId: null,
    action: "message.failed",
    targetType: "message",
    targetId: row.id,
    metadata: {
      bookingId: row.bookingId,
      template: row.template,
      channel: row.channel,
      reason,
    },
  });
  return "failed";
}

async function scheduleRetry(row: ClaimedRow, err: unknown): Promise<ProcessOutcome> {
  // Note: row.attempts already reflects the count post-claim (+1).
  const delay = backoffMs(row.attempts);
  if (delay === null) {
    return markFailed(row, `exhausted (${row.attempts} attempts): ${truncateError(err)}`);
  }
  const nextAttempt = new Date(Date.now() + delay);
  const db = adminDb();
  await db
    .update(messages)
    .set({
      status: "queued",
      nextAttemptAt: nextAttempt,
      error: truncateError(err),
    })
    .where(eq(messages.id, row.id));
  return "retried";
}
