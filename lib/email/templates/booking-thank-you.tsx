import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function BookingThankYouEmail({ ctx }: { ctx: MessageBookingContext }) {
  return (
    <EmailLayout
      preview={`Thanks for visiting ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>Thanks for joining us at {ctx.venueName} earlier today.</P>
      <P>We hope you had a good one — we&apos;d love to see you again.</P>
    </EmailLayout>
  );
}

export async function renderBookingThankYou(ctx: MessageBookingContext): Promise<RenderedEmail> {
  const html = await render(<BookingThankYouEmail ctx={ctx} />);
  const text = await render(<BookingThankYouEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `Thanks from ${ctx.venueName}`,
    html,
    text,
  };
}
