// Shared normalisation for header / candidate-name matching across
// the import pipeline. Lowercase + drop everything that isn't
// a-z/0-9 so "First Name", "first_name", "FIRST-NAME" all collapse
// to the same key.
//
// Lives in its own module so suggest-mapping.ts and sources/index.ts
// can't drift — duplicated copies were marked with a "keep these in
// sync" comment, which is exactly the smell this file removes.

export function normaliseHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
