import { Link } from "@react-email/components";
import { render } from "@react-email/render";

import type { MessageBookingContext, RenderedEmail } from "@/lib/messaging/context";

import { EmailLayout, P } from "./_layout";

function BookingReviewRequestEmail({ ctx }: { ctx: MessageBookingContext }) {
  const privateUrl = `${ctx.reviewUrl}&mode=private`;
  const linkStyle = { color: "#111111", fontWeight: 600 } as const;
  return (
    <EmailLayout
      preview={`How was your visit to ${ctx.venueName}?`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>Hi {ctx.guestFirstName},</P>
      <P>Thanks again for visiting {ctx.venueName}. We&apos;d love a quick word on how it went.</P>
      <P>
        <Link href={ctx.reviewUrl} style={linkStyle}>
          Leave a review →
        </Link>
      </P>
      <P>
        Or, if you&apos;d rather it stayed between us:{" "}
        <Link href={privateUrl} style={linkStyle}>
          send private feedback
        </Link>
        .
      </P>
      <P>It takes about 30 seconds and means a lot to a small team.</P>
    </EmailLayout>
  );
}

export async function renderBookingReviewRequest(
  ctx: MessageBookingContext,
): Promise<RenderedEmail> {
  const html = await render(<BookingReviewRequestEmail ctx={ctx} />);
  const text = await render(<BookingReviewRequestEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `How was your visit to ${ctx.venueName}?`,
    html,
    text,
  };
}
