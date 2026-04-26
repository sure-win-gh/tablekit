// CSV serialiser for report exports.
//
// RFC 4180 with two opinions:
//   1. UTF-8 BOM prepended so Excel renders £ / é / etc correctly
//      without the user having to know about Data → From Text → 65001.
//   2. CRLF line endings, also per RFC.
//
// Values are normalised to strings here. Dates → ISO string; numbers
// → String(). Nulls / undefined → empty string. The caller decides
// presentation (e.g. minor units → "12.50") via the column's `value`
// fn before the value reaches us.

const BOM = "﻿";
const QUOTE = '"';
const NEEDS_ESCAPE = /[",\r\n]/;

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | Date | null | undefined;
};

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escape(c.header)).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => escape(stringify(c.value(row)))).join(","),
  );
  return BOM + [headerLine, ...dataLines].join("\r\n") + "\r\n";
}

function stringify(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function escape(s: string): string {
  if (!NEEDS_ESCAPE.test(s)) return s;
  return QUOTE + s.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
}
