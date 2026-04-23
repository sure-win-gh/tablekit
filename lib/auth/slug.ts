// Slug generation for organisations. We always append a short random
// suffix so new signups never collide on a previously-taken base
// (poor UX for the loser of the race) and so sequential signups with
// the same business name don't require retry logic.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function makeOrgSlug(name: string): string {
  const base = slugify(name) || "org";
  const suffix = crypto.randomUUID().slice(0, 4);
  return `${base}-${suffix}`;
}
