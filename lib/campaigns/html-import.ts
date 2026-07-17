// Custom-HTML campaign emails — the sanitisation pipeline
// (docs/specs/custom-email-html.md Phase 2).
//
// Operator-pasted HTML (Canva Email export, BeeFree, agency templates) is
// UNTRUSTED. Everything here is allowlist-based:
//   - tags: table layout + text + img/a only; script/style/iframe/form/
//     svg/object and all on* handlers never survive; comments (including
//     MSO conditionals, v1 scope decision) are dropped.
//   - URLs: http(s) for images; http(s)/mailto/tel for links; nothing
//     protocol-relative.
//   - inline styles: per-property regex allowlist. The generic value
//     pattern excludes `:` `;` quotes and angle brackets, which kills
//     url(...), javascript:, expression-with-imports etc. wholesale;
//     background-image is separately allowed ONLY as url(https://...),
//     and font-family separately allows quotes.
//   - size: hard reject > 300 KB post-sanitise; warn > 100 KB (Gmail
//     clips around 102 KB).
//
// Two passes: sanitise at SAVE (store only clean HTML), and again at
// SEND via prepareHtmlForSend — defence in depth (jsonb/text columns are
// untrusted on read), plus that's where booking links gain ?tk_c= and
// merge tags interpolate with HTML-escaped values.

import "server-only";

import { Buffer } from "node:buffer";

import postcss, { type Root } from "postcss";
import sanitizeHtml from "sanitize-html";

import { appendCampaignParam } from "./links";

export const MAX_HTML_BYTES = 300_000;
export const WARN_HTML_BYTES = 100_000;
// Pre-parse cap so a pathological paste can't stall the parser.
const MAX_RAW_BYTES = 600_000;

const ALLOWED_TAGS = [
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "div",
  "p",
  "span",
  "a",
  "img",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "sup",
  "sub",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "center",
  "font",
];

// Generic style value: letters, digits, #, (), commas, dots, %, spaces,
// slashes, hyphens, !important. NO colon/semicolon/quotes/angle brackets
// → url(), javascript:, @import and friends cannot be expressed. The
// lookahead additionally bans expression()/behavior() (colon-free vectors).
const SAFE_VALUE = /^(?!.*(?:expression|behavior|@import|url\s*\())[a-zA-Z0-9#(),.%\s/\-!]+$/i;
// font-family additionally needs quotes.
const FONT_VALUE = /^(?!.*(?:expression|behavior|@import|url\s*\())[a-zA-Z0-9,'"\s\-]+$/i;
// background-image: https images only, nothing else.
const HTTPS_URL_VALUE = /^url\(\s*['"]?https:\/\/[^'"()<>\s]+['"]?\s*\)$/i;

const STYLE_PROPS = [
  "color",
  "background",
  "background-color",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "width",
  "max-width",
  "min-width",
  "height",
  "max-height",
  "min-height",
  "display",
  "vertical-align",
  "white-space",
  "word-break",
  "overflow",
  "opacity",
  "table-layout",
  "box-sizing",
  "float",
  "clear",
] as const;

const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  "*": {
    ...Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_VALUE]])),
    "font-family": [FONT_VALUE],
    "background-image": [HTTPS_URL_VALUE],
  },
};

const BASE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    // class/id are safe to keep: they only *select*, and the only CSS that
    // can ever target them is our postcss-sanitised, .tk-content-scoped
    // stylesheet below — this is what keeps imported emails responsive.
    "*": [
      "style",
      "class",
      "id",
      "align",
      "valign",
      "width",
      "height",
      "bgcolor",
      "border",
      "cellpadding",
      "cellspacing",
      "dir",
      "lang",
      "role",
      "aria-hidden",
    ],
    a: ["href", "target", "title", "style", "class", "align"],
    img: ["src", "alt", "width", "height", "title", "style", "class", "align", "border"],
    font: ["color", "face", "size"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  allowedStyles: ALLOWED_STYLES,
  disallowedTagsMode: "discard",
  // script/style/textarea contents are discarded outright (sanitize-html
  // default nonTextTags) rather than leaking as text.
};

// --- CSS sanitisation (responsive rules from <style> blocks) ----------------
//
// Canva/BeeFree exports put their mobile stacking rules in <style> media
// queries, so dropping them breaks phones — the most-read surface. Instead
// we parse the CSS with postcss and keep it under three constraints:
//   1. only plain rules + @media survive (@import/@font-face/etc. dropped);
//   2. every declaration passes the same property/value allowlist as
//      inline styles (no url() exfil, no expression());
//   3. every selector is scoped under `.tk-content`, the wrapper around
//      the operator's HTML — so pasted CSS can style THEIR content but can
//      never touch our compliance footer (e.g. `p { display:none }`
//      becomes `.tk-content p`). html/body selectors map to the wrapper.

export const MAX_CSS_BYTES = 50_000;
const SCOPE = ".tk-content";
const CSS_PROPS = new Set<string>(STYLE_PROPS);

// Scopes one operator selector under `.tk-content`, or returns null if it
// escapes that subtree. Descendant (space) and child (`>`) combinators keep
// matches inside the wrapper; a SIBLING combinator (`~`/`+`) glued to the
// scope root does not — the compliance footer is a DOM sibling of
// `.tk-content`, so `.tk-content ~ *` (or a bare `~ *`, which we'd otherwise
// prefix into the same thing) would reach out and hide the unsubscribe link.
// Deeper sibling combinators (`.tk-content .a ~ .b`) stay inside the subtree
// and are allowed. Null rules are dropped by the caller (honest warning).
function scopeSelector(sel: string): string | null {
  let t = sel.trim();
  if (!t) return SCOPE;
  // Normalise away CSS comments first: a mail client reads `.tk-content/**/~ *`
  // as `.tk-content ~ *` (comment = whitespace), so the combinator checks below
  // must see through comments too, not just literal whitespace.
  t = t.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!t) return SCOPE;
  // A selector relative to the scope root can't legitimately lead with a
  // combinator — strip any leading `> ~ +` so `~ *` can't be prefixed into
  // an escaping `.tk-content ~ *`.
  t = t.replace(/^[>~+\s]+/, "").trim();
  if (!t) return SCOPE;
  if (t.startsWith(SCOPE)) {
    // Exact scope-root token only. `.tk-content-x` / `.tk-contentfoo` are
    // DIFFERENT classes that merely share the prefix — treat them as operator
    // selectors and prefix them (so they scope as descendants), never pass
    // through as if rooted at our wrapper.
    const after = t.slice(SCOPE.length);
    if (!/^[\w-]/.test(after)) {
      // Genuinely rooted at .tk-content (already-scoped send-pass re-run, or a
      // compound on the wrapper). Reject a sibling combinator fused to the
      // root that would reach past the wrapper to the footer.
      return /^\s*[~+]/.test(after) ? null : t;
    }
  }
  const stripped = t.replace(/^(html|body)\b\s*/i, "").trim();
  return stripped ? `${SCOPE} ${stripped}` : SCOPE;
}

function safeStyleValue(prop: string, value: string): boolean {
  if (prop === "font-family") return FONT_VALUE.test(value);
  if (prop === "background-image") return HTTPS_URL_VALUE.test(value);
  return SAFE_VALUE.test(value);
}

// Returns the sanitised stylesheet plus whether anything was removed (so
// the operator gets an honest warning rather than silent degradation).
export function sanitizeCss(rawCss: string): { css: string; dropped: boolean } {
  let dropped = false;
  let root: Root;
  try {
    root = postcss.parse(rawCss);
  } catch {
    return { css: "", dropped: true };
  }

  root.walkAtRules((at) => {
    if (at.name.toLowerCase() !== "media") {
      dropped = true;
      at.remove();
    }
  });
  root.walkComments((c) => {
    c.remove();
  });
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase().trim();
    if (!CSS_PROPS.has(prop) && prop !== "font-family" && prop !== "background-image") {
      dropped = true;
      decl.remove();
      return;
    }
    if (!safeStyleValue(prop, decl.value)) {
      dropped = true;
      decl.remove();
    }
  });
  root.walkRules((rule) => {
    if (rule.nodes.length === 0) {
      rule.remove();
      return;
    }
    const scoped = rule.selectors.map(scopeSelector);
    if (scoped.some((s) => s === null)) dropped = true;
    const kept = scoped.filter((s): s is string => s !== null);
    if (kept.length === 0) {
      rule.remove();
      return;
    }
    rule.selectors = kept;
  });
  root.walkAtRules((at) => {
    if (at.nodes && at.nodes.length === 0) at.remove();
  });

  let css = root.toString().trim();
  if (Buffer.byteLength(css, "utf8") > MAX_CSS_BYTES) {
    dropped = true;
    css = ""; // a stylesheet that big is hostile or broken — all-or-nothing
  }
  return { css, dropped };
}

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

function extractCss(rawHtml: string): { css: string; rest: string; had: boolean } {
  const parts: string[] = [];
  const rest = rawHtml.replace(STYLE_BLOCK_RE, (_, inner: string) => {
    parts.push(inner);
    return "";
  });
  return { css: parts.join("\n"), rest, had: parts.length > 0 };
}

export type SanitizeResult =
  | { ok: true; html: string; css: string; bytes: number; warnings: string[] }
  | { ok: false; error: string };

export function sanitizeCampaignHtml(raw: string): SanitizeResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Paste some HTML first." };
  if (Buffer.byteLength(trimmed, "utf8") > MAX_RAW_BYTES) {
    return { ok: false, error: "That HTML is too large to import (over 600KB)." };
  }

  const warnings: string[] = [];
  if (/<!--\[if/i.test(trimmed)) {
    warnings.push("Outlook conditional comments were removed.");
  }

  const { css: rawCss, rest, had: hadStyles } = extractCss(trimmed);
  const { css, dropped } = hadStyles ? sanitizeCss(rawCss) : { css: "", dropped: false };
  if (hadStyles && css && !dropped) {
    // Nothing to warn about — responsive rules kept intact.
  } else if (hadStyles && css && dropped) {
    warnings.push(
      "Responsive styles were kept, but some style rules couldn't be imported safely and were removed — check the phone preview.",
    );
  } else if (hadStyles && !css) {
    warnings.push(
      "The email's <style> rules couldn't be imported safely and were removed — check the phone preview for layout issues.",
    );
  }

  const html = sanitizeHtml(rest, BASE_OPTIONS).trim();
  if (!html) return { ok: false, error: "Nothing renderable survived — is that an HTML email?" };

  const bytes = Buffer.byteLength(html, "utf8") + Buffer.byteLength(css, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    return {
      ok: false,
      error: `The email is ${(bytes / 1024).toFixed(0)}KB after cleaning — over the ${(MAX_HTML_BYTES / 1024).toFixed(0)}KB limit. Trim images/sections in the source tool.`,
    };
  }
  if (bytes > WARN_HTML_BYTES) {
    warnings.push(
      `The email is ${(bytes / 1024).toFixed(0)}KB — Gmail clips messages over ~102KB, hiding the end (and the unsubscribe link view). Consider trimming it.`,
    );
  }
  if (!/<img[\s>]/i.test(html) && html.length < 200) {
    warnings.push("This looks very sparse — double-check the preview.");
  }

  return { ok: true, html, css, bytes, warnings };
}

// Combined storage form for campaigns.html_body: the sanitised stylesheet
// travels with the body markup as a leading <style> block. Both send-time
// and render paths split + re-sanitise it, so the style block never
// reaches sanitize-html (which would drop it) and never reaches the email
// unfiltered.
export function combineHtml(parts: { html: string; css: string }): string {
  return parts.css ? `<style>${parts.css}</style>\n${parts.html}` : parts.html;
}

// Send-time pass: split the stored combined form, re-sanitise BOTH halves
// (defence in depth — columns are untrusted on read), and rewrite
// booking-surface links with ?tk_c= so attribution works for custom HTML
// exactly like the builder. Merge tags are interpolated by the caller
// AFTER this, with escaped values (escapeHtmlValue below).
export function prepareHtmlForSend(
  stored: string,
  opts: { campaignId?: string | undefined; widgetOrigin: string },
): { html: string; css: string } {
  const { css: rawCss, rest, had } = extractCss(stored);
  const css = had ? sanitizeCss(rawCss).css : "";
  const html = sanitizeHtml(rest, {
    ...BASE_OPTIONS,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: attribs["href"]
          ? {
              ...attribs,
              href: appendCampaignParam(attribs["href"], opts.campaignId, opts.widgetOrigin),
            }
          : attribs,
      }),
    },
  }).trim();
  return { html, css };
}

// Escape a merge-tag VALUE before it's spliced into HTML — guest names
// are operator-DB strings and must never introduce markup.
export function escapeHtmlValue(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Plain-text projection of sanitised HTML — fills campaigns.body and the
// text MIME part fallback.
export function htmlToPlainText(cleanHtml: string): string {
  return sanitizeHtml(cleanHtml, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
