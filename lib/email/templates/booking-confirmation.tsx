import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function gbp(minor: number): string {
  const pounds = (minor / 100).toFixed(2).replace(/\.00$/, "");
  return `£${pounds}`;
}

function BookingConfirmationEmail({ ctx }: { ctx: MessageBookingContext }) {
  const tickets = ctx.eventTickets;
  return (
    <EmailLayout
      preview={
        tickets
          ? `Tickets confirmed — ${ctx.serviceName}, ${ctx.startAtLocal}`
          : `Booking confirmed for ${ctx.startAtLocal}`
      }
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
      branding={ctx.branding}
    >
      <P>Hi {ctx.guestFirstName},</P>
      {tickets ? (
        <>
          <P>
            You&rsquo;re booked in for <strong>{ctx.serviceName}</strong> at {ctx.venueName} —{" "}
            {ctx.startAtLocal}.
          </P>
          <P>
            {tickets.lines.map((line) => (
              <span key={line.name}>
                {line.quantity}× {line.name} — {gbp(line.unitPriceMinor * line.quantity)}
                <br />
              </span>
            ))}
            <strong>Total paid: {gbp(tickets.totalMinor)}</strong>
          </P>
        </>
      ) : (
        <P>
          Your table at {ctx.venueName} is confirmed for {ctx.startAtLocal}, party of{" "}
          {ctx.partySize}.
        </P>
      )}
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
