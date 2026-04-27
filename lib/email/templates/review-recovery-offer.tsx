import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function ReviewRecoveryOfferEmail({ ctx }: { ctx: MessageBookingContext }) {
  const message = ctx.recoveryMessageText ?? "";
  return (
    <EmailLayout
      preview={`A note from ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>
        Thank you for being honest about your visit to {ctx.venueName}. The team wanted to
        reach out directly:
      </P>
      <p
        style={{
          fontSize: "15px",
          lineHeight: "22px",
          margin: "0 0 12px 0",
          color: "#111111",
          whiteSpace: "pre-line",
        }}
      >
        {message}
      </p>
      <P>If there&apos;s anything else we can do, just reply to this email.</P>
    </EmailLayout>
  );
}

export async function renderReviewRecoveryOffer(
  ctx: MessageBookingContext,
): Promise<RenderedEmail> {
  const html = await render(<ReviewRecoveryOfferEmail ctx={ctx} />);
  const text = await render(<ReviewRecoveryOfferEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `A note from ${ctx.venueName}`,
    html,
    text,
  };
}
