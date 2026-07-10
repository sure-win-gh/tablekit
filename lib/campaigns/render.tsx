// Marketing render layer — campaign copy → channel payload.
//
// Like lib/messaging/render-message.tsx but guest-scoped (no booking).
// A smaller merge-tag set (guest first name + venue name), the same safe
// interpolation + React escaping, and the same always-applied opt-out:
// the email unsubscribe footer (via EmailLayout) and the SMS/WhatsApp
// STOP line cannot be edited away.

import "server-only";

import {
  Body,
  Button,
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
import { render } from "@react-email/render";
import type { ReactNode } from "react";

import { EmailLayout, P } from "@/lib/email/templates/_layout";
import type {
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  VenueBranding,
} from "@/lib/messaging/context";
import { ensureOptOut, findUnknownTags, interpolateTemplate } from "@/lib/messaging/merge-tags";
import type { MessageChannel } from "@/lib/messaging/registry";

import { FONT_STACKS, type CampaignBlock, type CampaignBodyDoc } from "./blocks";
import { countdownImageUrl } from "./countdown";
import { escapeHtmlValue, prepareHtmlForSend } from "./html-import";
import { appendCampaignParam } from "./links";

export type CampaignContext = {
  guestFirstName: string;
  venueName: string;
  unsubscribeUrl: string;
  branding?: VenueBranding | undefined;
  // Set on real campaign sends (not previews/test-sends): booking-surface
  // links get ?tk_c=<campaignId> appended for attribution (Phase B).
  campaignId?: string | undefined;
  // The venue's public booking page (".../book/<slug>") — the bookingCta
  // block builds its URL from this so it always points at the right
  // surface. Absent → the block renders nothing (Phase C).
  bookingUrl?: string | undefined;
  // App origin for the self-hosted countdown image endpoint (Phase C).
  appUrl?: string | undefined;
};

function bookingLink(url: string, ctx: CampaignContext): string {
  return appendCampaignParam(url, ctx.campaignId, process.env["NEXT_PUBLIC_WIDGET_URL"] ?? "");
}

const MARKETING_TAGS: Record<string, (c: CampaignContext) => string> = {
  guestFirstName: (c) => c.guestFirstName,
  venueName: (c) => c.venueName,
};

export const MARKETING_TAG_NAMES = Object.keys(MARKETING_TAGS);

function interpolate(template: string, ctx: CampaignContext): string {
  return interpolateTemplate(template, (name) => MARKETING_TAGS[name]?.(ctx));
}

export function findUnknownMarketingTags(template: string): string[] {
  return findUnknownTags(template, (name) => name in MARKETING_TAGS);
}

export type CampaignRendered =
  | { kind: "email"; rendered: RenderedEmail }
  | { kind: "sms"; rendered: RenderedSms }
  | { kind: "whatsapp"; rendered: RenderedWhatsApp };

// --- Block-doc email rendering (docs/specs/marketing-suite.md Phase A) ---
//
// All operator text flows through React elements, so it is HTML-escaped by
// construction; URLs were confined to http(s) by the zod schema at the
// boundary (lib/campaigns/blocks.ts). The unsubscribe footer comes from
// EmailLayout and is not expressible as a block — non-removable.

const DEFAULT_ACCENT = "#111111";
const DEFAULT_TEXT = "#111111";
const SPACER_PX = { s: 8, m: 16, l: 32 } as const;
const TEXT_SIZE = {
  s: { fontSize: "13px", lineHeight: "19px" },
  m: { fontSize: "15px", lineHeight: "22px" },
  l: { fontSize: "18px", lineHeight: "27px" },
} as const;
const BUTTON_RADIUS = { square: "0px", rounded: "6px", pill: "999px" } as const;

// The doc theme resolved against venue branding + platform defaults —
// what renderBlock actually consumes. Block-level fields override these.
type ResolvedTheme = {
  fontFamily: string;
  textColour: string;
  accent: string;
  radius: string;
};

function resolveTheme(doc: CampaignBodyDoc, ctx: CampaignContext): ResolvedTheme {
  const t = doc.theme ?? {};
  return {
    fontFamily: FONT_STACKS[t.font ?? "modern"],
    textColour: t.textColour ?? DEFAULT_TEXT,
    accent: t.accent ?? ctx.branding?.brandColour ?? DEFAULT_ACCENT,
    radius: BUTTON_RADIUS[t.buttonShape ?? "rounded"],
  };
}

// Limited inline syntax inside text blocks: **bold**, *italic*,
// [label](https://link). Runs AFTER merge-tag interpolation on the plain
// string; output is React nodes (escaped). Non-http(s) link targets are
// rendered as literal text rather than anchors.
const INLINE_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function renderInline(text: string, transformUrl?: (url: string) => string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={key++}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key++}>{m[2]}</em>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(
        <Link
          key={key++}
          href={transformUrl ? transformUrl(m[4]) : m[4]}
          style={{ color: "#111111", textDecoration: "underline" }}
        >
          {m[3]}
        </Link>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlock(
  block: CampaignBlock,
  ctx: CampaignContext,
  key: number,
  theme: ResolvedTheme,
): ReactNode {
  const accent = theme.accent;
  switch (block.type) {
    case "heading": {
      const text = interpolate(block.text, ctx);
      return (
        <Heading
          key={key}
          as={block.level === 1 ? "h2" : "h3"}
          style={{
            fontSize: block.level === 1 ? "22px" : "17px",
            fontWeight: 600,
            margin: "0 0 12px 0",
            color: block.colour ?? accent,
            fontFamily: theme.fontFamily,
            textAlign: block.align ?? "left",
          }}
        >
          {text}
        </Heading>
      );
    }
    case "text": {
      const text = interpolate(block.text, ctx);
      const size = TEXT_SIZE[block.size ?? "m"];
      return text.split(/\n{2,}/).map((p, i) => (
        <Text
          key={`${key}-${i}`}
          style={{
            ...size,
            margin: "0 0 12px 0",
            color: block.colour ?? theme.textColour,
            fontFamily: theme.fontFamily,
            textAlign: block.align ?? "left",
          }}
        >
          {renderInline(p, (u) => bookingLink(u, ctx))}
        </Text>
      ));
    }
    case "image": {
      const img = (
        <Img
          src={block.src}
          alt={block.alt}
          style={{
            width: `${block.widthPct}%`,
            maxWidth: "100%",
            borderRadius: "6px",
            margin: "0 0 12px 0",
          }}
        />
      );
      return block.href ? (
        <Link key={key} href={bookingLink(block.href, ctx)}>
          {img}
        </Link>
      ) : (
        <Section key={key}>{img}</Section>
      );
    }
    case "button":
      return renderCta(
        interpolate(block.label, ctx),
        bookingLink(block.url, ctx),
        block,
        theme,
        key,
      );
    case "bookingCta": {
      // URL built from the venue's own booking page + optional prefill;
      // bookingLink() then adds attribution on real sends.
      if (!ctx.bookingUrl) return null;
      let url: string;
      try {
        const u = new URL(ctx.bookingUrl);
        if (block.party) u.searchParams.set("party", String(block.party));
        if (block.date) u.searchParams.set("date", block.date);
        url = u.toString();
      } catch {
        return null;
      }
      return renderCta(interpolate(block.label, ctx), bookingLink(url, ctx), block, theme, key);
    }
    case "countdown": {
      if (!ctx.appUrl) return null;
      const targetMs = Date.parse(block.target);
      if (Number.isNaN(targetMs)) return null;
      const src = countdownImageUrl(ctx.appUrl, { targetMs, campaignId: ctx.campaignId });
      return (
        <Section key={key} style={{ margin: "4px 0 12px 0", textAlign: "center" as const }}>
          <Img
            src={src}
            alt={block.caption ?? "Countdown"}
            style={{ margin: "0 auto", maxWidth: "100%" }}
          />
          {block.caption ? (
            <P>
              <span style={{ color: "#737373", fontSize: "13px" }}>{block.caption}</span>
            </P>
          ) : null}
        </Section>
      );
    }
    case "social": {
      const links: [string, string][] = (
        [
          ["Instagram", block.instagram],
          ["Facebook", block.facebook],
          ["X", block.x],
          ["Website", block.website],
        ] as [string, string | undefined][]
      ).filter((l): l is [string, string] => Boolean(l[1]));
      if (links.length === 0) return null;
      return (
        <P key={key}>
          {links.map(([label, url], i) => (
            <span key={label}>
              {i > 0 ? <span style={{ color: "#737373" }}> · </span> : null}
              <Link href={url} style={{ color: "#111111", textDecoration: "underline" }}>
                {label}
              </Link>
            </span>
          ))}
        </P>
      );
    }
    case "divider":
      return <Hr key={key} style={{ borderColor: block.colour ?? "#e5e5e5", margin: "16px 0" }} />;
    case "spacer":
      return <Section key={key} style={{ height: `${SPACER_PX[block.size]}px` }} />;
  }
}

function renderCta(
  label: string,
  href: string,
  block: {
    style: "filled" | "outline";
    colour?: string | undefined;
    align?: "left" | "center" | undefined;
  },
  theme: ResolvedTheme,
  key: number,
): ReactNode {
  const accent = block.colour ?? theme.accent;
  const filled = block.style === "filled";
  return (
    <Section
      key={key}
      style={{ margin: "4px 0 16px 0", textAlign: (block.align ?? "left") as "left" | "center" }}
    >
      <Button
        href={href}
        style={{
          display: "inline-block",
          padding: "10px 20px",
          borderRadius: theme.radius,
          fontSize: "15px",
          fontWeight: 600,
          fontFamily: theme.fontFamily,
          textDecoration: "none",
          backgroundColor: filled ? accent : "#ffffff",
          color: filled ? "#ffffff" : accent,
          border: `1px solid ${accent}`,
        }}
      >
        {label}
      </Button>
    </Section>
  );
}

// Custom-HTML campaigns: the operator's (sanitised) HTML rendered inside
// a minimal shell whose compliance footer is OURS and unavoidable. The
// send-time pass re-sanitises + stamps tk_c; merge tags interpolate here
// with HTML-escaped values. The sanitised, .tk-content-scoped stylesheet
// (responsive @media rules from the source tool) goes into <head> — the
// scoping is what lets it style the operator's content while never being
// able to touch the footer below.
function renderCustomHtmlEmail(cleanHtml: string, subject: string, ctx: CampaignContext) {
  const { html: prepared, css } = prepareHtmlForSend(cleanHtml, {
    campaignId: ctx.campaignId,
    widgetOrigin: process.env["NEXT_PUBLIC_WIDGET_URL"] ?? "",
  });
  const interpolated = interpolateTemplate(prepared, (name) => {
    const v = MARKETING_TAGS[name]?.(ctx);
    return v === undefined ? undefined : escapeHtmlValue(v);
  });
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <Body style={{ margin: 0, padding: 0, backgroundColor: "#fafafa" }}>
        {/* Responsive rules from the import, sanitised + scoped to
            .tk-content. In the body rather than <head> (react-email's
            Head owns its children; Gmail/Apple Mail parse either). */}
        {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
        {/* Sanitised upstream (save + send passes) — never raw operator input.
            Nested inside .tk-shell so the compliance footer below is NOT a
            sibling of .tk-content: operator CSS is scoped to .tk-content (and
            its descendants), and with no sibling relationship there is no CSS
            path from it to the footer — a `.tk-content ~ *` / `.tk-content:not(x) ~ *`
            can't hide the unsubscribe link. Selector-level hardening in
            html-import.ts#scopeSelector is the second layer. */}
        <div className="tk-shell">
          <div className="tk-content" dangerouslySetInnerHTML={{ __html: interpolated }} />
        </div>
        <Container style={{ maxWidth: "560px", margin: "0 auto", padding: "16px 24px 32px" }}>
          <Text style={{ fontSize: "12px", color: "#737373", margin: "0 0 4px 0" }}>
            Sent by {ctx.venueName} via TableKit.
          </Text>
          <Text style={{ fontSize: "12px", color: "#737373", margin: 0 }}>
            <Link href={ctx.unsubscribeUrl} style={{ color: "#737373" }}>
              Unsubscribe from {ctx.venueName} emails
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderCampaign(input: {
  channel: MessageChannel;
  subject: string | null;
  body: string;
  bodyDoc?: CampaignBodyDoc | null;
  htmlBody?: string | null;
  ctx: CampaignContext;
}): Promise<CampaignRendered> {
  if (input.channel === "sms") {
    return { kind: "sms", rendered: { body: ensureOptOut(interpolate(input.body, input.ctx)) } };
  }
  if (input.channel === "whatsapp") {
    return {
      kind: "whatsapp",
      rendered: { body: ensureOptOut(interpolate(input.body, input.ctx)) },
    };
  }

  const subject = input.subject
    ? interpolate(input.subject, input.ctx)
    : `News from ${input.ctx.venueName}`;

  // Custom-HTML mode takes the whole email body; blocks/plain don't apply.
  if (input.htmlBody) {
    const el = renderCustomHtmlEmail(input.htmlBody, subject, input.ctx);
    return {
      kind: "email",
      rendered: {
        subject,
        html: await render(el),
        text: await render(el, { plainText: true }),
      },
    };
  }

  // Block-doc emails render each block; legacy plain-text campaigns keep
  // the paragraph rendering. Both live inside EmailLayout, so the branded
  // shell + unsubscribe footer are identical and unavoidable.
  const theme = input.bodyDoc ? resolveTheme(input.bodyDoc, input.ctx) : null;
  const docTheme = input.bodyDoc?.theme;

  // Operator banner replaces the venue-name header on builder emails.
  // A linked banner participates in attribution like any booking link.
  const banner = docTheme?.banner
    ? (() => {
        const img = (
          <Img
            src={docTheme.banner.src}
            alt={docTheme.banner.alt || `${input.ctx.venueName} banner`}
            style={{ width: "100%", borderRadius: "6px", margin: "0 0 16px 0" }}
          />
        );
        return docTheme.banner.href ? (
          <Link key="banner" href={bookingLink(docTheme.banner.href, input.ctx)}>
            {img}
          </Link>
        ) : (
          <Section key="banner">{img}</Section>
        );
      })()
    : null;

  const children = input.bodyDoc
    ? [banner, ...input.bodyDoc.blocks.map((b, i) => renderBlock(b, input.ctx, i, theme!))]
    : interpolate(input.body, input.ctx)
        .split(/\n{2,}/)
        .map((p, i) => <P key={i}>{p}</P>);

  const element = (
    <EmailLayout
      preview={subject}
      unsubscribeUrl={input.ctx.unsubscribeUrl}
      venueName={input.ctx.venueName}
      branding={input.ctx.branding}
      // Builder emails carry their own banner; legacy plain-text
      // campaigns keep the branded venue header.
      showVenueHeader={!input.bodyDoc}
      footerNote={docTheme?.footerText ? interpolate(docTheme.footerText, input.ctx) : undefined}
    >
      {children}
    </EmailLayout>
  );
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { kind: "email", rendered: { subject, html, text } };
}
