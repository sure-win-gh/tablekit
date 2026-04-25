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
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";

export function EmailLayout({
  preview,
  children,
  unsubscribeUrl,
  venueName,
}: {
  preview: string;
  children: ReactNode;
  unsubscribeUrl: string;
  venueName: string;
}) {
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
          <Section>
            <Heading
              as="h1"
              style={{
                fontSize: "20px",
                fontWeight: 600,
                margin: "0 0 16px 0",
                color: "#111111",
              }}
            >
              {venueName}
            </Heading>
          </Section>
          <Section>{children}</Section>
          <Hr style={{ borderColor: "#e5e5e5", margin: "24px 0" }} />
          <Section>
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
