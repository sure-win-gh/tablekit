// Sticky in-page section nav (Core+), TheFork-style. Server component —
// plain anchor links + position:sticky, no client JS. "Menu" is an
// external link-out when the operator has set profile.menuUrl.

const LINK = "text-ash hover:text-ink px-3 py-2.5 text-sm font-semibold transition";

export function AnchorNav({
  hasAbout,
  hasReviews,
  hasPhotos,
  hasFaq,
  menuUrl,
}: {
  hasAbout: boolean;
  hasReviews: boolean;
  hasPhotos: boolean;
  hasFaq: boolean;
  menuUrl: string | null;
}) {
  return (
    <nav
      aria-label="Page sections"
      className="border-hairline sticky top-0 z-30 -mx-6 border-b bg-white/95 px-6 backdrop-blur-sm"
    >
      <div className="flex items-center gap-1 overflow-x-auto">
        <a
          href="#book"
          className="text-ink border-ink -mb-px border-b-2 px-3 py-2.5 text-sm font-bold"
        >
          Book
        </a>
        {hasAbout ? (
          <a href="#about" className={LINK}>
            About
          </a>
        ) : null}
        {menuUrl ? (
          <a href={menuUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
            Menu ↗
          </a>
        ) : null}
        {hasReviews ? (
          <a href="#reviews" className={LINK}>
            Reviews
          </a>
        ) : null}
        {hasPhotos ? (
          <a href="#photos" className={LINK}>
            Photos
          </a>
        ) : null}
        {hasFaq ? (
          <a href="#faq" className={LINK}>
            FAQ
          </a>
        ) : null}
      </div>
    </nav>
  );
}
