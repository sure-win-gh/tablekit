import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function ReviewOperatorReplyEmail({ ctx }: { ctx: MessageBookingContext }) {
  // Defensive — the dispatcher only enqueues this template when the
  // review row has a non-null response, but render-time the prop is
  // optional so a missing value won't crash the worker.
  const reply = ctx.operatorReplyText ?? "";
  return (
    <EmailLayout
      preview={`A note from ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>Thanks again for your feedback after your visit to {ctx.venueName}. The team wanted to reply directly:</P>
      {reply.split("\n").map((line, i) => (
        <P key={i}>{line || " "}</P>
      ))}
      <P>If you&apos;d like to talk further, just reply to this email.</P>
    </EmailLayout>
  );
}

export async function renderReviewOperatorReply(
  ctx: MessageBookingContext,
): Promise<RenderedEmail> {
  const html = await render(<ReviewOperatorReplyEmail ctx={ctx} />);
  const text = await render(<ReviewOperatorReplyEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `A reply from ${ctx.venueName}`,
    html,
    text,
  };
}
