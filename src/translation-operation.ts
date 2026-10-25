import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import type {
  ArtifactEntry,
  ArtifactInventory,
  ArtifactRoot,
} from "./artifacts.js";
import {
  prepareExtractionDestination,
  revalidateExtractionDestination,
  type ExtractionDestinationPreparation,
} from "./extraction-paths.js";
import type { ListingPreparation } from "./listing-paths.js";
import {
  assertSupportedLocalDrive,
  canonicalizePath,
  joinPath,
  pathContains,
  pathIdentity,
  pathOverlaps,
  resolveDisplayPath,
  validatePathSyntax,
} from "./paths.js";
import { admittedPrimaryInputs } from "./output-placement.js";
import {
  MAX_TRANSLATION_LOCALES,
  isSafeTranslationLocale,
  isSafeTranslationResourceSource,
} from "./schemas.js";
import { StorageError, type OperationStorage } from "./storage.js";
import { boundedUtf8 } from "./text.js";
import {
  TranslationCsvValidationError,
  decodeTranslationCsv,
  parseTranslationCsv,
  type ParsedTranslationCsv,
} from "./translation-csv.js";
import {
  PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
  PATCH_TRANSLATIONS_RULE,
  patchTranslationsReportPath,
  patchTranslationsRequestPath,
} from "./translation-planning.js";
import type {
  EvaluationResult,
  PatchTranslationsInput,
  PatchTranslationsSemanticData,
  PatchTranslationsSessionAction,
  ProcessObservation,
} from "./types.js";

/**
 * Per-call standalone translation preparation and report adaptation.
 *
 * This module owns protected original-CSV fingerprints, operation-owned
 * prepared copies and the fixed-script request, destination protection, and
 * report-backed semantic evaluation. It consumes the shared strict CSV decoder
 * and parser. It never launches a process: shared Execution owns the single
 * fixed-script launch, profile, capture, cancellation and cleanup. No key value
 * is written into the request, report or prepared evidence.
 */

const MAX_EVIDENCE = 32;
const MAX_PREPARED_PREVIEW = 8;
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/u;
const PREPARED_DIRECTORY = "prepared";
export const TRANSLATION_PATCH_DETAIL_FILENAME = "evidence.json";
export const TRANSLATION_PATCH_PREPARATION_FILENAME = "preparation.json";

export const translationPatchPreparedPath = (
  operationDirectory: string,
  index: number,
): string =>
  joinPath(
    operationDirectory,
    PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
    PREPARED_DIRECTORY,
    `${String(index)}.csv`,
  );

export const translationPatchDetailPath = (
  operationDirectory: string,
): string =>
  joinPath(
    operationDirectory,
    PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
    TRANSLATION_PATCH_DETAIL_FILENAME,
  );

/** A host rejection attributable to one disclosed preparation failure. */
export class TranslationOperationError extends Error {
  public readonly code:
    | "validation_failed"
    | "path_unsupported"
    | "storage_failed";

  public constructor(
    code: TranslationOperationError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "TranslationOperationError";
    this.code = code;
  }
}

const bounded = (value: unknown, fallback: string): string =>
  boundedUtf8(value, fallback);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : String(error ?? fallback);

const checkBudget = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) {
    throw new Error("translation patch preparation was cancelled");
  }
};

interface TranslationCsvFingerprint {
  readonly display: string;
  readonly realPath: string;
  readonly identity: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mtimeNs: string;
  readonly fileId: string;
}

interface PreparedCsvEvidence {
  readonly original: string;
  readonly prepared: string;
  readonly sha256: string;
  readonly bomNormalized: boolean;
  readonly lineEndingNormalized: boolean;
}

interface AdmittedMapping {
  readonly resource: string;
  readonly originalCsv: string;
  readonly preparedCsv: string;
  readonly columns: readonly string[];
  readonly keyIndex: number;
  readonly keys: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly localeColumns: readonly string[];
}

interface TranslationPatchRequest {
  readonly version: 1;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly locales: readonly string[];
  readonly session: readonly { readonly kind: "multithreading"; readonly disabled: boolean }[];
  readonly translations: readonly {
    readonly resource: string;
    readonly csv: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly string[])[];
  }[];
}

interface NativeReportMapping {
  readonly resource: string;
  readonly csv: string;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
}

interface NativeReportOutput {
  readonly resource: string;
  readonly member: string;
  readonly path: string;
  readonly locale: string;
  readonly class: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly verifiedTexts: number;
  readonly retainedContentVerified: boolean;
}

interface NativeReportProjectConfig {
  readonly member: string;
  readonly path: string;
  readonly sha256: string;
}

interface NativeTranslationReport {
  readonly version: 1;
  readonly ok: boolean;
  readonly stage: string;
  readonly error: string | null;
  readonly nativeCode: number;
  readonly output: string;
  readonly userData: string;
  readonly temp: string;
  readonly mappings: readonly NativeReportMapping[];
  readonly fileMap: ReadonlyMap<string, { readonly path: string; readonly logical: string }>;
  readonly outputs: readonly NativeReportOutput[];
  readonly projectConfig: NativeReportProjectConfig | null;
}

interface TranslationPatchAssessment {
  readonly proceed: boolean;
  readonly evaluation: EvaluationResult<PatchTranslationsSemanticData> | null;
  readonly detail: Record<string, unknown> | null;
}

export interface TranslationPatchPrecheckResult {
  readonly proceed: boolean;
  readonly evaluation: EvaluationResult<PatchTranslationsSemanticData> | null;
}

export interface TranslationOperationOptions {
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly input: PatchTranslationsInput;
  readonly preparedInputs: ListingPreparation;
  readonly session: readonly PatchTranslationsSessionAction[];
  readonly signal: AbortSignal;
  /** Existing supplied-key redaction for operation-local ordinary evidence. */
  readonly redactText?: (text: string) => string;
  readonly store?: Pick<OperationStorage, "writeAuxiliaryJson">;
}

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const hashFile = async (file: string, signal: AbortSignal): Promise<string> => {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.readableWebStream() as unknown as AsyncIterable<Uint8Array>) {
      checkBudget(signal);
      hash.update(chunk);
    }
    checkBudget(signal);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

/**
 * Fingerprint one protected CSV independently of the listing/package policy:
 * a prior export operation's own output CSV must stay usable, while the
 * current operation's administrative tree is rejected by the caller.
 */
const fingerprintCsv = async (
  workspace: string,
  csv: string,
  signal: AbortSignal,
): Promise<TranslationCsvFingerprint> => {
  if (!validatePathSyntax(csv)) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV path is not representable: ${csv}`,
    );
  }
  const display = resolveDisplayPath(workspace, csv, true);
  let lstat: BigIntStats;
  try {
    lstat = await fs.lstat(display, { bigint: true });
  } catch (error) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV cannot be inspected: ${csv}`,
      { cause: error },
    );
  }
  if (lstat.isSymbolicLink()) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV must not be a symbolic link: ${csv}`,
    );
  }
  if (!lstat.isFile()) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV is not a regular file: ${csv}`,
    );
  }
  let resolved: Awaited<ReturnType<typeof canonicalizePath>>;
  try {
    resolved = await canonicalizePath(display);
    await assertSupportedLocalDrive(resolved.realPath);
  } catch (error) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV is not a supported local file: ${csv}`,
      { cause: error },
    );
  }
  const stats = await fs.stat(display, { bigint: true });
  if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV is not a bounded regular file: ${csv}`,
    );
  }
  let sha256: string;
  try {
    sha256 = await hashFile(display, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TranslationOperationError(
      "validation_failed",
      `translation CSV could not be read: ${csv}`,
      { cause: error },
    );
  }
  return {
    display,
    realPath: resolved.realPath,
    identity: resolved.identity,
    bytes: Number(stats.size),
    sha256,
    mtimeNs: stats.mtimeNs.toString(),
    fileId: `${stats.dev.toString()}:${stats.ino.toString()}`,
  };
};

const sameFingerprint = (
  left: TranslationCsvFingerprint,
  right: TranslationCsvFingerprint,
): boolean =>
  left.identity === right.identity &&
  pathIdentity(left.realPath) === pathIdentity(right.realPath) &&
  left.bytes === right.bytes &&
  left.sha256 === right.sha256 &&
  left.mtimeNs === right.mtimeNs &&
  left.fileId === right.fileId;

/**
 * Map the shared parser's neutral validation rejection onto this operation's
 * disclosed preparation error so existing execution classification and
 * `instanceof` checks are unchanged.
 */
const parseTranslationCsvOrThrow = (text: string): ParsedTranslationCsv => {
  try {
    return parseTranslationCsv(text);
  } catch (error) {
    if (error instanceof TranslationCsvValidationError) {
      throw new TranslationOperationError(error.code, error.message, {
        cause: error,
      });
    }
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class ReportParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

const requireKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ReportParseError(`${label} contains unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new ReportParseError(`${label} is missing field ${JSON.stringify(key)}`);
    }
  }
};

const requireString = (
  value: Record<string, unknown>,
  field: string,
  label: string,
  nonempty = true,
): string => {
  const entry = value[field];
  if (typeof entry !== "string" || (nonempty && entry.length === 0)) {
    throw new ReportParseError(
      `${label}.${field} must be ${nonempty ? "a nonempty string" : "a string"}`,
    );
  }
  return entry;
};

const requireArray = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): readonly unknown[] => {
  const entry = value[field];
  if (!Array.isArray(entry)) {
    throw new ReportParseError(`${label}.${field} must be an array`);
  }
  return entry;
};

const requireNonNegativeInteger = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): number => {
  const entry = value[field];
  if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
    throw new ReportParseError(
      `${label}.${field} must be a nonnegative safe integer`,
    );
  }
  return entry;
};

const requireStringArray = (
  value: Record<string, unknown>,
  field: string,
  label: string,
): readonly string[] => {
  const entries = requireArray(value, field, label);
  if (entries.some((entry) => typeof entry !== "string")) {
    throw new ReportParseError(`${label}.${field} must contain only strings`);
  }
  return entries as readonly string[];
};

/** Strict shape for the fixed private native report contract. */
const parseNativeReport = (value: unknown): NativeTranslationReport => {
  if (!isRecord(value)) {
    throw new ReportParseError("native translation report must be an object");
  }
  requireKeys(
    value,
    [
      "version",
      "ok",
      "stage",
      "error",
      "nativeCode",
      "output",
      "userData",
      "temp",
      "mappings",
      "fileMap",
      "outputs",
      "projectConfig",
    ],
    "native translation report",
  );
  if (value.version !== 1) {
    throw new ReportParseError(
      "native translation report has an unsupported version",
    );
  }
  if (typeof value.ok !== "boolean") {
    throw new ReportParseError("native translation report ok must be boolean");
  }
  const stage = requireString(value, "stage", "native translation report");
  if (value.error !== null && typeof value.error !== "string") {
    throw new ReportParseError(
      "native translation report error must be a string or null",
    );
  }
  const nativeCode = value.nativeCode;
  if (typeof nativeCode !== "number" || !Number.isSafeInteger(nativeCode)) {
    throw new ReportParseError(
      "native translation report nativeCode must be a safe integer",
    );
  }
  const output = requireString(value, "output", "native translation report");
  const userData = requireString(value, "userData", "native translation report");
  const temp = requireString(value, "temp", "native translation report");

  const mappings = requireArray(
    value,
    "mappings",
    "native translation report",
  ).map((raw, index): NativeReportMapping => {
    const label = `native translation report mappings[${String(index)}]`;
    if (!isRecord(raw)) throw new ReportParseError(`${label} must be an object`);
    requireKeys(raw, ["resource", "csv", "defaultLocale", "locales"], label);
    return {
      resource: requireString(raw, "resource", label),
      csv: requireString(raw, "csv", label),
      defaultLocale: requireString(raw, "defaultLocale", label),
      locales: requireStringArray(raw, "locales", label),
    };
  });

  const rawFileMap = value.fileMap;
  if (!isRecord(rawFileMap)) {
    throw new ReportParseError(
      "native translation report fileMap must be an object",
    );
  }
  const fileMap = new Map<string, { path: string; logical: string }>();
  for (const [file, logical] of Object.entries(rawFileMap)) {
    if (typeof logical !== "string" || logical.length === 0) {
      throw new ReportParseError(
        "native translation report fileMap values must be nonempty strings",
      );
    }
    const identity = pathIdentity(file);
    if (fileMap.has(identity)) {
      throw new ReportParseError(
        `native translation report fileMap repeats path ${file}`,
      );
    }
    fileMap.set(identity, { path: file, logical });
  }

  const outputs = requireArray(
    value,
    "outputs",
    "native translation report",
  ).map((raw, index): NativeReportOutput => {
    const label = `native translation report outputs[${String(index)}]`;
    if (!isRecord(raw)) throw new ReportParseError(`${label} must be an object`);
    requireKeys(
      raw,
      [
        "resource",
        "member",
        "path",
        "locale",
        "class",
        "bytes",
        "sha256",
        "verifiedTexts",
        "retainedContentVerified",
      ],
      label,
    );
    const sha256 = requireString(raw, "sha256", label);
    if (!HASH_PATTERN.test(sha256)) {
      throw new ReportParseError(`${label}.sha256 must be 64 hexadecimal characters`);
    }
    if (typeof raw.retainedContentVerified !== "boolean") {
      throw new ReportParseError(`${label}.retainedContentVerified must be boolean`);
    }
    return {
      resource: requireString(raw, "resource", label),
      member: requireString(raw, "member", label),
      path: requireString(raw, "path", label),
      locale: requireString(raw, "locale", label),
      class: requireString(raw, "class", label),
      bytes: requireNonNegativeInteger(raw, "bytes", label),
      sha256: sha256.toLowerCase(),
      verifiedTexts: requireNonNegativeInteger(raw, "verifiedTexts", label),
      retainedContentVerified: raw.retainedContentVerified,
    };
  });

  let projectConfig: NativeReportProjectConfig | null = null;
  if (value.projectConfig !== null) {
    if (!isRecord(value.projectConfig)) {
      throw new ReportParseError(
        "native translation report projectConfig must be an object or null",
      );
    }
    const label = "native translation report projectConfig";
    requireKeys(value.projectConfig, ["member", "path", "sha256"], label);
    const sha256 = requireString(value.projectConfig, "sha256", label);
    if (!HASH_PATTERN.test(sha256)) {
      throw new ReportParseError(
        `${label}.sha256 must be 64 hexadecimal characters`,
      );
    }
    projectConfig = {
      member: requireString(value.projectConfig, "member", label),
      path: requireString(value.projectConfig, "path", label),
      sha256: sha256.toLowerCase(),
    };
  }

  return {
    version: 1,
    ok: value.ok,
    stage,
    error: value.error as string | null,
    nativeCode,
    output,
    userData,
    temp,
    mappings,
    fileMap,
    outputs,
    projectConfig,
  };
};

const KNOWN_SYNTHETIC_DIAGNOSTIC_FIRST = [
  'ERROR: Condition "res != ((HRESULT)0L)" is true.',
  'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
] as const;
const KNOWN_SYNTHETIC_DIAGNOSTIC_AT =
  "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)";

const contradictoryLogLines = (text: string): readonly string[] => {
  const lines = text.split(/\r?\n/u);
  const result: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/(?:^|\b)(?:SCRIPT ERROR|ERROR):/u.test(line)) continue;
    const paired =
      (KNOWN_SYNTHETIC_DIAGNOSTIC_FIRST as readonly string[]).includes(line) &&
      lines[index + 1] === KNOWN_SYNTHETIC_DIAGNOSTIC_AT;
    if (paired) continue;
    result.push(line);
  }
  return result;
};

const readCompleteStream = async (
  evidence: ProcessObservation["stdoutEvidence"],
  preview: string,
): Promise<string | null> => {
  if (evidence?.complete !== true) return null;
  if (evidence.textPath !== null) {
    try {
      return await fs.readFile(evidence.textPath, "utf8");
    } catch {
      return null;
    }
  }
  return preview;
};

const redactDeep = (
  value: unknown,
  redact: ((text: string) => string) | undefined,
): unknown => {
  if (redact === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, redact));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = redactDeep(entry, redact);
  }
  return result;
};

const findEntry = (
  inventory: ArtifactInventory,
  file: string,
): ArtifactEntry | undefined => {
  const identity = pathIdentity(file);
  return inventory.entries.find((entry) => pathIdentity(entry.path) === identity);
};

export class TranslationOperation {
  private readonly workspace: string;
  private readonly operationDirectory: string;
  private readonly input: PatchTranslationsInput;
  private readonly preparedInputs: ListingPreparation;
  private readonly session: readonly PatchTranslationsSessionAction[];
  private readonly signal: AbortSignal;
  private readonly redactText: ((text: string) => string) | undefined;
  private readonly store: Pick<OperationStorage, "writeAuxiliaryJson"> | undefined;
  private destinationValue: ExtractionDestinationPreparation | undefined;
  private mappingsValue: readonly AdmittedMapping[] = [];
  private fingerprintsValue: readonly TranslationCsvFingerprint[] = [];
  private preparedValue: readonly PreparedCsvEvidence[] = [];
  private preparedHashes = new Map<string, string>();
  private assessedEvidence:
    | {
        readonly report: NativeTranslationReport;
        readonly stdout: string;
        readonly stderr: string;
      }
    | undefined;
  private assessedOutputIdentities: ReadonlySet<string> | undefined;

  public constructor(options: TranslationOperationOptions) {
    this.workspace = options.workspace;
    this.operationDirectory = options.operationDirectory;
    this.input = options.input;
    this.preparedInputs = options.preparedInputs;
    this.session = options.session;
    this.signal = options.signal;
    this.redactText = options.redactText;
    this.store = options.store;
  }

  public get effectiveOutput(): string | undefined {
    return this.destinationValue?.effectiveOutput;
  }

  public get effectiveRealPath(): string | undefined {
    return this.destinationValue?.effectiveRealPath;
  }

  public get resolvedTranslations(): readonly {
    readonly csv: string;
    readonly resource: string;
  }[] {
    return this.mappingsValue.map((mapping) => ({
      csv: mapping.originalCsv,
      resource: mapping.resource,
    }));
  }

  public get csvFingerprints(): readonly TranslationCsvFingerprint[] {
    return this.fingerprintsValue;
  }

  public get requestPath(): string {
    return patchTranslationsRequestPath(this.operationDirectory);
  }

  public get reportPath(): string {
    return patchTranslationsReportPath(this.operationDirectory);
  }

  public get preparationEvidence(): Record<string, unknown> | null {
    if (this.destinationValue === undefined) return null;
    const prepared = this.preparedValue;
    return {
      schemaVersion: 1,
      rule: PATCH_TRANSLATIONS_RULE,
      requestPath: this.requestPath,
      reportPath: this.reportPath,
      preparationPath: joinPath(
        this.operationDirectory,
        PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
        TRANSLATION_PATCH_PREPARATION_FILENAME,
      ),
      effectiveOutput: this.destinationValue.effectiveOutput,
      localeSelection:
        this.input.locales === undefined ? "new-locales-only" : "explicit",
      locales: [...(this.input.locales ?? [])],
      mappings: this.mappingsValue.map((mapping) => ({
        resource: mapping.resource,
        originalCsv: mapping.originalCsv,
        preparedCsv: mapping.preparedCsv,
        keyIndex: mapping.keyIndex,
        localeColumns: [...mapping.localeColumns],
        rowCount: mapping.rows.length,
      })),
      preparedCsvs: {
        items: prepared.slice(0, MAX_PREPARED_PREVIEW).map((entry) => ({
          original: entry.original,
          prepared: entry.prepared,
          bomNormalized: entry.bomNormalized,
          lineEndingNormalized: entry.lineEndingNormalized,
        })),
        truncated: prepared.length > MAX_PREPARED_PREVIEW,
      },
      fingerprintCount: this.fingerprintsValue.length,
    };
  }

  /** Paths this operation writes inside its own evidence namespace. */
  public evidencePaths(): readonly string[] {
    return [
      this.requestPath,
      this.reportPath,
      translationPatchDetailPath(this.operationDirectory),
      joinPath(
        this.operationDirectory,
        PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
        TRANSLATION_PATCH_PREPARATION_FILENAME,
      ),
      ...this.preparedValue.map((entry) => entry.prepared),
    ];
  }

  /** Paths the fixed native process reads from this operation. */
  public readPaths(): readonly string[] {
    return [
      this.requestPath,
      ...this.preparedValue.map((entry) => entry.prepared),
    ];
  }

  public async prepare(): Promise<void> {
    const operationResolved = await canonicalizePath(this.operationDirectory);
    const seenCsvIdentities = new Set<string>();
    const mappings: AdmittedMapping[] = [];
    const fingerprints: TranslationCsvFingerprint[] = [];
    const prepared: PreparedCsvEvidence[] = [];

    for (const [index, mapping] of this.input.translations.entries()) {
      checkBudget(this.signal);
      const fingerprint = await fingerprintCsv(
        this.workspace,
        mapping.csv,
        this.signal,
      );
      if (
        pathOverlaps(fingerprint.identity, operationResolved.identity)
      ) {
        throw new TranslationOperationError(
          "validation_failed",
          `translation CSV overlaps the current operation administrative tree: ${mapping.csv}`,
        );
      }
      if (seenCsvIdentities.has(fingerprint.identity)) {
        throw new TranslationOperationError(
          "validation_failed",
          `translation mappings resolve to the same canonical CSV file: ${mapping.csv}`,
        );
      }
      seenCsvIdentities.add(fingerprint.identity);

      const originalBytes = await fs.readFile(fingerprint.display);
      if (hashBytes(originalBytes) !== fingerprint.sha256) {
        throw new TranslationOperationError(
          "validation_failed",
          `translation CSV changed during preparation: ${mapping.csv}`,
        );
      }
      let text: string;
      let hasBom: boolean;
      try {
        const decoded = decodeTranslationCsv(originalBytes);
        text = decoded.text;
        hasBom = decoded.bomNormalized;
      } catch (error) {
        throw new TranslationOperationError(
          "validation_failed",
          `translation CSV is not valid UTF-8: ${mapping.csv}`,
          { cause: error },
        );
      }
      const contentBytes = hasBom ? originalBytes.subarray(3) : originalBytes;
      const parsed = parseTranslationCsvOrThrow(text);
      if (this.input.locales !== undefined) {
        const columns = new Set(parsed.localeColumns);
        for (const locale of this.input.locales) {
          if (!columns.has(locale)) {
            throw new TranslationOperationError(
              "validation_failed",
              `explicit locale ${locale} is not a column of ${mapping.csv}`,
            );
          }
        }
      }
      const preparedPath = translationPatchPreparedPath(
        this.operationDirectory,
        index,
      );
      const preparedSha = hashBytes(contentBytes);
      try {
        await fs.mkdir(path.dirname(preparedPath), { recursive: true });
        await fs.writeFile(preparedPath, contentBytes, { flag: "wx" });
      } catch (error) {
        throw new TranslationOperationError(
          "storage_failed",
          `operation-owned prepared translation CSV could not be written: ${bounded(error, "write failure")}`,
          { cause: error },
        );
      }
      this.preparedHashes.set(pathIdentity(preparedPath), preparedSha);

      fingerprints.push(fingerprint);
      prepared.push({
        original: fingerprint.display,
        prepared: preparedPath,
        sha256: preparedSha,
        bomNormalized: hasBom,
        lineEndingNormalized: parsed.lineEndingNormalized,
      });
      mappings.push({
        resource: mapping.resource,
        originalCsv: fingerprint.display,
        preparedCsv: preparedPath,
        columns: parsed.columns,
        keyIndex: parsed.keyIndex,
        keys: parsed.keys,
        rows: parsed.rows,
        localeColumns: parsed.localeColumns,
      });
    }

    let destination: ExtractionDestinationPreparation;
    try {
      destination = await prepareExtractionDestination({
        workspace: this.workspace,
        operationDirectory: this.operationDirectory,
        requestedOutput: this.input.output,
        defaultPlacement: {
          kind: "translations",
          primaryInputs: admittedPrimaryInputs(this.preparedInputs),
        },
        preparedInputs: {
          ...this.preparedInputs,
          fingerprints: [
            ...this.preparedInputs.fingerprints,
            ...fingerprints.map((fingerprint) => ({
              path: fingerprint.display,
              realPath: fingerprint.realPath,
              role: "input" as const,
              identity: fingerprint.identity,
              kind: "file" as const,
              bytes: fingerprint.bytes,
              sha256: fingerprint.sha256,
              mtimeNs: fingerprint.mtimeNs,
              fileId: fingerprint.fileId,
            })),
          ],
        },
        signal: this.signal,
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TranslationOperationError(
        "path_unsupported",
        messageOf(error, "translation patch destination preparation failed").replaceAll(
          "extraction",
          "translation patch",
        ),
        { cause: error },
      );
    }

    const request: TranslationPatchRequest = {
      version: 1,
      inputs: [...this.preparedInputs.resolvedInputs],
      output: destination.effectiveOutput,
      locales: [...(this.input.locales ?? [])],
      session: this.session.map((action) => ({
        kind: "multithreading" as const,
        disabled: action.disabled,
      })),
      translations: mappings.map((mapping) => ({
        resource: mapping.resource,
        csv: mapping.preparedCsv,
        columns: [...mapping.columns],
        rows: mapping.rows.map((row) => [...row]),
      })),
    };

    this.destinationValue = destination;
    this.mappingsValue = mappings;
    this.fingerprintsValue = fingerprints;
    this.preparedValue = prepared;
    const preparationRecord = {
      schemaVersion: 1,
      rule: PATCH_TRANSLATIONS_RULE,
      inputs: [...this.preparedInputs.resolvedInputs],
      effectiveOutput: destination.effectiveOutput,
      effectiveRealPath: destination.effectiveRealPath,
      localeSelection:
        this.input.locales === undefined ? "new-locales-only" : "explicit",
      locales: [...(this.input.locales ?? [])],
      requestPath: this.requestPath,
      reportPath: this.reportPath,
      mappings: mappings.map((mapping) => ({
        resource: mapping.resource,
        originalCsv: mapping.originalCsv,
        preparedCsv: mapping.preparedCsv,
        columns: [...mapping.columns],
        keyIndex: mapping.keyIndex,
        keys: [...mapping.keys],
        localeColumns: [...mapping.localeColumns],
        rowCount: mapping.rows.length,
      })),
      preparedCsvs: prepared.map((entry) => ({ ...entry })),
      fingerprints: fingerprints.map((fingerprint) => ({ ...fingerprint })),
    };

    try {
      await this.writeJson(
        TRANSLATION_PATCH_PREPARATION_FILENAME,
        redactDeep(preparationRecord, this.redactText) as Record<string, unknown>,
      );
      // The request must remain operationally exact for the fixed script; the
      // key never appears as a field, and supplied-key redaction is applied to
      // ordinary records/detail instead.
      await this.writeJson("request.json", request);
    } catch (error) {
      if (error instanceof TranslationOperationError) throw error;
      throw new TranslationOperationError(
        "storage_failed",
        `translation patch request/evidence could not be written: ${bounded(error, "write failure")}`,
        { cause: error },
      );
    }
  }

  /** Recheck original CSVs, prepared copies and the accepted destination. */
  public async revalidate(): Promise<void> {
    if (this.destinationValue === undefined) {
      throw new TranslationOperationError(
        "validation_failed",
        "translation patch destination was not prepared",
      );
    }
    for (const [index, previous] of this.fingerprintsValue.entries()) {
      checkBudget(this.signal);
      const mapping = this.input.translations[index];
      if (mapping === undefined) {
        throw new TranslationOperationError(
          "validation_failed",
          "translation patch mapping state changed before launch",
        );
      }
      const current = await fingerprintCsv(
        this.workspace,
        mapping.csv,
        this.signal,
      );
      if (!sameFingerprint(previous, current)) {
        throw new TranslationOperationError(
          "validation_failed",
          `translation CSV identity or content changed before launch: ${mapping.csv}`,
        );
      }
    }
    for (const prepared of this.preparedValue) {
      checkBudget(this.signal);
      const current = await hashFile(prepared.prepared, this.signal);
      if (current !== this.preparedHashes.get(pathIdentity(prepared.prepared))) {
        throw new TranslationOperationError(
          "validation_failed",
          `operation-owned prepared translation CSV changed before launch: ${prepared.prepared}`,
        );
      }
    }
    try {
      this.destinationValue = await revalidateExtractionDestination(
        this.destinationValue,
        { signal: this.signal },
      );
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TranslationOperationError(
        "path_unsupported",
        messageOf(error, "translation patch destination changed before launch").replaceAll(
          "extraction",
          "translation patch",
        ),
        { cause: error },
      );
    }
  }

  /** Inventory only the accepted destination and its operation-owned output. */
  public inventoryRoots(operationOutput: string): readonly ArtifactRoot[] {
    const destination = this.destinationValue;
    if (destination === undefined) {
      return [{ path: operationOutput, role: "output" }];
    }
    if (destination.effectiveIdentity === destination.ownedIdentity) {
      return [{ path: destination.effectiveRealPath, role: "translation-output" }];
    }
    return [
      { path: operationOutput, role: "output" },
      { path: destination.effectiveRealPath, role: "translation-output" },
    ];
  }

  /** Separate generated translation output from accompanying project metadata. */
  public interpretInventory(inventory: ArtifactInventory): ArtifactInventory {
    const destination = this.destinationValue;
    if (destination === undefined) return inventory;
    const rootIdentity = pathIdentity(destination.effectiveRealPath);
    const reportedOutputs = this.assessedOutputIdentities;
    return {
      ...inventory,
      entries: inventory.entries.map((entry) => {
        const identity = pathIdentity(entry.path);
        // The native report's actual output identities are authoritative; the
        // logical destination may use any safe suffix, not only `.translation`.
        if (reportedOutputs?.has(identity) === true) {
          return { ...entry, role: "translation-output" };
        }
        if (
          identity !== rootIdentity &&
          !identity.startsWith(`${rootIdentity}/`)
        ) {
          return entry;
        }
        const relative = identity.slice(rootIdentity.length).replace(/^\//u, "");
        if (
          relative === "project.godot" ||
          relative === "project.binary" ||
          relative.startsWith(".godot/") ||
          relative.startsWith(".autoconverted/") ||
          /\.(?:import|remap|uid)$/u.test(relative)
        ) {
          return {
            ...entry,
            role: relative.endsWith(".translation")
              ? "translation-output"
              : "accompanying",
          };
        }
        return { ...entry, role: "translation-output" };
      }),
    };
  }

  /**
   * Classify delivered report evidence before any output inventory. Missing,
   * malformed, contradictory and structured-failure reports become terminal
   * here, so a known native failure never triggers a scan/hash of its residue.
   * Only a valid success-shaped report proceeds to the existing inventory.
   */
  public async precheck(
    observation: ProcessObservation,
  ): Promise<TranslationPatchPrecheckResult> {
    const assessment = await this.assess(observation, undefined);
    if (assessment.proceed) {
      return { proceed: true, evaluation: null };
    }
    await this.writeDetail(assessment.detail, observation.redactText ?? this.redactText);
    return { proceed: false, evaluation: assessment.evaluation };
  }

  /**
   * Verify a success-shaped report against the complete acquired inventory.
   * Exit 0 means report delivery, never patch success.
   */
  public async evaluate(
    observation: ProcessObservation,
    artifacts: ArtifactInventory,
  ): Promise<EvaluationResult<PatchTranslationsSemanticData>> {
    const assessment = await this.assess(observation, artifacts);
    await this.writeDetail(assessment.detail, observation.redactText ?? this.redactText);
    if (assessment.evaluation !== null) return assessment.evaluation;
    return {
      status: "unknown",
      rule: PATCH_TRANSLATIONS_RULE,
      summary:
        "The native translation patch report was not assessed against the retained inventory.",
      evidence: [
        "No report assessment was available after the artifact inventory completed.",
      ],
      data: null,
    };
  }

  private async writeDetail(
    detail: Record<string, unknown> | null,
    redact: ((text: string) => string) | undefined,
  ): Promise<void> {
    if (this.store === undefined || detail === null) return;
    const sanitized = redactDeep(detail, redact) as Record<string, unknown>;
    await this.store.writeAuxiliaryJson(
      PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
      TRANSLATION_PATCH_DETAIL_FILENAME,
      sanitized,
    );
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    try {
      if (this.store !== undefined) {
        await this.store.writeAuxiliaryJson(
          PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
          file,
          value,
        );
        return;
      }
      const directory = joinPath(
        this.operationDirectory,
        PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(joinPath(directory, file), `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      throw error instanceof StorageError
        ? error
        : new TranslationOperationError(
            "storage_failed",
            `translation patch evidence could not be written: ${bounded(error, "write failure")}`,
            { cause: error },
          );
    }
  }

  private async assess(
    observation: ProcessObservation,
    artifacts: ArtifactInventory | undefined,
  ): Promise<TranslationPatchAssessment> {
    const context = this.destinationValue;
    const processDetail = {
      exitCode: observation.exitCode,
      signal: observation.signal,
      stdoutPath: observation.stdoutEvidence?.rawPath ?? null,
      stderrPath: observation.stderrEvidence?.rawPath ?? null,
      stdoutComplete: observation.stdoutEvidence?.complete ?? null,
      stderrComplete: observation.stderrEvidence?.complete ?? null,
    };
    const redact = observation.redactText;

    const baseData = (
      completeness: PatchTranslationsSemanticData["completeness"],
      counts: Partial<PatchTranslationsSemanticData["counts"]> = {},
      diagnostics: readonly string[] = [],
      localeLocales: readonly string[] = [],
    ): PatchTranslationsSemanticData => ({
      completeness,
      outputPath: bounded(
        redact?.(context?.effectiveOutput ?? "") ?? context?.effectiveOutput ?? "",
        "output path",
      ),
      localeSelection: {
        mode: context === undefined
          ? "explicit"
          : this.input.locales === undefined
            ? "new-locales-only"
            : "explicit",
        locales: [...localeLocales],
      },
      counts: {
        mappings: this.mappingsValue.length,
        outputs: 0,
        verifiedResources: 0,
        verifiedTexts: 0,
        unverifiedFiles: 0,
        preparedCsvs: this.preparedValue.length,
        ...counts,
      },
      reports: {
        request:
          context === undefined
            ? null
            : bounded(redact?.(this.requestPath) ?? this.requestPath, "request path"),
        native:
          context === undefined
            ? null
            : bounded(redact?.(this.reportPath) ?? this.reportPath, "native report path"),
      },
      preparedCsvs: {
        items: this.preparedValue.slice(0, MAX_PREPARED_PREVIEW).map((entry) => ({
          original: bounded(
            redact?.(entry.original) ?? entry.original,
            "original CSV path",
          ),
          prepared: bounded(
            redact?.(entry.prepared) ?? entry.prepared,
            "prepared CSV path",
          ),
          bomNormalized: entry.bomNormalized,
        })),
        truncated: this.preparedValue.length > MAX_PREPARED_PREVIEW,
      },
      samples: {
        mappings: this.mappingsValue
          .slice(0, 8)
          .map((mapping) =>
            bounded(
              redact?.(`${mapping.resource} <- ${mapping.originalCsv}`) ??
                `${mapping.resource} <- ${mapping.originalCsv}`,
              "translation mapping sample",
            ),
          ),
        outputs: [],
        unverifiedFiles: [],
        truncated: this.mappingsValue.length > 8,
      },
      diagnostics: diagnostics
        .slice(0, 16)
        .map((entry) => bounded(redact?.(entry) ?? entry, "translation patch diagnostic")),
    });

    const early = (
      completeness: PatchTranslationsSemanticData["completeness"],
      status: EvaluationResult<PatchTranslationsSemanticData>["status"],
      summary: string,
      reason: string,
      data: PatchTranslationsSemanticData | null,
      extra: Record<string, unknown> = {},
    ): TranslationPatchAssessment => ({
      proceed: false,
      evaluation: {
        status,
        rule: PATCH_TRANSLATIONS_RULE,
        summary: bounded(redact?.(summary) ?? summary, "translation patch evaluation failed"),
        evidence: [bounded(redact?.(reason) ?? reason, "translation patch evidence")],
        data,
      },
      detail: {
        schemaVersion: 1,
        rule: PATCH_TRANSLATIONS_RULE,
        completeness,
        reason,
        process: processDetail,
        outputPath: context?.effectiveOutput ?? null,
        effectiveOutputRealPath: context?.effectiveRealPath ?? null,
        requestPath: context?.effectiveOutput === undefined ? null : this.requestPath,
        reportPath: context?.effectiveOutput === undefined ? null : this.reportPath,
        mappings: this.mappingsValue.map((mapping) => ({
          resource: mapping.resource,
          originalCsv: mapping.originalCsv,
          preparedCsv: mapping.preparedCsv,
          columns: [...mapping.columns],
          keyIndex: mapping.keyIndex,
          keys: [...mapping.keys],
          localeColumns: [...mapping.localeColumns],
          rowCount: mapping.rows.length,
        })),
        preparedCsvs: this.preparedValue.map((entry) => ({ ...entry })),
        ...extra,
      },
    });

    if (context === undefined) {
      return early(
        "unknown",
        "unknown",
        "Translation patch evaluation was invoked without prepared CSV/destination context.",
        "No operation-owned request, destination or mapping state was available.",
        null,
      );
    }
    if (observation.signal !== null || observation.exitCode !== 0) {
      return early(
        "failed",
        "failed",
        "GDRE translation patching did not finish with a natural exit code 0.",
        `Observed exit code ${String(observation.exitCode)} and signal ${String(observation.signal)}; exit 0 is required for structured report delivery.`,
        baseData("failed"),
      );
    }
    if (
      observation.stdoutEvidence?.complete !== true ||
      observation.stderrEvidence?.complete !== true
    ) {
      return early(
        "unknown",
        "unknown",
        "Process stream capture was incomplete; translation patch success cannot be claimed.",
        "Complete retained stdout/stderr evidence is required to rule out contradictory diagnostics.",
        baseData("unknown"),
      );
    }

    const cached = this.assessedEvidence;
    let stdoutText: string;
    let stderrText: string;
    if (cached !== undefined) {
      stdoutText = cached.stdout;
      stderrText = cached.stderr;
    } else {
      const capturedStdout = await readCompleteStream(
        observation.stdoutEvidence,
        observation.stdout,
      );
      const capturedStderr = await readCompleteStream(
        observation.stderrEvidence,
        observation.stderr,
      );
      if (capturedStdout === null || capturedStderr === null) {
        return early(
          "unknown",
          "unknown",
          "Complete retained stdout/stderr evidence could not be read; translation patch success cannot be claimed.",
          "The retained text evidence is missing or unreadable, so contradictory native diagnostics cannot be excluded.",
          baseData("unknown"),
        );
      }
      stdoutText = capturedStdout;
      stderrText = capturedStderr;
    }

    let report: NativeTranslationReport;
    if (cached !== undefined) {
      report = cached.report;
    } else {
      let reportText: string;
      try {
        reportText = await fs.readFile(this.reportPath, "utf8");
      } catch (error) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report could not be read.",
          bounded(error, "native report read failure"),
          baseData("unknown"),
        );
      }
      let parsedReport: unknown;
      try {
        parsedReport = JSON.parse(reportText) as unknown;
      } catch (error) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report is not valid JSON.",
          bounded(error, "native report parse failure"),
          baseData("unknown"),
          { reportPreview: bounded(reportText, "native report content") },
        );
      }
      try {
        report = parseNativeReport(parsedReport);
      } catch (error) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report does not have a trustworthy shape.",
          error instanceof ReportParseError
            ? error.message
            : bounded(error, "native report shape failure"),
          baseData("unknown"),
        );
      }
      this.assessedEvidence = { report, stdout: stdoutText, stderr: stderrText };
      this.assessedOutputIdentities = new Set(
        report.outputs.map((output) => pathIdentity(output.path)),
      );
    }

    if (!report.ok) {
      const diagnostic = `Native translation patch failed at stage ${report.stage}: ${report.error ?? "no native message"}`;
      const acquired = report.outputs;
      const acquiredIdentities = new Set(
        acquired.map((output) => pathIdentity(output.path)),
      );
      const unverified = [...report.fileMap.values()].filter(
        (entry) => !acquiredIdentities.has(pathIdentity(entry.path)),
      );
      const partial = acquired.length > 0 || report.fileMap.size > 0;
      const acquiredVerifiedResources = acquired.filter(
        (output) => output.retainedContentVerified,
      ).length;
      const acquiredVerifiedTexts = acquired.reduce(
        (total, output) => total + output.verifiedTexts,
        0,
      );
      const acquiredLocales = [...new Set(acquired.map((output) => output.locale))];
      const notes = [
        diagnostic,
        ...(partial
          ? [
              `Native-acquired outputs: ${String(acquired.length)}; retained-content verified: ${String(acquiredVerifiedResources)}; unverified native-written files: ${String(unverified.length)}. These values are native-reported evidence and were not audited against an artifact inventory.`,
            ]
          : []),
      ];
      const projected = baseData(
        partial ? "partial" : "failed",
        {
          outputs: acquired.length,
          verifiedResources: acquiredVerifiedResources,
          verifiedTexts: acquiredVerifiedTexts,
          unverifiedFiles: unverified.length,
        },
        notes,
        this.input.locales ?? acquiredLocales,
      );
      const data: PatchTranslationsSemanticData = partial
        ? {
            ...projected,
            samples: {
              ...projected.samples,
              outputs: acquired
                .slice(0, 8)
                .map((output) =>
                  bounded(
                    redact?.(output.path) ?? output.path,
                    "translation output",
                  ),
                ),
              unverifiedFiles: unverified
                .slice(0, 8)
                .map((entry) =>
                  bounded(
                    redact?.(entry.path) ?? entry.path,
                    "unverified translation file",
                  ),
                ),
              truncated:
                this.mappingsValue.length > 8 ||
                acquired.length > 8 ||
                unverified.length > 8,
            },
          }
        : projected;
      return early(
        partial ? "partial" : "failed",
        "failed",
        partial
          ? "GDRE reported a structured translation patch failure after acquiring partial output evidence."
          : "GDRE reported a structured translation patch failure.",
        diagnostic,
        data,
        {
          nativeReport: report,
          fileMap: [...report.fileMap.values()],
          outputs: report.outputs,
          inventoryAudited: false,
        },
      );
    }
    if (artifacts !== undefined && (!artifacts.complete || artifacts.errors.length > 0)) {
      return early(
        "unknown",
        "unknown",
        "The retained artifact inventory is incomplete; translation patch success cannot be claimed.",
        artifacts.errors[0] ?? "Artifact inventory completeness was not established.",
        baseData("unknown"),
        {
          nativeReport: report,
          inventoryComplete: artifacts.complete,
          inventoryErrors: artifacts.errors.map((error) =>
            bounded(redact?.(error) ?? error, "inventory error"),
          ),
        },
      );
    }

    const outputRoot = context.effectiveRealPath;
    const outputDisplayIdentity = pathIdentity(context.effectiveOutput);
    const outputRealIdentity = pathIdentity(outputRoot);
    const contained = (file: string): boolean => {
      const identity = pathIdentity(file);
      return (
        identity === outputDisplayIdentity ||
        identity === outputRealIdentity ||
        identity.startsWith(`${outputDisplayIdentity}/`) ||
        identity.startsWith(`${outputRealIdentity}/`)
      );
    };
    /**
     * A physical path must correspond to its declared logical member under the
     * accepted output root. Both the display and resolved-root aliases are
     * accepted, matching destination revalidation.
     */
    const matchesLogicalMember = (
      physical: string,
      member: string,
    ): boolean => {
      const parts = member.slice("res://".length).split("/");
      const identity = pathIdentity(physical);
      return (
        pathIdentity(joinPath(context.effectiveRealPath, ...parts)) === identity ||
        pathIdentity(joinPath(context.effectiveOutput, ...parts)) === identity
      );
    };

    if (
      pathIdentity(report.output) !== outputDisplayIdentity &&
      pathIdentity(report.output) !== outputRealIdentity
    ) {
      return early(
        "unknown",
        "unknown",
        "The native translation patch report describes a different output destination.",
        `Report output ${report.output} does not match ${context.effectiveOutput}.`,
        baseData("unknown"),
        { nativeReport: report },
      );
    }
    const profileRoot = joinPath(this.operationDirectory, "profile");
    if (
      !pathContains(profileRoot, report.userData) ||
      !pathContains(profileRoot, report.temp)
    ) {
      return early(
        "unknown",
        "unknown",
        "The native translation patch report did not retain operation-local profile evidence.",
        `Report userData ${report.userData} or temp ${report.temp} is outside ${profileRoot}.`,
        baseData("unknown"),
        { nativeReport: report },
      );
    }
    if (report.nativeCode !== 0 || report.error !== null) {
      return early(
        "unknown",
        "unknown",
        "The native translation patch report contradicts its own success flag.",
        `Report ok was true while nativeCode was ${String(report.nativeCode)} and error was ${report.error === null ? "null" : "non-null"}.`,
        baseData("unknown"),
        { nativeReport: report },
      );
    }

    if (report.mappings.length !== this.mappingsValue.length) {
      return early(
        "unknown",
        "unknown",
        "The native translation patch report does not cover every admitted mapping.",
        `Report mappings ${String(report.mappings.length)} do not match admitted mappings ${String(this.mappingsValue.length)}.`,
        baseData("unknown"),
        { nativeReport: report },
      );
    }
    const reportMappingByResource = new Map<string, NativeReportMapping>();
    for (const [index, admitted] of this.mappingsValue.entries()) {
      const mapping = report.mappings[index];
      if (mapping === undefined || mapping.resource !== admitted.resource) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report does not correspond to the admitted mappings.",
          `Report mapping ${String(index)} does not match resource ${admitted.resource}.`,
          baseData("unknown"),
          { nativeReport: report },
        );
      }
      if (pathIdentity(mapping.csv) !== pathIdentity(admitted.preparedCsv)) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report does not use the operation-owned prepared CSVs.",
          `Report CSV ${mapping.csv} does not match ${admitted.preparedCsv}.`,
          baseData("unknown"),
          { nativeReport: report },
        );
      }
      if (!isSafeTranslationLocale(mapping.defaultLocale)) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report contains an unsafe default locale.",
          `Default locale ${mapping.defaultLocale} is not a safe identifier.`,
          baseData("unknown"),
          { nativeReport: report },
        );
      }
      const locales: string[] = [];
      const seen = new Set<string>();
      for (const locale of mapping.locales) {
        if (!isSafeTranslationLocale(locale) || seen.has(locale)) {
          return early(
            "unknown",
            "unknown",
            "The native translation patch report contains an unsafe or repeated locale.",
            `Report locale ${locale} for ${mapping.resource} is not a unique safe identifier.`,
            baseData("unknown"),
            { nativeReport: report },
          );
        }
        seen.add(locale);
        locales.push(locale);
      }
      if (locales.length === 0) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report has no selected locales for a mapping.",
          `Report locales for ${mapping.resource} were empty.`,
          baseData("unknown"),
          { nativeReport: report },
        );
      }
      if (this.input.locales !== undefined) {
        for (const requested of this.input.locales) {
          if (!seen.has(requested)) {
            return early(
              "unknown",
              "unknown",
              "The native translation patch report does not cover a requested locale.",
              `Requested locale ${requested} is absent from the report mapping for ${mapping.resource}.`,
              baseData("unknown"),
              { nativeReport: report },
            );
          }
        }
      }
      reportMappingByResource.set(mapping.resource, mapping);
    }

    const contradictory = [
      ...contradictoryLogLines(stdoutText),
      ...contradictoryLogLines(stderrText),
    ];
    if (contradictory.length > 0) {
      return early(
        "unknown",
        "unknown",
        "Complete retained streams contain contradictory native errors.",
        contradictory[0]!,
        baseData("unknown", {}, contradictory.slice(0, 8)),
        { nativeReport: report, contradictoryDiagnostics: contradictory },
      );
    }

    const requestRows = new Map<string, number>();
    for (const mapping of this.mappingsValue) {
      requestRows.set(mapping.resource, mapping.rows.length);
    }
    const outputIdentities = new Set<string>();
    const outputsByResource = new Map<string, NativeReportOutput[]>();
    const verifiedOutputPaths: string[] = [];
    let verifiedTexts = 0;
    for (const output of report.outputs) {
      const identity = pathIdentity(output.path);
      if (outputIdentities.has(identity)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report repeats an output path.",
          `Duplicate output path: ${output.path}`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      outputIdentities.add(identity);
      const mapping = reportMappingByResource.get(output.resource);
      if (mapping === undefined) {
        return early(
          "failed",
          "failed",
          "The native translation patch report names an unadmitted translation resource.",
          `Output resource ${output.resource} has no admitted mapping.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!contained(output.path)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report names an output outside the accepted destination.",
          `Output ${output.path} is outside ${context.effectiveOutput}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!isSafeTranslationResourceSource(output.member)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report contains an unsafe logical member.",
          `Unsafe logical member: ${output.member}`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!matchesLogicalMember(output.path, output.member)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report maps a physical output to a different logical member.",
          `Output path ${output.path} does not correspond to logical member ${output.member}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!isSafeTranslationLocale(output.locale)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report contains an unsafe output locale.",
          `Unsafe output locale: ${output.locale}`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      const fileEntry = report.fileMap.get(identity);
      if (fileEntry === undefined || fileEntry.logical !== output.member) {
        return early(
          "failed",
          "failed",
          "The native translation patch report omits or disagrees about a generated output mapping.",
          `Output ${output.path} is not mapped to ${output.member} in fileMap.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      const expectedTexts = requestRows.get(output.resource);
      if (expectedTexts === undefined || output.verifiedTexts !== expectedTexts) {
        return early(
          "failed",
          "failed",
          "A generated translation did not verify every requested key text.",
          `Output ${output.path} verified ${String(output.verifiedTexts)} text(s); expected ${String(expectedTexts)}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!output.retainedContentVerified) {
        return early(
          "failed",
          "failed",
          "A generated translation did not verify its retained content.",
          `Output ${output.path} did not confirm retained content verification.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (artifacts !== undefined) {
        const inventoryEntry = findEntry(artifacts, output.path);
        if (
          inventoryEntry === undefined ||
          inventoryEntry.kind !== "file" ||
          inventoryEntry.error !== null ||
          inventoryEntry.bytes !== output.bytes ||
          inventoryEntry.sha256 === null ||
          inventoryEntry.sha256.toLowerCase() !== output.sha256
        ) {
          return early(
            "unknown",
            "unknown",
            "A reported translation output is not a verified regular hashed inventory file.",
            `Missing, changed or unverifiable generated translation: ${output.path}.`,
            baseData("unknown"),
            { nativeReport: report },
          );
        }
      }
      verifiedTexts += output.verifiedTexts;
      verifiedOutputPaths.push(output.path);
      const list = outputsByResource.get(output.resource) ?? [];
      list.push(output);
      outputsByResource.set(output.resource, list);
    }

    if (verifiedOutputPaths.length === 0) {
      return early(
        "failed",
        "failed",
        "The native translation patch report contains no generated translations.",
        "A successful standalone patch must report at least one verified output.",
        baseData("failed"),
        { nativeReport: report },
      );
    }

    for (const admitted of this.mappingsValue) {
      const mapping = reportMappingByResource.get(admitted.resource)!;
      const observedLocales = new Set(
        (outputsByResource.get(admitted.resource) ?? []).map(
          (output) => output.locale,
        ),
      );
      if (observedLocales.size === 0) {
        return early(
          "failed",
          "failed",
          "An admitted mapping produced no translation output.",
          `No output locale was reported for ${admitted.resource}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (this.input.locales !== undefined) {
        const requested = new Set(this.input.locales);
        if (
          observedLocales.size !== requested.size ||
          [...requested].some((locale) => !observedLocales.has(locale))
        ) {
          return early(
            "failed",
            "failed",
            "Generated translation locales do not match the explicit selection.",
            `Expected locales ${[...requested].join(",")}; observed ${[...observedLocales].join(",")} for ${admitted.resource}.`,
            baseData("failed"),
            { nativeReport: report },
          );
        }
      } else {
        const reported = new Set(mapping.locales);
        if (
          observedLocales.size !== reported.size ||
          [...reported].some((locale) => !observedLocales.has(locale))
        ) {
          return early(
            "failed",
            "failed",
            "Generated translation locales do not match the native new-locale selection.",
            `Reported locales ${[...reported].join(",")}; observed ${[...observedLocales].join(",")} for ${admitted.resource}.`,
            baseData("failed"),
            { nativeReport: report },
          );
        }
      }
    }

    const fileMapIdentities = new Set<string>();
    for (const [identity, entry] of report.fileMap) {
      if (fileMapIdentities.has(identity)) {
        return early(
          "unknown",
          "unknown",
          "The native translation patch report repeats a file-map path.",
          `Duplicate file-map path: ${entry.path}`,
          baseData("unknown"),
          { nativeReport: report },
        );
      }
      fileMapIdentities.add(identity);
      if (!contained(entry.path)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report contains an output outside the accepted destination.",
          `File-map path ${entry.path} is outside ${context.effectiveOutput}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!isSafeTranslationResourceSource(entry.logical)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report contains an unsafe logical file-map member.",
          `Unsafe file-map member ${entry.logical} for ${entry.path}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!matchesLogicalMember(entry.path, entry.logical)) {
        return early(
          "failed",
          "failed",
          "The native translation patch report maps a physical file-map path to a different logical member.",
          `File-map path ${entry.path} does not correspond to logical member ${entry.logical}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (artifacts !== undefined) {
        const inventoryEntry = findEntry(artifacts, entry.path);
        if (
          inventoryEntry === undefined ||
          inventoryEntry.kind !== "file" ||
          inventoryEntry.error !== null ||
          inventoryEntry.bytes === null ||
          inventoryEntry.sha256 === null ||
          !HASH_PATTERN.test(inventoryEntry.sha256)
        ) {
          return early(
            "unknown",
            "unknown",
            "The retained inventory does not verify every file the native report says it wrote.",
            `Missing or unverifiable file-map entry: ${entry.path}.`,
            baseData("unknown"),
            { nativeReport: report },
          );
        }
      }
    }

    if (report.projectConfig !== null) {
      const config = report.projectConfig;
      if (!isSafeTranslationResourceSource(config.member)) {
        return early(
          "failed",
          "failed",
          "The native project configuration member is unsafe.",
          `Unsafe project configuration member: ${config.member}`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!contained(config.path)) {
        return early(
          "failed",
          "failed",
          "The native project configuration is outside the accepted destination.",
          `Project configuration ${config.path} is outside ${context.effectiveOutput}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (!matchesLogicalMember(config.path, config.member)) {
        return early(
          "failed",
          "failed",
          "The native project configuration path does not correspond to its logical member.",
          `Project configuration ${config.path} does not correspond to ${config.member}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      const mapping = report.fileMap.get(pathIdentity(config.path));
      if (mapping === undefined || mapping.logical !== config.member) {
        return early(
          "failed",
          "failed",
          "The native project configuration is absent from the file map.",
          `Project configuration ${config.path} is not mapped to ${config.member}.`,
          baseData("failed"),
          { nativeReport: report },
        );
      }
      if (artifacts !== undefined) {
        const inventoryEntry = findEntry(artifacts, config.path);
        if (
          inventoryEntry === undefined ||
          inventoryEntry.kind !== "file" ||
          inventoryEntry.error !== null ||
          inventoryEntry.sha256 === null ||
          inventoryEntry.sha256.toLowerCase() !== config.sha256
        ) {
          return early(
            "unknown",
            "unknown",
            "The native project configuration output is missing or unverifiable.",
            `Project configuration hash did not match the retained inventory for ${config.path}.`,
            baseData("unknown"),
            { nativeReport: report },
          );
        }
      }
    }

    if (artifacts !== undefined) {
      for (const entry of artifacts.entries) {
        if (entry.kind !== "file" || !contained(entry.path)) continue;
        if (!fileMapIdentities.has(pathIdentity(entry.path))) {
          return early(
            "failed",
            "failed",
            "The retained destination inventory contains a file absent from the native report.",
            `Unreported destination file: ${entry.path}.`,
            baseData("failed"),
            { nativeReport: report },
          );
        }
      }
    }

    const diagnostics: string[] = [];
    for (const prepared of this.preparedValue) {
      if (prepared.bomNormalized) {
        diagnostics.push(
          `Stripped the initial UTF-8 BOM into an operation-owned copy: ${prepared.original}`,
        );
      }
      if (prepared.lineEndingNormalized) {
        diagnostics.push(
          `CRLF input was preserved in the prepared copy and normalized for expected text comparison: ${prepared.original}`,
        );
      }
    }
    const outputLocales =
      this.input.locales !== undefined
        ? [...this.input.locales]
        : [
            ...new Set(
              report.outputs.map((output) => output.locale),
            ),
          ];
    if (artifacts === undefined) {
      // A structurally valid success report proceeds to the existing
      // inventory; hashes, coverage and completeness are checked there.
      return { proceed: true, evaluation: null, detail: null };
    }
    return {
      proceed: true,
      evaluation: {
        status: "succeeded",
        rule: PATCH_TRANSLATIONS_RULE,
        summary:
          "GDRE wrote standalone translations with a complete native report and verified retained content.",
        evidence: [
          "Natural exit code 0 delivered a complete structured native report.",
          `Verified ${String(report.outputs.length)} translation output(s) and ${String(verifiedTexts)} requested key/text expectation(s).`,
          `Retained content was verified for ${String(report.outputs.length)} output(s).`,
          ...diagnostics,
        ]
          .slice(0, MAX_EVIDENCE)
          .map((entry) => bounded(redact?.(entry) ?? entry, "translation patch evidence")),
        data: {
          completeness: "complete",
          outputPath: bounded(
            redact?.(context.effectiveOutput) ?? context.effectiveOutput,
            "output path",
          ),
          localeSelection: {
            mode:
              this.input.locales === undefined
                ? "new-locales-only"
                : "explicit",
            locales: outputLocales.slice(0, MAX_TRANSLATION_LOCALES),
          },
          counts: {
            mappings: this.mappingsValue.length,
            outputs: report.outputs.length,
            verifiedResources: verifiedOutputPaths.length,
            verifiedTexts,
            unverifiedFiles: 0,
            preparedCsvs: this.preparedValue.length,
          },
          reports: {
            request: bounded(
              redact?.(this.requestPath) ?? this.requestPath,
              "request path",
            ),
            native: bounded(
              redact?.(this.reportPath) ?? this.reportPath,
              "native report path",
            ),
          },
          preparedCsvs: {
            items: this.preparedValue
              .slice(0, MAX_PREPARED_PREVIEW)
              .map((entry) => ({
                original: bounded(
                  redact?.(entry.original) ?? entry.original,
                  "original CSV path",
                ),
                prepared: bounded(
                  redact?.(entry.prepared) ?? entry.prepared,
                  "prepared CSV path",
                ),
                bomNormalized: entry.bomNormalized,
              })),
            truncated: this.preparedValue.length > MAX_PREPARED_PREVIEW,
          },
          samples: {
            mappings: this.mappingsValue
              .slice(0, 8)
              .map((mapping) =>
                bounded(
                  redact?.(`${mapping.resource} <- ${mapping.originalCsv}`) ??
                    `${mapping.resource} <- ${mapping.originalCsv}`,
                  "translation mapping sample",
                ),
              ),
            outputs: verifiedOutputPaths
              .slice(0, 8)
              .map((file) =>
                bounded(
                  redact?.(file) ?? file,
                  "translation output",
                ),
              ),
            unverifiedFiles: [],
            truncated:
              this.mappingsValue.length > 8 || verifiedOutputPaths.length > 8,
          },
          diagnostics: diagnostics
            .slice(0, 16)
            .map((entry) =>
              bounded(redact?.(entry) ?? entry, "translation patch diagnostic"),
            ),
        },
      },
      detail: {
        schemaVersion: 1,
        rule: PATCH_TRANSLATIONS_RULE,
        completeness: "complete",
        process: processDetail,
        outputPath: context.effectiveOutput,
        effectiveOutputRealPath: context.effectiveRealPath,
        requestPath: this.requestPath,
        reportPath: this.reportPath,
        mappings: this.mappingsValue.map((mapping) => ({
          resource: mapping.resource,
          originalCsv: mapping.originalCsv,
          preparedCsv: mapping.preparedCsv,
          columns: [...mapping.columns],
          keyIndex: mapping.keyIndex,
          keys: [...mapping.keys],
          localeColumns: [...mapping.localeColumns],
          rowCount: mapping.rows.length,
        })),
        preparedCsvs: this.preparedValue.map((entry) => ({ ...entry })),
        nativeReport: {
          ...report,
          fileMap: [...report.fileMap.values()],
        },
        verifiedOutputPaths,
        verifiedTexts,
        inventory: artifacts.entries.map((entry) => ({
          path: entry.path,
          role: entry.role,
          kind: entry.kind,
          bytes: entry.bytes,
          sha256: entry.sha256,
          error: entry.error,
        })),
      },
    };
  }
}
