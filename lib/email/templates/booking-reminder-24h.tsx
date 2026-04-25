import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function BookingReminder24hEmail({ ctx }: { ctx: MessageBookingContext }) {
  return (
    <EmailLayout
      preview={`Reminder: tomorrow at ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>
        Quick reminder — we&apos;ve got you down for {ctx.startAtLocal}, party of {ctx.partySize}.
      </P>
      <P>
        Reference: <strong>{ctx.reference}</strong>
      </P>
      <P>Reply to this email or call us if anything changes.</P>
    </EmailLayout>
  );
}

export async function renderBookingReminder24h(ctx: MessageBookingContext): Promise<RenderedEmail> {
  const html = await render(<BookingReminder24hEmail ctx={ctx} />);
  const text = await render(<BookingReminder24hEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `Reminder: tomorrow at ${ctx.venueName}`,
    html,
    text,
  };
}
