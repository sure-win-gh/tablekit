import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function BookingConfirmationEmail({ ctx }: { ctx: MessageBookingContext }) {
  return (
    <EmailLayout
      preview={`Booking confirmed for ${ctx.startAtLocal}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>
        Your table at {ctx.venueName} is confirmed for {ctx.startAtLocal}, party of {ctx.partySize}.
      </P>
      <P>
        Reference: <strong>{ctx.reference}</strong>
      </P>
      {ctx.notes ? <P>Note on file: {ctx.notes}</P> : null}
      <P>If you need to change or cancel, reply to this email or call the venue.</P>
      <P>See you then.</P>
    </EmailLayout>
  );
}

export async function renderBookingConfirmation(
  ctx: MessageBookingContext,
): Promise<RenderedEmail> {
  const html = await render(<BookingConfirmationEmail ctx={ctx} />);
  const text = await render(<BookingConfirmationEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `Booking confirmed at ${ctx.venueName} — ${ctx.startAtLocal}`,
    html,
    text,
  };
}
