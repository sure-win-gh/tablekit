import { Link } from "@react-email/components";
import { render } from "@react-email/render";

import { EmailLayout, P } from "./_layout";

export type EscalationAlertContext = {
  venueName: string;
  rating: number;
  source: string;
  commentSnippet: string | null;
  reviewerName: string | null;
  dashboardUrl: string;
  unsubscribeUrl: string;
};

function ReviewEscalationAlertEmail({ ctx }: { ctx: EscalationAlertContext }) {
  return (
    <EmailLayout
      preview={`${ctx.rating}-star review at ${ctx.venueName}`}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
    >
      <P>
        A {ctx.rating}-star review just landed for {ctx.venueName}
        {ctx.reviewerName ? ` from ${ctx.reviewerName}` : ""} ({ctx.source}).
      </P>
      {ctx.commentSnippet ? (
        <p
          style={{
            fontSize: "15px",
            lineHeight: "22px",
            margin: "0 0 12px 0",
            color: "#111111",
            whiteSpace: "pre-line",
            borderLeft: "2px solid #111111",
            paddingLeft: "12px",
          }}
        >
          {ctx.commentSnippet}
        </p>
      ) : (
        <P>(No comment.)</P>
      )}
      <P>
        <Link href={ctx.dashboardUrl} style={{ color: "#111111", fontWeight: 600 }}>
          Open in dashboard →
        </Link>
      </P>
      <P>You can reply privately or send a recovery offer from there.</P>
    </EmailLayout>
  );
}

export async function renderReviewEscalationAlert(ctx: EscalationAlertContext) {
  const html = await render(<ReviewEscalationAlertEmail ctx={ctx} />);
  const text = await render(<ReviewEscalationAlertEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `${ctx.rating}-star review at ${ctx.venueName}`,
    html,
    text,
  };
}
