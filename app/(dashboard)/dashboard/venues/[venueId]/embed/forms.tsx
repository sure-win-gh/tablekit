"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";

// Click-to-copy display block. Shows the value in a monospace pre-
// like surface with a Copy button that flips to a Copied affordance
// for ~2 seconds. Multiline variant wraps the value in <pre>; single-
// line shows it inline so links + URLs stay readable on one row.

export function CopyBlock({
  value,
  ariaLabel,
  multiline,
}: {
  value: string;
  ariaLabel: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can throw in insecure contexts (HTTP, sandboxed
      // iframes). Fall back to selecting the text so the user can
      // press Cmd/Ctrl+C themselves.
      const sel = window.getSelection();
      const range = document.createRange();
      const target = document.getElementById(`copy-${ariaLabel.replace(/\s+/g, "-")}`);
      if (target) {
        range.selectNodeContents(target);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <pre
          id={`copy-${ariaLabel.replace(/\s+/g, "-")}`}
          aria-label={ariaLabel}
          className="rounded-card border-hairline bg-cloud text-ink flex-1 overflow-x-auto border px-4 py-3 text-xs"
        >
          {value}
        </pre>
      ) : (
        <code
          id={`copy-${ariaLabel.replace(/\s+/g, "-")}`}
          aria-label={ariaLabel}
          className="rounded-card border-hairline bg-cloud text-ink flex-1 overflow-x-auto border px-4 py-3 text-xs"
        >
          {value}
        </code>
      )}
      <Button variant="secondary" size="sm" onClick={onCopy} aria-label="Copy to clipboard">
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" aria-hidden /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
          </>
        )}
      </Button>
    </div>
  );
}
