"use client";

// Realtime email preview for the block builder (Kit-style split pane).
// Debounces the doc/subject into the existing previewCampaign server
// action (the REAL renderer — branding, merge tags, unsubscribe footer),
// so what the operator sees is exactly what sends. Device toggle switches
// the iframe viewport between desktop and phone widths.

import { Monitor, Smartphone } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CampaignBodyDoc } from "@/lib/campaigns/blocks";

import { previewCampaign } from "./actions";

const DEBOUNCE_MS = 450;

type Rendered = { key: string; html: string; subject: string; unknownTags: string[] };

export function LivePreview({
  venueId,
  subject,
  bodyDoc,
}: {
  venueId: string;
  subject: string;
  bodyDoc: CampaignBodyDoc | null;
}) {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  // Monotonic guard: a slow early response must never clobber a newer one.
  const seq = useRef(0);

  const docKey = useMemo(() => JSON.stringify({ subject, bodyDoc }), [subject, bodyDoc]);

  useEffect(() => {
    if (!bodyDoc) return; // placeholder derives from bodyDoc at render time
    const mySeq = ++seq.current;
    const key = docKey;
    const t = setTimeout(async () => {
      const r = await previewCampaign({ venueId, channel: "email", subject, body: "", bodyDoc });
      if (seq.current !== mySeq) return; // superseded
      if (r.ok && r.kind === "email") {
        setRendered({ key, html: r.html, subject: r.subject, unknownTags: r.unknownTags });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docKey covers subject+bodyDoc
  }, [venueId, docKey]);

  // "updating" is derived: we have a doc whose render hasn't landed yet.
  const updating = bodyDoc !== null && rendered?.key !== docKey;
  const showPreview = bodyDoc !== null && rendered !== null;

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
              onClick={() => setDevice(d)}
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
      </div>

      {rendered && rendered.unknownTags.length > 0 ? (
        <p className="text-xs text-amber-600">
          Unrecognised tags: {rendered.unknownTags.join(", ")}
        </p>
      ) : null}

      <div className="border-hairline bg-cloud overflow-hidden rounded-lg border">
        {showPreview && rendered ? (
          <>
            <p className="border-hairline text-charcoal truncate border-b bg-white px-3 py-2 text-xs">
              <span className="text-ash">Subject:</span>{" "}
              <span className="font-medium">{rendered.subject}</span>
            </p>
            <div
              className={`mx-auto transition-[max-width] duration-200 ${device === "mobile" ? "max-w-[375px]" : "max-w-full"}`}
            >
              <iframe
                title="Email preview"
                srcDoc={rendered.html}
                sandbox=""
                className={`h-[560px] w-full bg-white transition-opacity ${updating ? "opacity-60" : "opacity-100"}`}
              />
            </div>
          </>
        ) : (
          <div className="text-ash flex h-[560px] items-center justify-center p-6 text-center text-sm">
            Add a block with some content and your email appears here as guests will see it.
          </div>
        )}
      </div>
    </div>
  );
}
