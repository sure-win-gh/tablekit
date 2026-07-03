"use client";

// Mobile-only sticky "Book a table" bar. Appears once the booking card
// (#book) has scrolled out of view so the primary action is never more
// than a thumb-tap away — TheFork's core mobile pattern. Hidden on
// lg+ where the booking card is sticky in the right column anyway.

import { useEffect, useState } from "react";

export function BookBar() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const target = document.getElementById("book");
    if (!target || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setShow(!e.isIntersecting);
      },
      { rootMargin: "-56px 0px 0px 0px" },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, []);

  if (!show) return null;
  return (
    <div className="border-hairline fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 p-3 backdrop-blur-sm lg:hidden">
      <a
        href="#book"
        className="bg-ink block w-full rounded-full py-3 text-center text-sm font-bold text-white"
      >
        Book a table — free
      </a>
    </div>
  );
}
