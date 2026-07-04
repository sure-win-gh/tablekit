"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// Pulls fresh server data every `intervalMs` (default 30s) by calling
// router.refresh(). RSC re-runs, the client cache invalidates, and
// the booking-status overlay updates. Pauses while the tab is hidden
// so we don't burn CPU + DB calls on background tabs.
//
// `paused` (edit mode): a refresh mid-drag would revert an optimistic
// position while its save is in flight, and the side panel's edit form
// is keyed on position — so it could reset under the operator's
// fingers. Pausing while editing and refreshing once on exit keeps the
// canvas stable exactly when hands are on it.

export function AutoRefresh({
  intervalMs = 30_000,
  paused = false,
}: {
  intervalMs?: number;
  paused?: boolean;
}) {
  const router = useRouter();
  // Distinguishes "leaving edit mode" (refresh immediately — the pause
  // may have accumulated stale colours) from plain mount (the RSC just
  // rendered; refreshing again would double-fetch).
  const wasPaused = useRef(false);

  useEffect(() => {
    if (paused) {
      wasPaused.current = true;
      return;
    }

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

    if (wasPaused.current) {
      wasPaused.current = false;
      // Only when visible — the visibilitychange handler below already
      // refreshes on hidden → visible, so refreshing here too would
      // double-fetch (and contradict the pause-while-hidden contract).
      if (!document.hidden) router.refresh();
    }
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
  }, [router, intervalMs, paused]);

  return null;
}
