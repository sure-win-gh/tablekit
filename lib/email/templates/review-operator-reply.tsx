import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function ReviewOperatorReplyEmail({ ctx }: { ctx: MessageBookingContext }) {
  // Defensive — load-context refuses to build a context when the
  // cipher is missing, so this fallback should never render. Belt and
  // braces in case a future caller relaxes that.
  const reply = ctx.operatorReplyText ?? "";
  return (
    <EmailLayout
      preview={`A note from ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>
        Thanks again for your feedback after your visit to {ctx.venueName}. The team wanted to reply
        directly:
      </P>
      {/* whiteSpace: pre-line preserves the operator's line breaks
          without spawning empty <P> elements that Outlook collapses. */}
      <p
        style={{
          fontSize: "15px",
          lineHeight: "22px",
          margin: "0 0 12px 0",
          color: "#111111",
          whiteSpace: "pre-line",
        }}
      >
        {reply}
      </p>
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
