// Re-export the generic RFC 4180 CSV serialiser. Keeps admin code
// from reaching into lib/reports/* directly so the import-allowlist
// boundary stays visible.

export { toCsv, type CsvColumn } from "@/lib/reports/csv";
