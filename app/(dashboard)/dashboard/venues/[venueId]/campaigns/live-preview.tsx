"use client";

// Realtime email preview for the block builder (Kit-style split pane).
// Debounces the doc/subject into the existing previewCampaign server
// action (the REAL renderer — branding, merge tags, unsubscribe footer),
// so what the operator sees is exactly what sends.
//
// Width honesty: the split-pane column is narrower than a real desktop
// email viewport, which would fire imported @media (max-width:600px)
// rules and make the "desktop" preview render mobile. So the inline
// preview always renders the iframe at a TRUE device width (640px
// desktop / 375px phone) and visually scales it down to fit the column —
// media queries behave exactly as they will in the inbox. The fullscreen
// mode shows the same at 1:1.

import { Maximize2, Monitor, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CampaignBodyDoc } from "@/lib/campaigns/blocks";

import { previewCampaign } from "./actions";

const DEBOUNCE_MS = 450;
// Genuine viewport widths: 640px is a typical desktop email pane (above
// the common 600px breakpoint); 375px is a standard phone.
const DEVICE_W = { desktop: 640, mobile: 375 } as const;
const INLINE_H = 560;

type Device = keyof typeof DEVICE_W;

type Rendered = {
  key: string;
  html: string;
  subject: string;
  unknownTags: string[];
  htmlWarnings: string[];
  error: string | null;
};

// The iframe at a true device width, scaled to fit its container so
// media queries fire (or don't) exactly as in a real client.
function DeviceFrame({
  html,
  device,
  dimmed,
  heightPx,
}: {
  html: string;
  device: Device;
  dimmed: boolean;
  heightPx: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const deviceW = DEVICE_W[device];

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / deviceW));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deviceW]);

  return (
    <div ref={wrapRef} className="flex justify-center overflow-hidden" style={{ height: heightPx }}>
      <div
        style={{
          width: deviceW * scale,
          height: heightPx,
          overflow: "hidden",
        }}
      >
        <iframe
          title="Email preview"
          srcDoc={html}
          sandbox=""
          style={{
            width: deviceW,
            height: heightPx / scale,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            border: 0,
          }}
          className={`bg-white transition-opacity ${dimmed ? "opacity-60" : "opacity-100"}`}
        />
      </div>
    </div>
  );
}

function DeviceToggle({ device, onChange }: { device: Device; onChange: (d: Device) => void }) {
  return (
    <div className="border-hairline flex gap-0.5 rounded-md border p-0.5">
      {(
        [
          ["desktop", Monitor, "Desktop preview"],
          ["mobile", Smartphone, "Phone preview"],
        ] as const
      ).map(([d, Icon, label]) => (
        <button
          key={d}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={device === d}
          onClick={() => onChange(d)}
          className={
            device === d
              ? "bg-ink rounded p-1.5 text-white"
              : "text-ash hover:text-charcoal rounded p-1.5"
          }
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

export function LivePreview({
  venueId,
  subject,
  bodyDoc,
  htmlBody = null,
}: {
  venueId: string;
  subject: string;
  bodyDoc: CampaignBodyDoc | null;
  // Custom-HTML mode: the raw paste (sanitised server-side per preview).
  htmlBody?: string | null;
}) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  // Monotonic guard: a slow early response must never clobber a newer one.
  const seq = useRef(0);

  const hasContent = bodyDoc !== null || Boolean(htmlBody && htmlBody.trim());
  const docKey = useMemo(
    () => JSON.stringify({ subject, bodyDoc, htmlBody }),
    [subject, bodyDoc, htmlBody],
  );

  useEffect(() => {
    if (!hasContent) return; // placeholder derives from content at render time
    const mySeq = ++seq.current;
    const key = docKey;
    const t = setTimeout(async () => {
      const r = await previewCampaign({
        venueId,
        channel: "email",
        subject,
        body: "",
        ...(bodyDoc ? { bodyDoc } : {}),
        ...(htmlBody && htmlBody.trim() ? { htmlBody } : {}),
      });
      if (seq.current !== mySeq) return; // superseded
      if (r.ok && r.kind === "email") {
        setRendered({
          key,
          html: r.html,
          subject: r.subject,
          unknownTags: r.unknownTags,
          htmlWarnings: r.htmlWarnings ?? [],
          error: null,
        });
      } else if (!r.ok) {
        // Surface sanitiser rejections (bad paste, too large) in place.
        setRendered({
          key,
          html: "",
          subject: "",
          unknownTags: [],
          htmlWarnings: [],
          error: r.message,
        });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docKey covers subject+bodyDoc+htmlBody
  }, [venueId, docKey]);

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // "updating" is derived: we have content whose render hasn't landed yet.
  const updating = hasContent && rendered?.key !== docKey;
  const showPreview = hasContent && rendered !== null && !rendered.error && rendered.html !== "";

  return (
    <div className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-4 lg:self-start">
      <div className="flex items-center justify-between">
        <p className="text-ash text-xs font-semibold tracking-wide uppercase">
          Live preview
          <span
            aria-live="polite"
            className={`ml-2 font-normal normal-case transition-opacity ${updating ? "opacity-100" : "opacity-0"}`}
          >
            updating…
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <DeviceToggle device={device} onChange={setDevice} />
          <button
            type="button"
            title="Full-screen preview"
            aria-label="Full-screen preview"
            onClick={() => setFullscreen(true)}
            disabled={!showPreview}
            className="border-hairline text-ash hover:text-charcoal rounded-md border p-1.5 disabled:opacity-40"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {rendered && rendered.unknownTags.length > 0 ? (
        <p className="text-xs text-amber-600">
          Unrecognised tags: {rendered.unknownTags.join(", ")}
        </p>
      ) : null}
      {rendered && rendered.htmlWarnings.length > 0
        ? rendered.htmlWarnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600">
              {w}
            </p>
          ))
        : null}
      {rendered?.error ? (
        <p role="alert" className="text-xs text-red-600">
          {rendered.error}
        </p>
      ) : null}

      <div className="border-hairline bg-cloud overflow-hidden rounded-lg border">
        {showPreview && rendered ? (
          <>
            <p className="border-hairline text-charcoal truncate border-b bg-white px-3 py-2 text-xs">
              <span className="text-ash">Subject:</span>{" "}
              <span className="font-medium">{rendered.subject}</span>
            </p>
            <DeviceFrame
              html={rendered.html}
              device={device}
              dimmed={updating}
              heightPx={INLINE_H}
            />
          </>
        ) : (
          <div className="text-ash flex h-[560px] items-center justify-center p-6 text-center text-sm">
            Add a block with some content and your email appears here as guests will see it.
          </div>
        )}
      </div>
      {showPreview ? (
        <p className="text-ash text-xs">
          Shown at true {device === "desktop" ? "desktop (640px)" : "phone (375px)"} width, scaled
          to fit — use{" "}
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="underline underline-offset-2"
          >
            full screen
          </button>{" "}
          for actual size.
        </p>
      ) : null}

      {fullscreen && rendered ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Full-screen email preview"
          className="fixed inset-0 z-50 flex flex-col bg-black/60 p-4 sm:p-8"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-hairline flex items-center justify-between gap-3 border-b px-4 py-2.5">
              <p className="text-charcoal min-w-0 truncate text-sm">
                <span className="text-ash">Subject:</span>{" "}
                <span className="font-medium">{rendered.subject}</span>
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <DeviceToggle device={device} onChange={setDevice} />
                <button
                  type="button"
                  title="Close (Esc)"
                  aria-label="Close full-screen preview"
                  onClick={() => setFullscreen(false)}
                  className="border-hairline text-ash hover:text-charcoal rounded-md border p-1.5"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
            <div className="bg-cloud flex-1 overflow-auto p-4">
              <iframe
                title="Email preview (full screen)"
                srcDoc={rendered.html}
                sandbox=""
                style={{ width: DEVICE_W[device], border: 0 }}
                className="mx-auto block h-full min-h-full bg-white shadow-sm"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
