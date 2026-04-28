"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Pulls fresh server data every `intervalMs` (default 30s) by calling
// router.refresh(). RSC re-runs, the client cache invalidates, and
// the booking-status overlay updates. Pauses while the tab is hidden
// so we don't burn CPU + DB calls on background tabs.

export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    if (!document.hidden) start();

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        router.refresh();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
