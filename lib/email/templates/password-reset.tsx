// Password-reset email. Operational/security — sent to the account holder's
// address on file. Like team-invite, it doesn't use the venue-branded
// EmailLayout: the chrome is "TableKit", not a guest-facing venue mailing.
//
// `initiatedByAdmin` switches the copy for the support-triggered flow so the
// recipient knows our team started the reset at their request.

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { render } from "@react-email/render";

export type PasswordResetContext = {
  resetUrl: string;
  initiatedByAdmin: boolean;
};

function PasswordResetEmail({ ctx }: { ctx: PasswordResetContext }) {
  const intro = ctx.initiatedByAdmin
    ? "Our support team started a password reset for your TableKit account at your request."
    : "We received a request to reset the password for your TableKit account.";
  return (
    <Html>
      <Head />
      <Preview>Reset your TableKit password</Preview>
      <Body
        style={{
          backgroundColor: "#fafafa",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
          color: "#111111",
        }}
      >
        <Container
          style={{
            maxWidth: "560px",
            margin: "32px auto",
            padding: "32px",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            border: "1px solid #e5e5e5",
          }}
        >
          <Section>
            <Heading as="h1" style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 16px 0" }}>
              Reset your password
            </Heading>
          </Section>
          <Section>
            <Text style={{ fontSize: "15px", lineHeight: "22px", margin: "0 0 12px 0" }}>
              {intro}
            </Text>
            <Text style={{ fontSize: "15px", lineHeight: "22px", margin: "0 0 24px 0" }}>
              Click below to set a new password. This link expires in 15 minutes and can only be
              used once.
            </Text>
            <Button
              href={ctx.resetUrl}
              style={{
                backgroundColor: "#111111",
                color: "#ffffff",
                padding: "12px 20px",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Set a new password
            </Button>
            <Text style={{ fontSize: "13px", color: "#737373", margin: "24px 0 0 0" }}>
              Or paste this link into your browser: <Link href={ctx.resetUrl}>{ctx.resetUrl}</Link>
            </Text>
          </Section>
          <Hr style={{ borderColor: "#e5e5e5", margin: "24px 0" }} />
          <Section>
            <Text style={{ fontSize: "12px", color: "#737373", margin: 0 }}>
              If you didn&apos;t request this, you can safely ignore this email — your password
              won&apos;t change. The link expires in 15 minutes.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderPasswordReset(ctx: PasswordResetContext): Promise<{
  subject: string;
  html: string;
  text: string;
}> {
  const html = await render(<PasswordResetEmail ctx={ctx} />);
  const text = await render(<PasswordResetEmail ctx={ctx} />, { plainText: true });
  return {
    subject: "Reset your TableKit password",
    html,
    text,
  };
}
