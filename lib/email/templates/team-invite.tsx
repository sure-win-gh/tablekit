// Team invitation email. Operational — sent to the invitee's email
// from the org owner. Doesn't share EmailLayout (which is venue-
// branded) because the invite chrome is "TableKit + organisation",
// not a guest-facing venue mailing.

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

import type { OrgRole } from "@/lib/auth/role-level";

export type TeamInviteContext = {
  organisationName: string;
  invitedByName: string | null;
  role: OrgRole;
  acceptUrl: string;
  expiresAtIso: string;
};

function TeamInviteEmail({ ctx }: { ctx: TeamInviteContext }) {
  const inviter = ctx.invitedByName ?? "An owner";
  return (
    <Html>
      <Head />
      <Preview>{`You've been invited to ${ctx.organisationName} on TableKit`}</Preview>
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
            <Heading
              as="h1"
              style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 16px 0" }}
            >
              Join {ctx.organisationName} on TableKit
            </Heading>
          </Section>
          <Section>
            <Text style={{ fontSize: "15px", lineHeight: "22px", margin: "0 0 12px 0" }}>
              {inviter} has invited you to join <strong>{ctx.organisationName}</strong> as a{" "}
              <strong>{ctx.role}</strong>.
            </Text>
            <Text style={{ fontSize: "15px", lineHeight: "22px", margin: "0 0 24px 0" }}>
              Accept this invite within 72 hours to set up your account.
            </Text>
            <Button
              href={ctx.acceptUrl}
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
              Accept invitation
            </Button>
            <Text style={{ fontSize: "13px", color: "#737373", margin: "24px 0 0 0" }}>
              Or paste this link into your browser: <Link href={ctx.acceptUrl}>{ctx.acceptUrl}</Link>
            </Text>
          </Section>
          <Hr style={{ borderColor: "#e5e5e5", margin: "24px 0" }} />
          <Section>
            <Text style={{ fontSize: "12px", color: "#737373", margin: 0 }}>
              If you weren&apos;t expecting this email, you can safely ignore it. The invite expires on{" "}
              {ctx.expiresAtIso}.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderTeamInvite(ctx: TeamInviteContext): Promise<{
  subject: string;
  html: string;
  text: string;
}> {
  const html = await render(<TeamInviteEmail ctx={ctx} />);
  const text = await render(<TeamInviteEmail ctx={ctx} />, { plainText: true });
  return {
    subject: `You've been invited to ${ctx.organisationName} on TableKit`,
    html,
    text,
  };
}
