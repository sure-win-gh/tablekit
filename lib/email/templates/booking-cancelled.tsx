import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function formatGbp(minor: number): string {
  return `£${(minor / 100).toFixed(2).replace(/\.00$/, "")}`;
}

function BookingCancelledEmail({ ctx }: { ctx: MessageBookingContext }) {
  return (
    <EmailLayout
      preview={`Your booking at ${ctx.venueName} has been cancelled`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>
        Your booking for {ctx.startAtLocal} (party of {ctx.partySize}) has been cancelled.
      </P>
      {ctx.cancellationReason ? <P>Reason on file: {ctx.cancellationReason}</P> : null}
      {typeof ctx.forfeitedAmountMinor === "number" && ctx.forfeitedAmountMinor > 0 ? (
        <P>
          A {formatGbp(ctx.forfeitedAmountMinor)} deposit / no-show fee was retained per the
          venue&apos;s booking terms.
        </P>
      ) : null}
      <P>
        Reference: <strong>{ctx.reference}</strong>
      </P>
      <P>If this was a mistake, reply to this email or call the venue.</P>
    </EmailLayout>
  );
}

export async function renderBookingCancelled(ctx: MessageBookingContext): Promise<RenderedEmail> {
  const html = await render(<BookingCancelledEmail ctx={ctx} />);
  const text = await render(<BookingCancelledEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `Booking cancelled at ${ctx.venueName}`,
    html,
    text,
  };
}
