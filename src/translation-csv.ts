import {
  MAX_TRANSLATION_LOCALES,
  isSafeTranslationLocale,
} from "./schemas.js";

/**
 * Shared strict translation-CSV decoding and parsing.
 *
 * This module owns the admitted CSV grammar and its diagnostics: initial UTF-8
 * BOM removal, fatal UTF-8 decoding and the strict comma-separated parser
 * (quoted fields, escaped quotes, embedded newlines, LF/CRLF records, exact
 * `key` column, safe unique locale columns). It has no operation state and
 * never reads or writes files. Callers map `TranslationCsvValidationError` into
 * their own disclosed error type so existing result classification is
 * preserved.
 */

const MISSING_KEY_MARKER = "<!MissingKey:";

export class TranslationCsvValidationError extends Error {
  public readonly code = "validation_failed" as const;

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TranslationCsvValidationError";
  }
}

export interface ParsedTranslationCsv {
  readonly columns: readonly string[];
  readonly keyIndex: number;
  readonly keys: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly localeColumns: readonly string[];
  readonly lineEndingNormalized: boolean;
}

export interface DecodedTranslationCsv {
  readonly text: string;
  /** True when an initial UTF-8 BOM was removed from the decoded bytes. */
  readonly bomNormalized: boolean;
}

/**
 * Remove only an initial UTF-8 BOM, then decode the remaining bytes strictly.
 * The prepared copy keeps the original bytes except for that BOM.
 */
export const decodeTranslationCsv = (
  bytes: Uint8Array,
): DecodedTranslationCsv => {
  const bomNormalized =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const contentBytes = bomNormalized ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
  } catch (error) {
    throw new TranslationCsvValidationError(
      "translation CSV is not valid UTF-8",
      { cause: error },
    );
  }
  return { text, bomNormalized };
};

/**
 * Strict comma-separated parser for the admitted translation route. Supports
 * quoted fields, escaped quotes, commas and embedded newlines. CRLF record
 * separators are accepted; a lone CR is rejected. Expected values normalize
 * CRLF to LF because the native `get_csv_messages` reader does.
 */
export const parseTranslationCsv = (text: string): ParsedTranslationCsv => {
  if (text.includes("\0")) {
    throw new TranslationCsvValidationError(
      "translation CSV must not contain NUL characters",
    );
  }
  if (text.replaceAll("\r\n", "").includes("\r")) {
    throw new TranslationCsvValidationError(
      "translation CSV contains a lone CR; only LF or CRLF record separators are supported",
    );
  }
  const lineEndingNormalized = text.includes("\r\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        quoteClosed = true;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      if (field.length > 0 || quoteClosed) {
        throw new TranslationCsvValidationError(
          "translation CSV contains a quote after unquoted content",
        );
      }
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] !== "\n") {
        throw new TranslationCsvValidationError(
          "translation CSV contains a lone CR",
        );
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      quoteClosed = false;
      index += character === "\r" ? 2 : 1;
      continue;
    }
    if (quoteClosed) {
      if (!/\s/u.test(character)) {
        throw new TranslationCsvValidationError(
          "translation CSV contains content after a closing quote",
        );
      }
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (quoted) {
    throw new TranslationCsvValidationError(
      "translation CSV has an unterminated quoted field",
    );
  }
  if (field.length > 0 || row.length > 0 || quoteClosed) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) {
    throw new TranslationCsvValidationError(
      "translation CSV must contain a header and at least one data row",
    );
  }
  const header = rows[0]!;
  if (header.length < 2) {
    throw new TranslationCsvValidationError(
      "translation CSV must contain a key column and at least one locale column",
    );
  }
  const keyIndexes = header
    .map((column, columnIndex) => (column === "key" ? columnIndex : -1))
    .filter((columnIndex) => columnIndex >= 0);
  if (keyIndexes.length !== 1) {
    throw new TranslationCsvValidationError(
      "translation CSV must contain exactly one `key` column",
    );
  }
  const keyIndex = keyIndexes[0]!;
  const localeColumns: string[] = [];
  const seenLocales = new Set<string>();
  const seenLocaleIdentities = new Set<string>();
  for (const [columnIndex, locale] of header.entries()) {
    if (columnIndex === keyIndex) continue;
    if (!isSafeTranslationLocale(locale)) {
      throw new TranslationCsvValidationError(
        `translation CSV locale column is not a safe identifier: ${locale || "(empty)"}`,
      );
    }
    if (seenLocales.has(locale)) {
      throw new TranslationCsvValidationError(
        `translation CSV repeats locale column: ${locale}`,
      );
    }
    seenLocales.add(locale);
    const identity = locale.toLowerCase();
    if (seenLocaleIdentities.has(identity)) {
      throw new TranslationCsvValidationError(
        `translation CSV locale columns collide case-insensitively: ${locale}`,
      );
    }
    seenLocaleIdentities.add(identity);
    localeColumns.push(locale);
  }
  if (localeColumns.length > MAX_TRANSLATION_LOCALES) {
    throw new TranslationCsvValidationError(
      `translation CSV has more than ${String(MAX_TRANSLATION_LOCALES)} locale columns`,
    );
  }
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const dataRows: string[][] = [];
  for (const [rowIndex, record] of rows.slice(1).entries()) {
    if (record.length !== header.length) {
      throw new TranslationCsvValidationError(
        `translation CSV row ${String(rowIndex + 2)} has ${String(record.length)} fields; expected ${String(header.length)}`,
      );
    }
    const key = record[keyIndex]!;
    if (key.length === 0) {
      throw new TranslationCsvValidationError(
        `translation CSV row ${String(rowIndex + 2)} has an empty key`,
      );
    }
    if (key.includes(MISSING_KEY_MARKER)) {
      throw new TranslationCsvValidationError(
        `translation CSV key ${key} contains an unresolved missing-key placeholder`,
      );
    }
    if (seenKeys.has(key)) {
      throw new TranslationCsvValidationError(
        `translation CSV repeats key: ${key}`,
      );
    }
    seenKeys.add(key);
    keys.push(key);
    const normalized = record.map((value) =>
      lineEndingNormalized ? value.replaceAll("\r\n", "\n") : value,
    );
    dataRows.push(normalized);
  }
  return {
    columns: [...header],
    keyIndex,
    keys,
    rows: dataRows,
    localeColumns,
    lineEndingNormalized,
  };
};
