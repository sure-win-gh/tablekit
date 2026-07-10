// Shared layout for transactional emails. Branded plain-shell —
// neutral palette, single-column container, no images. The brand
// polish pass (Track B in the roadmap) will replace this with the
// finished design system.

import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";

import type { VenueBranding } from "@/lib/messaging/context";

// Accent colour applied to the heading. Falls back to the neutral ink
// when the venue hasn't set one. We only accept a hex value (validated
// at the settings boundary) so this can't inject arbitrary CSS.
const DEFAULT_HEADING = "#111111";

export function EmailLayout({
  preview,
  children,
  unsubscribeUrl,
  venueName,
  branding,
  showVenueHeader = true,
  footerNote,
}: {
  preview: string;
  children: ReactNode;
  unsubscribeUrl: string;
  venueName: string;
  branding?: VenueBranding | undefined;
  // Campaign builder emails hide the logo + venue-name header — the
  // operator designs their own banner instead. Transactional emails
  // (confirmations/reminders) keep it: guests should instantly recognise
  // who a booking email is from. The compliance footer below is shared
  // and NOT optional on any path.
  showVenueHeader?: boolean;
  // Operator footer copy (venue address, contact, opening hours) shown
  // above the unsubscribe line. Plain text; newlines preserved.
  footerNote?: string | undefined;
}) {
  const headingColour = branding?.brandColour || DEFAULT_HEADING;
  const logoUrl = branding?.logoUrl || null;
  const signature = branding?.signature || null;
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
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
          {showVenueHeader ? (
            <Section>
              {logoUrl ? (
                <Img
                  src={logoUrl}
                  alt={venueName}
                  style={{ maxHeight: "48px", margin: "0 0 16px 0" }}
                />
              ) : null}
              <Heading
                as="h1"
                style={{
                  fontSize: "20px",
                  fontWeight: 600,
                  margin: "0 0 16px 0",
                  color: headingColour,
                }}
              >
                {venueName}
              </Heading>
            </Section>
          ) : null}
          <Section>{children}</Section>
          {signature ? (
            <Section>
              <Text style={{ fontSize: "15px", lineHeight: "22px", margin: "12px 0 0 0" }}>
                {signature}
              </Text>
            </Section>
          ) : null}
          <Hr style={{ borderColor: "#e5e5e5", margin: "24px 0" }} />
          <Section>
            {footerNote ? (
              <Text
                style={{
                  fontSize: "12px",
                  color: "#737373",
                  margin: "0 0 8px 0",
                  whiteSpace: "pre-line" as const,
                }}
              >
                {footerNote}
              </Text>
            ) : null}
            <Text style={{ fontSize: "12px", color: "#737373", margin: "0 0 4px 0" }}>
              Sent by {venueName} via TableKit.
            </Text>
            <Text style={{ fontSize: "12px", color: "#737373", margin: 0 }}>
              <Link href={unsubscribeUrl} style={{ color: "#737373" }}>
                Unsubscribe from {venueName} emails
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: "15px",
        lineHeight: "22px",
        margin: "0 0 12px 0",
        color: "#111111",
      }}
    >
      {children}
    </Text>
  );
}
