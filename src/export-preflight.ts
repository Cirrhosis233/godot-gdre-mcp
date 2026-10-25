import { promises as fs } from "node:fs";
import { boundedUtf8 } from "./text.js";
import type { ExportImportMetadata } from "./types.js";

/**
 * Parse and validate the adapter-owned fixed inspector's JSON. The inspector
 * emits native logical members and import metadata only; it performs no
 * recovery or resource conversion.
 */

export type ExportPreflightErrorCode = "semantic_unknown" | "semantic_failed";

export class ExportPreflightError extends Error {
  public readonly code: ExportPreflightErrorCode;

  public constructor(
    code: ExportPreflightErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExportPreflightError";
    this.code = code;
  }
}

export interface ExportPreflightEvidence {
  readonly schemaVersion: 1;
  readonly path: string;
  readonly files: readonly string[];
  readonly imports: readonly ExportImportMetadata[];
}

export interface ParsedExportPreflight {
  readonly files: readonly string[];
  readonly imports: readonly ExportImportMetadata[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function unknown(message: string): never {
  throw new ExportPreflightError(
    "semantic_unknown",
    boundedUtf8(message, "export preflight evidence was invalid"),
  );
}

const stringField = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): string => {
  const value = record[key];
  if (typeof value !== "string") unknown(`${label}.${key} must be a string`);
  return value;
};

const stringArrayField = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] => {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    unknown(`${label}.${key} must be an array of strings`);
  }
  return value as readonly string[];
};

/** Parse one inspector payload without touching the filesystem. */
export const parseExportPreflightValue = (
  value: unknown,
): ParsedExportPreflight => {
  if (!isRecord(value)) unknown("export preflight evidence must be an object");
  if (value["schemaVersion"] !== 1) {
    unknown("export preflight evidence has an unsupported schemaVersion");
  }
  if (value["ok"] === false) {
    const message =
      typeof value["error"] === "string" && value["error"].length > 0
        ? value["error"]
        : "native export preflight could not load the project";
    throw new ExportPreflightError(
      "semantic_failed",
      boundedUtf8(message, "native export preflight failed"),
    );
  }
  if (value["ok"] !== true) {
    unknown("export preflight evidence did not declare success");
  }

  const files = stringArrayField(value, "files", "export preflight evidence");
  const fileCount = value["file_count"];
  if (!isNonNegativeInteger(fileCount) || fileCount !== files.length) {
    unknown("export preflight file count does not match the retained member list");
  }
  const seen = new Set<string>();
  for (const member of files) {
    if (!member.startsWith("res://") || member.length === "res://".length) {
      unknown(`export preflight member is not a res:// logical path: ${member}`);
    }
    if (seen.has(member)) {
      unknown(`export preflight member list contains a duplicate: ${member}`);
    }
    seen.add(member);
  }

  const rawImports = value["imports"];
  if (!Array.isArray(rawImports)) {
    unknown("export preflight imports must be an array");
  }
  const importCount = value["import_count"];
  if (!isNonNegativeInteger(importCount) || importCount !== rawImports.length) {
    unknown("export preflight import count does not match the retained import list");
  }
  const imports = rawImports.map((entry, index): ExportImportMetadata => {
    const label = `export preflight import ${String(index)}`;
    if (!isRecord(entry)) unknown(`${label} must be an object`);
    return {
      path: stringField(entry, "path", label),
      importMdPath: stringField(entry, "import_md_path", label),
      sourceFile: stringField(entry, "source_file", label),
      importer: stringField(entry, "importer", label),
      type: stringField(entry, "type", label),
      destFiles: stringArrayField(entry, "dest_files", label),
    };
  });

  return { files: [...files], imports };
};

export const readExportPreflightEvidence = async (
  file: string,
  signal?: AbortSignal,
): Promise<ExportPreflightEvidence> => {
  let text: string;
  try {
    text = await fs.readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new ExportPreflightError(
      "semantic_unknown",
      `export preflight evidence could not be read: ${boundedUtf8(error, "read failure")}`,
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ExportPreflightError(
      "semantic_unknown",
      "export preflight evidence is not valid JSON",
      { cause: error },
    );
  }
  const parsed = parseExportPreflightValue(value);
  return { schemaVersion: 1, path: file, ...parsed };
};
