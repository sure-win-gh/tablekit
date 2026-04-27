// CSV serialiser for report + data exports.
//
// RFC 4180 with three opinions:
//   1. UTF-8 BOM prepended so Excel renders £ / é / etc correctly
//      without the user having to know about Data → From Text → 65001.
//   2. CRLF line endings, also per RFC.
//   3. Formula-injection guard: a string cell beginning with =, +, -,
//      @, tab, or CR is prefixed with a leading apostrophe so Excel /
//      Sheets / Numbers treat it as text. The guard only fires for
//      string-typed values — numeric values (party_size, amount_minor,
//      negative refund totals) stay numeric and remain summable.
//      Without this, a guest who typed `=HYPERLINK("…", "click")` as
//      a first name would weaponise every export the operator opened.
//
// Values are normalised to strings here. Dates → ISO string; numbers
// → String(). Nulls / undefined → empty string. The caller decides
// presentation (e.g. minor units → "12.50") via the column's `value`
// fn before the value reaches us.

const BOM = "﻿";
const QUOTE = '"';
const NEEDS_ESCAPE = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | Date | null | undefined;
};

type StringifyResult = { text: string; userText: boolean };

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escape({ text: c.header, userText: false })).join(",");
  const dataLines = rows.map((row) =>
    columns.map((c) => escape(stringify(c.value(row)))).join(","),
  );
  return BOM + [headerLine, ...dataLines].join("\r\n") + "\r\n";
}

function stringify(v: string | number | Date | null | undefined): StringifyResult {
  if (v === null || v === undefined) return { text: "", userText: false };
  if (v instanceof Date) return { text: v.toISOString(), userText: false };
  if (typeof v === "number") return { text: String(v), userText: false };
  return { text: v, userText: true };
}

function escape({ text, userText }: StringifyResult): string {
  let out = text;
  if (userText && FORMULA_LEAD.test(out)) out = "'" + out;
  if (!NEEDS_ESCAPE.test(out)) return out;
  return QUOTE + out.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
}
