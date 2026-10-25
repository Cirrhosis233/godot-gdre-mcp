import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import type { ArtifactRoot } from "./artifacts.js";
import {
  assertSupportedLocalDrive,
  canonicalizePath,
  isSupportedAbsolutePath,
  joinPath,
  pathIdentity,
  pathOverlaps,
  resolveDisplayPath,
  validatePathSyntax,
} from "./paths.js";
import { PCK_PATCH_RULE } from "./pck-patch-planning.js";
import {
  OutputPlacementError,
  defaultSiblingOutput,
} from "./output-placement.js";
import {
  CombinedReportError,
  PCK_COMBINED_PREPARATION_NAMESPACE,
  PCK_COMBINED_REPORT_FILE,
  PCK_COMBINED_REQUEST_FILE,
  PCK_COMBINED_VERIFICATION_NAMESPACE,
  acceptCombinedPrepareReport,
  acceptCombinedVerificationReport,
  buildCombinedPreparationRequest,
  buildCombinedVerificationRequest,
  type CombinedOwnedEnvironment,
  type CombinedPrepareReport,
  type CombinedPreparationExpectation,
  type CombinedTranslationRequest,
  type CombinedVerificationReport,
} from "./pck-patch-translations.js";
import type { OperationStorage } from "./storage.js";
import { StorageError } from "./storage.js";
import { boundedUtf8 } from "./text.js";
import {
  TranslationCsvValidationError,
  decodeTranslationCsv,
  parseTranslationCsv,
} from "./translation-csv.js";
import type {
  EvaluationResult,
  PckPatchInput,
  PckPatchMapping,
  PckPatchSemanticData,
  PckPatchTranslationMapping,
  ProcessObservation,
  RetainedStreamEvidence,
} from "./types.js";

/**
 * Per-call package-patch preparation, fixed-inspector report validation and
 * complete content comparison.
 *
 * This module never launches a process. Shared Execution owns the three owned
 * launches (source inspection, the direct CLI patch, output inspection), the
 * call-local timeout/cancellation budget, stream capture and cleanup priority.
 * Host-visible paths stay separate from admitted logical member identities:
 * member comparison is exact after prefix-only canonicalization, never a
 * case-folded host-path lookup.
 */

const MAX_EVIDENCE = 32;
const MAX_SAMPLE = 8;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PCK_PATCH_INSPECT_FILE = "gdre-pck-inspect.gd";

export const PCK_PATCH_EVIDENCE_NAMESPACE = "pck-patch";
export const PCK_PATCH_SOURCE_INSPECTION_NAMESPACE = "pck-source-inspection";
export const PCK_PATCH_OUTPUT_INSPECTION_NAMESPACE = "pck-output-inspection";
export const PCK_PATCH_INSPECTION_REPORT_FILE = "report.json";
export const PCK_PATCH_VERIFICATION_FILE = "verification.json";

const KNOWN_SYNTHETIC_DIAGNOSTIC_FIRST = [
  'ERROR: Condition "res != ((HRESULT)0L)" is true.',
  'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
] as const;
const KNOWN_SYNTHETIC_DIAGNOSTIC_AT =
  "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)";

/** Fixed adapter-owned inspector path under the installed native directory. */
export const pckPatchInspectorScriptPath = (installationRoot: string): string =>
  joinPath(installationRoot, "native", PCK_PATCH_INSPECT_FILE);

export const pckPatchInspectionReportPath = (
  operationDirectory: string,
  namespace:
    | typeof PCK_PATCH_SOURCE_INSPECTION_NAMESPACE
    | typeof PCK_PATCH_OUTPUT_INSPECTION_NAMESPACE,
): string => joinPath(operationDirectory, namespace, PCK_PATCH_INSPECTION_REPORT_FILE);

export const pckPatchVerificationPath = (operationDirectory: string): string =>
  joinPath(
    operationDirectory,
    PCK_PATCH_EVIDENCE_NAMESPACE,
    PCK_PATCH_VERIFICATION_FILE,
  );

/** A disclosed host preparation, inspection or content rejection. */
export class PckPatchOperationError extends Error {
  public readonly code:
    | "validation_failed"
    | "path_unsupported"
    | "storage_failed"
    | "semantic_failed"
    | "semantic_unknown"
    | "unsupported_capability";

  public constructor(
    code: PckPatchOperationError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "PckPatchOperationError";
    this.code = code;
  }
}

const bounded = (value: unknown, fallback: string): string =>
  boundedUtf8(value, fallback);

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : String(error ?? fallback);

const checkBudget = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new PckPatchOperationError(
      "validation_failed",
      "package-patch preparation was cancelled",
    );
  }
};

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export interface PckPatchFingerprint {
  readonly display: string;
  readonly realPath: string;
  readonly identity: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mtimeNs: string;
  readonly fileId: string;
}

export interface PckPatchInspectionMember {
  readonly logicalMember: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PckPatchInspectionMetadata {
  readonly formatVersion: number;
  readonly engineVersion: {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
  };
  readonly encrypted: boolean;
}

export interface PckPatchInspectionReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly packagePath: string;
  readonly metadata: PckPatchInspectionMetadata | null;
  readonly members: readonly PckPatchInspectionMember[] | null;
  readonly error: string | null;
}

export interface PckPatchDestination {
  readonly effectiveOutput: string;
  readonly effectiveRealPath: string;
  readonly effectiveIdentity: string;
  readonly parent: string;
}

export interface PckPatchOperationOptions {
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly input: PckPatchInput;
  readonly signal: AbortSignal;
  /** Fixed adapter-owned inspector script resolved from the installation root. */
  readonly inspectorScriptPath: string;
  /** Fixed adapter-owned combined preparation script resolved from the installation root. */
  readonly prepareScriptPath: string;
  /** Fixed adapter-owned combined verification script resolved from the installation root. */
  readonly verifyScriptPath: string;
  readonly store?: Pick<OperationStorage, "writeAuxiliaryJson">;
}

export interface PatchLaunchAssessment {
  readonly proceed: boolean;
  readonly evaluation: EvaluationResult<PckPatchSemanticData> | null;
}

export interface SourceInspectionAssessment {
  readonly accepted: boolean;
  readonly code: PckPatchOperationError["code"] | null;
  readonly evaluation: EvaluationResult<PckPatchSemanticData> | null;
}

export interface CombinedReportAssessment {
  readonly accepted: boolean;
  readonly code: PckPatchOperationError["code"] | null;
  readonly evaluation: EvaluationResult<PckPatchSemanticData> | null;
}

export interface CombinedContentAssessment {
  readonly proceed: boolean;
  readonly evaluation: EvaluationResult<PckPatchSemanticData> | null;
}

interface PatchStreams {
  readonly stdout: string;
  readonly stderr: string;
}

interface ContentSuccess {
  readonly outputReport: PckPatchInspectionReport;
  readonly patchStreams: PatchStreams;
  readonly verifiedReplacements: readonly string[];
  readonly verifiedRetained: readonly string[];
}

type ContentAssessment =
  | { readonly proceed: true; readonly outcome: ContentSuccess }
  | {
      readonly proceed: false;
      readonly evaluation: EvaluationResult<PckPatchSemanticData>;
    };

interface AvailableObservation {
  readonly path: string;
  readonly exists: boolean | null;
  readonly kind: "file" | "directory" | "link" | "other" | null;
  readonly bytes: number | null;
  readonly error: string | null;
}

interface CombinedTempObservation {
  readonly member: string;
  readonly path: string;
  readonly observation: AvailableObservation;
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
 * Fingerprint one protected host file independently of listing preparation:
 * symbolic links, directories, unsupported drives and unreadable content are
 * rejected before any native mutation.
 */
const fingerprintFile = async (
  workspace: string,
  requested: string,
  label: string,
  signal: AbortSignal,
): Promise<PckPatchFingerprint> => {
  if (!validatePathSyntax(requested)) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} path is not representable: ${requested}`,
    );
  }
  const display = resolveDisplayPath(workspace, requested, true);
  let lstat: BigIntStats;
  try {
    lstat = await fs.lstat(display, { bigint: true });
  } catch (error) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} cannot be inspected: ${requested}`,
      { cause: error },
    );
  }
  if (lstat.isSymbolicLink()) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} must not be a symbolic link: ${requested}`,
    );
  }
  if (!lstat.isFile()) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} is not a regular file: ${requested}`,
    );
  }
  let resolved: Awaited<ReturnType<typeof canonicalizePath>>;
  try {
    resolved = await canonicalizePath(display);
    await assertSupportedLocalDrive(resolved.realPath);
  } catch (error) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} is not a supported local file: ${requested}`,
      { cause: error },
    );
  }
  const stats = await fs.stat(display, { bigint: true });
  if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} is not a bounded regular file: ${requested}`,
    );
  }
  let sha256: string;
  try {
    sha256 = await hashFile(display, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PckPatchOperationError(
      "validation_failed",
      `${label} could not be read: ${requested}`,
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
    fileId:
      stats.ino === 0n ? "" : `${stats.dev.toString()}:${stats.ino.toString()}`,
  };
};

const sameFingerprint = (
  left: PckPatchFingerprint,
  right: PckPatchFingerprint,
): boolean =>
  left.identity === right.identity &&
  pathIdentity(left.realPath) === pathIdentity(right.realPath) &&
  left.bytes === right.bytes &&
  left.sha256 === right.sha256 &&
  left.mtimeNs === right.mtimeNs &&
  left.fileId === right.fileId;

const sameFile = (
  left: PckPatchFingerprint,
  right: PckPatchFingerprint,
): boolean =>
  left.identity === right.identity ||
  (left.fileId.length > 0 && left.fileId === right.fileId);

const assertFixedScriptInstalled = async (
  scriptPath: string,
  label: string,
): Promise<void> => {
  if (!isSupportedAbsolutePath(scriptPath)) {
    throw new PckPatchOperationError(
      "unsupported_capability",
      `the fixed ${label} path is not a supported absolute local path`,
    );
  }
  let stats: BigIntStats;
  try {
    stats = await fs.lstat(scriptPath, { bigint: true });
  } catch (error) {
    throw new PckPatchOperationError(
      "unsupported_capability",
      `the fixed ${label} is not installed at ${scriptPath}`,
      { cause: error },
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PckPatchOperationError(
      "unsupported_capability",
      `the fixed ${label} is not a regular installed file: ${scriptPath}`,
    );
  }
};

const assertInspectorInstalled = (inspectorScriptPath: string): Promise<void> =>
  assertFixedScriptInstalled(inspectorScriptPath, "package inspector");

const observeAvailable = async (
  file: string,
): Promise<AvailableObservation> => {
  try {
    const stats = await fs.lstat(file);
    const kind = stats.isSymbolicLink()
      ? "link"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
    return {
      path: file,
      exists: true,
      kind,
      bytes: stats.isFile() && Number.isSafeInteger(stats.size) ? stats.size : null,
      error: null,
    };
  } catch (error) {
    if (isMissing(error)) {
      return { path: file, exists: false, kind: null, bytes: null, error: null };
    }
    return {
      path: file,
      exists: null,
      kind: null,
      bytes: null,
      error: bounded(error, "path observation failed"),
    };
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
      throw new ReportParseError(
        `${label} contains unknown field ${JSON.stringify(key)}`,
      );
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
): string => {
  const entry = value[field];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new ReportParseError(`${label}.${field} must be a nonempty string`);
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

/** Inventory member names are retained raw identities, not mapping components. */
const isInventoryMember = (value: string): boolean => {
  if (!value.startsWith("res://")) return false;
  const relative = value.slice("res://".length);
  if (
    relative.length === 0 ||
    relative.startsWith("/") ||
    relative.endsWith("/")
  ) {
    return false;
  }
  return relative
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\u0000-\u001F\u007F]/u.test(segment),
    );
};

const invalidMember = (raw: string, label: string): never => {
  throw new ReportParseError(
    `${label} is not a canonical res:// logical member: ${raw}`,
  );
};

/**
 * Prefix-only canonicalization matching the fixed inspector. Retained inventory
 * is not a CLI mapping component, so "=", quotes, edge spaces and trailing-dot
 * segments remain valid identities; traversal, controls, backslashes and
 * ambiguous rooted/scheme spellings never become valid.
 */
const canonicalMember = (raw: string, label: string): string => {
  if (raw.length === 0 || raw.includes("\\")) {
    return invalidMember(raw, label);
  }
  if (raw.startsWith("res://")) {
    return isInventoryMember(raw) ? raw : invalidMember(raw, label);
  }
  if (raw.startsWith("/") || raw.includes("://")) {
    return invalidMember(raw, label);
  }
  const canonical = `res://${raw}`;
  return isInventoryMember(canonical) ? canonical : invalidMember(raw, label);
};

const parseEngineVersion = (
  value: unknown,
  label: string,
): PckPatchInspectionMetadata["engineVersion"] => {
  if (!isRecord(value)) {
    throw new ReportParseError(`${label} must be an object`);
  }
  requireKeys(value, ["major", "minor", "patch"], label);
  return {
    major: requireNonNegativeInteger(value, "major", label),
    minor: requireNonNegativeInteger(value, "minor", label),
    patch: requireNonNegativeInteger(value, "patch", label),
  };
};

const parseMetadata = (
  value: unknown,
  label: string,
): PckPatchInspectionMetadata => {
  if (!isRecord(value)) {
    throw new ReportParseError(`${label} must be an object`);
  }
  requireKeys(value, ["formatVersion", "engineVersion", "encrypted"], label);
  if (typeof value.encrypted !== "boolean") {
    throw new ReportParseError(`${label}.encrypted must be boolean`);
  }
  return {
    formatVersion: requireNonNegativeInteger(value, "formatVersion", label),
    engineVersion: parseEngineVersion(value.engineVersion, `${label}.engineVersion`),
    encrypted: value.encrypted,
  };
};

const parseMembers = (
  value: unknown,
  label: string,
): readonly PckPatchInspectionMember[] => {
  if (!Array.isArray(value)) {
    throw new ReportParseError(`${label} must be an array`);
  }
  const members: PckPatchInspectionMember[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const memberLabel = `${label}[${String(index)}]`;
    if (!isRecord(raw)) {
      throw new ReportParseError(`${memberLabel} must be an object`);
    }
    requireKeys(raw, ["logicalMember", "size", "sha256"], memberLabel);
    const logicalMember = canonicalMember(
      requireString(raw, "logicalMember", memberLabel),
      `${memberLabel}.logicalMember`,
    );
    const sha256 = requireString(raw, "sha256", memberLabel);
    if (!HASH_PATTERN.test(sha256)) {
      throw new ReportParseError(
        `${memberLabel}.sha256 must be 64 lowercase hexadecimal characters`,
      );
    }
    if (exact.has(logicalMember)) {
      throw new ReportParseError(
        `${memberLabel} repeats logical member ${logicalMember}`,
      );
    }
    const identity = logicalMember.toLowerCase();
    if (folded.has(identity)) {
      throw new ReportParseError(
        `${memberLabel} collides case-insensitively with another logical member: ${logicalMember}`,
      );
    }
    exact.add(logicalMember);
    folded.add(identity);
    members.push({
      logicalMember,
      size: requireNonNegativeInteger(raw, "size", memberLabel),
      sha256,
    });
  }
  return members;
};

const parseInspectionReport = (value: unknown): PckPatchInspectionReport => {
  if (!isRecord(value)) {
    throw new ReportParseError("package inspection report must be an object");
  }
  const allowed = new Set([
    "schemaVersion",
    "ok",
    "packagePath",
    "metadata",
    "members",
    "error",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ReportParseError(
        `package inspection report contains unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  for (const field of ["schemaVersion", "ok", "packagePath", "error"]) {
    if (!Object.hasOwn(value, field)) {
      throw new ReportParseError(
        `package inspection report is missing field ${JSON.stringify(field)}`,
      );
    }
  }
  if (value.schemaVersion !== 1) {
    throw new ReportParseError(
      "package inspection report has an unsupported schemaVersion",
    );
  }
  if (typeof value.ok !== "boolean") {
    throw new ReportParseError("package inspection report ok must be boolean");
  }
  const packagePath = requireString(
    value,
    "packagePath",
    "package inspection report",
  );
  if (value.error !== null && typeof value.error !== "string") {
    throw new ReportParseError(
      "package inspection report error must be a string or null",
    );
  }
  if (!value.ok) {
    return {
      schemaVersion: 1,
      ok: false,
      packagePath,
      metadata: null,
      members: null,
      error: value.error as string | null,
    };
  }
  if (value.error !== null) {
    throw new ReportParseError(
      "package inspection report ok:true must not carry an error",
    );
  }
  if (!Object.hasOwn(value, "metadata") || !Object.hasOwn(value, "members")) {
    throw new ReportParseError(
      "package inspection report ok:true must include metadata and members",
    );
  }
  return {
    schemaVersion: 1,
    ok: true,
    packagePath,
    metadata: parseMetadata(value.metadata, "package inspection report metadata"),
    members: parseMembers(value.members, "package inspection report members"),
    error: null,
  };
};

const sameMetadata = (
  left: PckPatchInspectionMetadata,
  right: PckPatchInspectionMetadata,
): boolean =>
  left.formatVersion === right.formatVersion &&
  left.encrypted === right.encrypted &&
  left.engineVersion.major === right.engineVersion.major &&
  left.engineVersion.minor === right.engineVersion.minor &&
  left.engineVersion.patch === right.engineVersion.patch;

const packagePathMatches = (
  reported: string,
  display: string,
  identity: string,
): boolean =>
  pathIdentity(reported) === pathIdentity(display) ||
  pathIdentity(reported) === identity;

const splitProgressLines = (text: string): string[] =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

const patchErrorLines = (text: string): readonly string[] => {
  const lines = splitProgressLines(text);
  const result: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:SCRIPT ERROR|ERROR|Error):/u.test(line)) continue;
    const paired =
      (KNOWN_SYNTHETIC_DIAGNOSTIC_FIRST as readonly string[]).includes(line) &&
      lines[index + 1] === KNOWN_SYNTHETIC_DIAGNOSTIC_AT;
    if (paired) continue;
    result.push(line.trim());
  }
  return result;
};

const readCompleteStream = async (
  evidence: RetainedStreamEvidence | undefined,
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

const parentDirectory = (value: string): string =>
  /^[A-Za-z]:[\\/]/u.test(value) ? path.win32.dirname(value) : path.dirname(value);

export class PckPatchOperation {
  private readonly workspace: string;
  private readonly operationDirectory: string;
  private readonly input: PckPatchInput;
  private readonly signal: AbortSignal;
  private readonly inspectorScriptPath: string;
  private readonly prepareScriptPath: string;
  private readonly verifyScriptPath: string;
  private readonly store: Pick<OperationStorage, "writeAuxiliaryJson"> | undefined;

  private sourceValue: PckPatchFingerprint | undefined;
  private replacementsValue: readonly PckPatchFingerprint[] = [];
  private destinationValue: PckPatchDestination | undefined;
  private sourceReportValue: PckPatchInspectionReport | undefined;
  private patchStreams: PatchStreams | undefined;
  private outputReportKnownPresent = false;
  private originalCsvValue: PckPatchFingerprint | undefined;
  private preparedCsvValue: PckPatchFingerprint | undefined;
  private combinedRequestValue: CombinedTranslationRequest | undefined;
  private combinedBomNormalized = false;
  private combinedOwnedEnvironmentValue: CombinedOwnedEnvironment | undefined;
  private preparedReportValue: CombinedPrepareReport | undefined;
  private verifiedReportValue: CombinedVerificationReport | undefined;
  private preparationReportKnownPresent = false;
  private verificationReportKnownPresent = false;
  private sourceMembersValue: readonly string[] = [];
  private combinedContentValue: ContentSuccess | undefined;
  private readonly sourceReportPathValue: string;
  private readonly outputReportPathValue: string;
  private readonly preparationRequestPathValue: string;
  private readonly verificationRequestPathValue: string;
  private readonly preparationReportPathValue: string;
  private readonly verificationReportPathValue: string;

  public constructor(options: PckPatchOperationOptions) {
    this.workspace = options.workspace;
    this.operationDirectory = options.operationDirectory;
    this.input = options.input;
    this.signal = options.signal;
    this.inspectorScriptPath = options.inspectorScriptPath;
    this.prepareScriptPath = options.prepareScriptPath;
    this.verifyScriptPath = options.verifyScriptPath;
    this.store = options.store;
    this.sourceReportPathValue = pckPatchInspectionReportPath(
      options.operationDirectory,
      PCK_PATCH_SOURCE_INSPECTION_NAMESPACE,
    );
    this.outputReportPathValue = pckPatchInspectionReportPath(
      options.operationDirectory,
      PCK_PATCH_OUTPUT_INSPECTION_NAMESPACE,
    );
    this.preparationRequestPathValue = joinPath(
      options.operationDirectory,
      PCK_PATCH_EVIDENCE_NAMESPACE,
      PCK_COMBINED_REQUEST_FILE,
    );
    this.verificationRequestPathValue = joinPath(
      options.operationDirectory,
      PCK_PATCH_EVIDENCE_NAMESPACE,
      "verify-request.json",
    );
    this.preparationReportPathValue = joinPath(
      options.operationDirectory,
      PCK_COMBINED_PREPARATION_NAMESPACE,
      PCK_COMBINED_REPORT_FILE,
    );
    this.verificationReportPathValue = joinPath(
      options.operationDirectory,
      PCK_COMBINED_VERIFICATION_NAMESPACE,
      PCK_COMBINED_REPORT_FILE,
    );
  }

  public get effectiveOutput(): string | undefined {
    return this.destinationValue?.effectiveOutput;
  }

  public get resolvedPckSource(): string | undefined {
    return this.sourceValue?.display;
  }

  public get resolvedPatches(): readonly PckPatchMapping[] {
    return this.replacementsValue.map((fingerprint, index) => ({
      hostSource: fingerprint.display,
      logicalMember: this.input.patches[index]!.logicalMember,
    }));
  }

  public get sourceFingerprint(): PckPatchFingerprint | undefined {
    return this.sourceValue;
  }

  public get replacementFingerprints(): readonly PckPatchFingerprint[] {
    return this.replacementsValue;
  }

  public get verificationPath(): string {
    return pckPatchVerificationPath(this.operationDirectory);
  }

  public get hasTranslations(): boolean {
    return this.input.translations !== undefined;
  }

  /** Original host-resolved CSV provenance, never the prepared copy. */
  public get resolvedPckTranslations():
    | readonly PckPatchTranslationMapping[]
    | undefined {
    if (this.originalCsvValue === undefined) return undefined;
    return [
      {
        csv: this.originalCsvValue.display,
        resource: this.input.translations![0]!.resource,
      },
    ];
  }

  /** Operation-owned BOM-stripped CSV copies used for CLI argv/effects. */
  public get preparedPckTranslations():
    | readonly PckPatchTranslationMapping[]
    | undefined {
    if (this.preparedCsvValue === undefined) return undefined;
    return [
      {
        csv: this.preparedCsvValue.display,
        resource: this.input.translations![0]!.resource,
      },
    ];
  }

  /** Record the operation-owned profile paths used by the combined scripts. */
  public setOwnedEnvironment(environment: CombinedOwnedEnvironment): void {
    this.combinedOwnedEnvironmentValue = environment;
  }

  /**
   * Write and describe the fixed read-only combined preparation launch. The
   * request is emitted only after the accepted source inspection supplies the
   * actual source member set.
   */
  public async preparationPlan(): Promise<{
    readonly argv: readonly string[];
    readonly cwd: string;
  }> {
    const expectation = this.requireCombinedExpectation();
    await this.writeCombinedRequest(
      this.preparationRequestPathValue,
      buildCombinedPreparationRequest(expectation),
    );
    return {
      argv: [
        "--headless",
        "--script",
        this.prepareScriptPath,
        "--",
        this.preparationRequestPathValue,
        this.preparationReportPathValue,
      ],
      cwd: this.operationDirectory,
    };
  }

  /** Write and describe the fixed read-only combined verification launch. */
  public async verificationPlan(): Promise<{
    readonly argv: readonly string[];
    readonly cwd: string;
  }> {
    const report = this.preparedReportValue;
    const destination = this.requireDestination();
    if (report === undefined) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        "combined verification was requested before preparation was accepted",
      );
    }
    await this.writeCombinedRequest(
      this.verificationRequestPathValue,
      buildCombinedVerificationRequest(destination.effectiveOutput, report),
    );
    return {
      argv: [
        "--headless",
        "--script",
        this.verifyScriptPath,
        "--",
        this.verificationRequestPathValue,
        this.verificationReportPathValue,
      ],
      cwd: this.operationDirectory,
    };
  }

  public sourceInspectionPlan(): { readonly argv: readonly string[]; readonly cwd: string } {
    const source = this.requireSource();
    return {
      argv: [
        "--headless",
        "--script",
        this.inspectorScriptPath,
        "--",
        this.sourceReportPathValue,
        source.display,
      ],
      cwd: this.operationDirectory,
    };
  }

  public outputInspectionPlan(): { readonly argv: readonly string[]; readonly cwd: string } {
    const destination = this.requireDestination();
    return {
      argv: [
        "--headless",
        "--script",
        this.inspectorScriptPath,
        "--",
        this.outputReportPathValue,
        destination.effectiveOutput,
      ],
      cwd: this.operationDirectory,
    };
  }

  /** Paths the fixed inspector and this adapter read during the call. */
  public readPaths(): readonly string[] {
    return [
      this.inspectorScriptPath,
      ...(this.hasTranslations
        ? [this.prepareScriptPath, this.verifyScriptPath]
        : []),
      ...(this.sourceValue === undefined ? [] : [this.sourceValue.display]),
      ...this.replacementsValue.map((fingerprint) => fingerprint.display),
      ...(this.originalCsvValue === undefined
        ? []
        : [this.originalCsvValue.display]),
      ...(this.preparedCsvValue === undefined
        ? []
        : [this.preparedCsvValue.display]),
      ...(this.hasTranslations
        ? [
            this.preparationRequestPathValue,
            this.verificationRequestPathValue,
            this.preparationReportPathValue,
            this.verificationReportPathValue,
          ]
        : []),
      this.sourceReportPathValue,
      this.outputReportPathValue,
    ];
  }

  /** Host-written requests/staged copies, native reports and adapter verification evidence. */
  public evidencePaths(): readonly string[] {
    return [
      this.sourceReportPathValue,
      this.outputReportPathValue,
      this.verificationPath,
      ...(this.preparedCsvValue === undefined
        ? []
        : [this.preparedCsvValue.display]),
      ...(this.hasTranslations
        ? [
            this.preparationRequestPathValue,
            this.verificationRequestPathValue,
            this.preparationReportPathValue,
            this.verificationReportPathValue,
          ]
        : []),
    ];
  }

  /** The verified output package is the only package-patch output artifact. */
  public inventoryRoots(): readonly ArtifactRoot[] {
    const destination = this.destinationValue;
    if (destination === undefined) return [];
    return [{ path: destination.effectiveRealPath, role: "output-package" }];
  }

  /**
   * Fingerprint the source and every replacement, stage the operation-owned
   * BOM-stripped translation CSV when requested, reject aliases/collisions, and
   * resolve a safe, absent, non-overlapping output destination. No native work
   * is launched here, and no patch mutation can occur before inspection.
   */
  public async prepare(): Promise<void> {
    await assertInspectorInstalled(this.inspectorScriptPath);
    if (this.hasTranslations) {
      await assertFixedScriptInstalled(
        this.prepareScriptPath,
        "combined translation preparation script",
      );
      await assertFixedScriptInstalled(
        this.verifyScriptPath,
        "combined translation verification script",
      );
    }
    checkBudget(this.signal);
    const source = await fingerprintFile(
      this.workspace,
      this.input.source,
      "package source",
      this.signal,
    );
    const replacements: PckPatchFingerprint[] = [];
    for (const [index, mapping] of this.input.patches.entries()) {
      checkBudget(this.signal);
      replacements.push(
        await fingerprintFile(
          this.workspace,
          mapping.hostSource,
          `package replacement at index ${String(index)}`,
          this.signal,
        ),
      );
    }
    const originalCsv =
      this.input.translations === undefined
        ? undefined
        : await this.fingerprintCombinedCsv();
    this.assertDistinctHostFiles(source, replacements, originalCsv);
    const destination = await this.resolveDestination(
      source,
      replacements,
      originalCsv === undefined ? [] : [originalCsv],
    );
    this.sourceValue = source;
    this.replacementsValue = replacements;
    this.destinationValue = destination;
    if (originalCsv !== undefined) {
      await this.stageCombinedCsv(originalCsv, source, replacements);
    }
  }

  private async fingerprintCombinedCsv(): Promise<PckPatchFingerprint> {
    const mapping = this.input.translations![0]!;
    return fingerprintFile(
      this.workspace,
      mapping.csv,
      "translation CSV",
      this.signal,
    );
  }

  /**
   * Validate the admitted CSV and write the operation-owned initial-BOM-stripped
   * copy consumed by the native CLI. The original host CSV is never rewritten.
   */
  private async stageCombinedCsv(
    original: PckPatchFingerprint,
    source: PckPatchFingerprint,
    replacements: readonly PckPatchFingerprint[],
  ): Promise<void> {
    checkBudget(this.signal);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(original.display);
    } catch (error) {
      throw new PckPatchOperationError(
        "validation_failed",
        `translation CSV could not be read: ${original.display}`,
        { cause: error },
      );
    }
    if (hashBytes(bytes) !== original.sha256) {
      throw new PckPatchOperationError(
        "validation_failed",
        `translation CSV changed between fingerprinting and staging: ${original.display}`,
      );
    }
    let decoded: ReturnType<typeof decodeTranslationCsv>;
    let parsed: ReturnType<typeof parseTranslationCsv>;
    try {
      decoded = decodeTranslationCsv(bytes);
      parsed = parseTranslationCsv(decoded.text);
    } catch (error) {
      throw new PckPatchOperationError(
        "validation_failed",
        error instanceof TranslationCsvValidationError
          ? error.message
          : messageOf(error, "translation CSV validation failed"),
        { cause: error },
      );
    }
    const locales = this.input.locales;
    if (locales !== undefined) {
      for (const locale of locales) {
        if (!parsed.localeColumns.includes(locale)) {
          throw new PckPatchOperationError(
            "validation_failed",
            `explicit locale is absent from the translation CSV columns: ${locale}`,
          );
        }
      }
    }
    const preparedPath = joinPath(
      this.operationDirectory,
      PCK_PATCH_EVIDENCE_NAMESPACE,
      "prepared-0.csv",
    );
    const preparedBytes = decoded.bomNormalized
      ? bytes.subarray(3)
      : bytes;
    try {
      await fs.mkdir(
        joinPath(this.operationDirectory, PCK_PATCH_EVIDENCE_NAMESPACE),
        { recursive: true },
      );
      await fs.writeFile(preparedPath, preparedBytes, {
        flag: "wx",
      });
    } catch (error) {
      throw new PckPatchOperationError(
        "storage_failed",
        `operation-owned translation CSV copy could not be staged: ${bounded(error, "write failure")}`,
        { cause: error },
      );
    }
    const prepared = await fingerprintFile(
      this.workspace,
      preparedPath,
      "prepared translation CSV",
      this.signal,
    );
    for (const [index, host] of [
      source,
      ...replacements,
      original,
    ].entries()) {
      if (sameFile(host, prepared)) {
        throw new PckPatchOperationError(
          "validation_failed",
          `the operation-owned prepared translation CSV aliases host input ${String(index)}`,
        );
      }
    }
    const destination = this.requireDestination();
    if (pathOverlaps(destination.effectiveIdentity, prepared.identity)) {
      throw new PckPatchOperationError(
        "path_unsupported",
        "package-patch output overlaps the operation-owned prepared translation CSV",
      );
    }
    this.originalCsvValue = original;
    this.preparedCsvValue = prepared;
    this.combinedBomNormalized = decoded.bomNormalized;
    this.combinedRequestValue = {
      resource: this.input.translations![0]!.resource,
      csv: prepared.display,
      columns: parsed.columns,
      rows: parsed.rows,
    };
  }

  /** Recheck host identities, staged copies, fixed scripts and absent output. */
  public async revalidate(): Promise<void> {
    const source = this.requireSource();
    const replacements = this.replacementsValue;
    checkBudget(this.signal);
    await assertInspectorInstalled(this.inspectorScriptPath);
    if (this.hasTranslations) {
      await assertFixedScriptInstalled(
        this.prepareScriptPath,
        "combined translation preparation script",
      );
      await assertFixedScriptInstalled(
        this.verifyScriptPath,
        "combined translation verification script",
      );
    }
    const currentSource = await fingerprintFile(
      this.workspace,
      this.input.source,
      "package source",
      this.signal,
    );
    if (!sameFingerprint(source, currentSource)) {
      throw new PckPatchOperationError(
        "validation_failed",
        `package source identity or content changed before launch: ${this.input.source}`,
      );
    }
    for (const [index, previous] of replacements.entries()) {
      checkBudget(this.signal);
      const mapping = this.input.patches[index]!;
      const current = await fingerprintFile(
        this.workspace,
        mapping.hostSource,
        `package replacement at index ${String(index)}`,
        this.signal,
      );
      if (!sameFingerprint(previous, current)) {
        throw new PckPatchOperationError(
          "validation_failed",
          `package replacement identity or content changed before launch: ${mapping.hostSource}`,
        );
      }
    }
    if (this.originalCsvValue !== undefined) {
      const current = await fingerprintFile(
        this.workspace,
        this.input.translations![0]!.csv,
        "translation CSV",
        this.signal,
      );
      if (!sameFingerprint(this.originalCsvValue, current)) {
        throw new PckPatchOperationError(
          "validation_failed",
          `translation CSV identity or content changed before launch: ${this.input.translations![0]!.csv}`,
        );
      }
    }
    if (this.preparedCsvValue !== undefined) {
      const current = await fingerprintFile(
        this.workspace,
        this.preparedCsvValue.display,
        "prepared translation CSV",
        this.signal,
      );
      if (!sameFingerprint(this.preparedCsvValue, current)) {
        throw new PckPatchOperationError(
          "validation_failed",
          "the operation-owned prepared translation CSV changed before launch",
        );
      }
    }
    const destination = this.requireDestination();
    let resolved: Awaited<ReturnType<typeof canonicalizePath>>;
    try {
      resolved = await canonicalizePath(destination.effectiveOutput);
    } catch (error) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output could not be re-resolved before launch: ${destination.effectiveOutput}`,
        { cause: error },
      );
    }
    if (resolved.identity !== destination.effectiveIdentity) {
      throw new PckPatchOperationError(
        "path_unsupported",
        "package-patch output identity changed before launch",
      );
    }
    await this.assertDestinationAbsent(destination);
  }

  /**
   * Accept a natural, complete source inspection. The report must describe the
   * admitted source, be unencrypted, contain unique canonical members and name
   * every admitted target exactly. Rejection returns bounded semantic data and
   * writes verification here, before any patch mutation; it never throws for a
   * report/content rejection.
   */
  public async acceptSourceInspection(
    observation: ProcessObservation,
  ): Promise<SourceInspectionAssessment> {
    const source = this.requireSource();
    const processFailure = this.inspectProcessFailure(observation);
    if (processFailure !== null) {
      return this.sourceRejection(
        "unknown",
        "semantic_unknown",
        processFailure.message,
        [processFailure.message],
        null,
      );
    }
    let report: PckPatchInspectionReport;
    try {
      report = await this.readInspectionReport(
        this.sourceReportPathValue,
        "source",
      );
    } catch (error) {
      const code =
        error instanceof PckPatchOperationError
          ? error.code
          : "semantic_unknown";
      const message = messageOf(error, "source inspection report is unavailable");
      return this.sourceRejection("unknown", code, message, [message], null);
    }
    if (!report.ok) {
      const message = `the fixed package inspector rejected the source package: ${report.error ?? "no native message"}`;
      return this.sourceRejection(
        "failed",
        "semantic_failed",
        message,
        [report.error ?? "Native source inspection returned ok:false."],
        report,
      );
    }
    if (!packagePathMatches(report.packagePath, source.display, source.identity)) {
      return this.sourceRejection(
        "unknown",
        "semantic_unknown",
        `the source inspection report describes a different package: ${report.packagePath}`,
        [
          `Reported package ${report.packagePath} does not match ${source.display}.`,
        ],
        report,
      );
    }
    const metadata = report.metadata!;
    if (metadata.encrypted) {
      return this.sourceRejection(
        "failed",
        "semantic_failed",
        "encrypted source packages are not supported by the standalone patch route",
        ["The source inspection metadata reports encrypted:true."],
        report,
      );
    }
    const members = report.members!;
    const memberSet = new Set(members.map((member) => member.logicalMember));
    for (const mapping of this.input.patches) {
      if (!memberSet.has(mapping.logicalMember)) {
        const message = `admitted logical member is not an existing source member: ${mapping.logicalMember}`;
        return this.sourceRejection(
          "failed",
          "validation_failed",
          message,
          [message],
          report,
        );
      }
    }
    this.sourceReportValue = report;
    this.sourceMembersValue = members.map((member) => member.logicalMember);
    return { accepted: true, code: null, evaluation: null };
  }

  /**
   * Bounded source inspection rejection: retain report existence and any parsed
   * report, but never hash a package or launch further work.
   */
  private async sourceRejection(
    completeness: PckPatchSemanticData["completeness"],
    code: PckPatchOperationError["code"],
    summary: string,
    evidence: readonly string[],
    report: PckPatchInspectionReport | null,
  ): Promise<SourceInspectionAssessment> {
    const observation = await observeAvailable(this.sourceReportPathValue);
    const sourceReportPath =
      report !== null || observation.exists === true
        ? this.sourceReportPathValue
        : null;
    const diagnostics = [summary, ...evidence]
      .slice(0, 16)
      .map((entry) => bounded(entry, "package-patch diagnostic"));
    const data: PckPatchSemanticData = {
      completeness,
      outputPath: bounded(
        this.destinationValue?.effectiveOutput ?? "",
        "output path",
      ),
      counts: {
        mappings: this.input.patches.length,
        verifiedReplacements: 0,
        verifiedRetainedMembers: 0,
        unverifiedFiles: 0,
      },
      reports: {
        sourceInspection: sourceReportPath,
        outputInspection: null,
        verification: this.verificationPath,
      },
      samples: {
        replacements: [],
        retainedMembers: [],
        unverifiedFiles: [],
        truncated: false,
      },
      diagnostics,
    };
    await this.writeVerification({
      schemaVersion: 1,
      rule: PCK_PATCH_RULE,
      completeness,
      stopped: false,
      stage: "source-inspection",
      code,
      summary,
      evidence: [...evidence],
      reportsParsed: report !== null,
      sourceInspection: report,
      sourceReportObservation: observation,
      availableFiles: [],
      inputFingerprintsRechecked: false,
      inventoryAuditedByOperation: false,
    });
    return {
      accepted: false,
      code,
      evaluation: {
        status: code === "semantic_unknown" ? "unknown" : "failed",
        rule: PCK_PATCH_RULE,
        summary: bounded(summary, "package-patch source inspection failed"),
        evidence: evidence
          .slice(0, MAX_EVIDENCE)
          .map((entry) => bounded(entry, "package-patch evidence")),
        data,
      },
    };
  }

  private requireCombinedExpectation(): CombinedPreparationExpectation {
    const source = this.requireSource();
    const translation = this.combinedRequestValue;
    const owned = this.combinedOwnedEnvironmentValue;
    if (translation === undefined || owned === undefined) {
      throw new PckPatchOperationError(
        "validation_failed",
        "combined translation preparation was not staged",
      );
    }
    return {
      source: source.display,
      translation,
      locales: this.input.locales ?? [],
      sourceMembers: this.sourceMembersValue,
      ordinaryMembers: this.input.patches.map((mapping) => mapping.logicalMember),
      ownedEnvironment: owned,
    };
  }

  private async writeCombinedRequest(
    target: string,
    value: unknown,
  ): Promise<void> {
    try {
      await fs.mkdir(
        joinPath(this.operationDirectory, PCK_PATCH_EVIDENCE_NAMESPACE),
        { recursive: true },
      );
      await fs.writeFile(target, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      throw new PckPatchOperationError(
        "storage_failed",
        `combined translation request could not be written: ${bounded(error, "write failure")}`,
        { cause: error },
      );
    }
  }

  private async readCombinedReport(
    reportPath: string,
    label: "preparation" | "verification",
  ): Promise<unknown> {
    let text: string;
    try {
      text = await fs.readFile(reportPath, "utf8");
    } catch (error) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        `the combined ${label} report could not be read: ${reportPath}`,
        { cause: error },
      );
    }
    if (label === "preparation") {
      this.preparationReportKnownPresent = true;
    } else {
      this.verificationReportKnownPresent = true;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        `the combined ${label} report is not valid JSON.`,
        { cause: error },
      );
    }
  }

  /**
   * Accept the fixed read-only preparation report before any mutation. Report
   * failure is a terminal failed operation: no direct patch launch follows.
   */
  public async acceptPreparation(
    observation: ProcessObservation,
  ): Promise<CombinedReportAssessment> {
    const processFailure = this.inspectCombinedProcessFailure(observation);
    if (processFailure !== null) {
      return this.combinedRejection(
        "unknown",
        processFailure.message,
        [processFailure.message],
        processFailure.code,
      );
    }
    let report: CombinedPrepareReport;
    try {
      const value = await this.readCombinedReport(
        this.preparationReportPathValue,
        "preparation",
      );
      report = acceptCombinedPrepareReport(
        value,
        this.requireCombinedExpectation(),
      );
    } catch (error) {
      const code =
        error instanceof PckPatchOperationError
          ? error.code
          : "semantic_unknown";
      const message = messageOf(
        error,
        "combined preparation report is unavailable",
      );
      return this.combinedRejection("unknown", message, [message], code);
    }
    if (!report.ok) {
      const message = `the fixed combined preparation rejected the request: ${report.error ?? "no native message"}`;
      return this.combinedRejection(
        "failed",
        message,
        [report.error ?? "Native combined preparation returned ok:false."],
        "semantic_failed",
      );
    }
    if (observation.exitCode !== 0) {
      const message =
        "the combined preparation report claims success from a nonzero natural exit.";
      return this.combinedRejection("unknown", message, [message], "semantic_unknown");
    }
    this.preparedReportValue = report;
    return { accepted: true, code: null, evaluation: null };
  }

  private async combinedRejection(
    completeness: PckPatchSemanticData["completeness"],
    summary: string,
    evidence: readonly string[],
    code: PckPatchOperationError["code"],
  ): Promise<CombinedReportAssessment> {
    const destination = this.requireDestination();
    const evaluation = await this.failureAssessment(
      destination,
      completeness,
      summary,
      evidence,
      code,
      false,
    );
    return {
      accepted: false,
      code,
      evaluation: evaluation.evaluation,
    };
  }

  /**
   * Classify the direct patch launch before any output inspection. Exit zero,
   * output existence and the success marker separately; content verification
   * still follows. Failure detail keeps acquired streams and available
   * output/.tmp observations without a post-stop audit.
   */
  public async classifyPatch(
    observation: ProcessObservation,
  ): Promise<PatchLaunchAssessment> {
    const destination = this.requireDestination();
    const processFailure = this.inspectProcessFailure(observation);
    if (processFailure !== null) {
      return this.failureAssessment(
        destination,
        processFailure.code === "semantic_unknown" ? "unknown" : "failed",
        processFailure.message,
        [processFailure.message],
        processFailure.code,
        false,
      );
    }
    const stdout = await readCompleteStream(
      observation.stdoutEvidence,
      observation.stdout,
    );
    const stderr = await readCompleteStream(
      observation.stderrEvidence,
      observation.stderr,
    );
    if (stdout === null || stderr === null) {
      return this.failureAssessment(
        destination,
        "unknown",
        "Complete retained stdout/stderr evidence could not be read; package-patch success cannot be claimed.",
        ["The direct patch launch did not retain complete stream evidence."],
        "semantic_unknown",
        false,
      );
    }
    // Native stdout may spell the destination with forward slashes while the
    // host effective output keeps Windows backslashes. Accept only the whole
    // marker with either exact spelling; no path normalization or substring
    // matching is applied.
    const expectedMarker = `Patched PCK file: ${destination.effectiveOutput}`;
    const nativeMarker = `Patched PCK file: ${destination.effectiveOutput.replaceAll("\\", "/")}`;
    const acceptedMarkers =
      expectedMarker === nativeMarker
        ? [expectedMarker]
        : [expectedMarker, nativeMarker];
    if (
      !splitProgressLines(stdout).some((line) =>
        acceptedMarkers.includes(line.trim()),
      )
    ) {
      return this.failureAssessment(
        destination,
        "failed",
        "The direct patch launch did not report the expected output success marker.",
        [
          `Expected a complete stdout marker matching ${acceptedMarkers
            .map((value) => JSON.stringify(value))
            .join(" or ")}.`,
        ],
        "semantic_failed",
        true,
      );
    }
    const errors = [...patchErrorLines(stdout), ...patchErrorLines(stderr)];
    if (errors.length > 0) {
      return this.failureAssessment(
        destination,
        "failed",
        "The direct patch launch retained native patch-error diagnostics.",
        errors.slice(0, MAX_SAMPLE),
        "semantic_failed",
        true,
      );
    }
    let stats: BigIntStats;
    try {
      stats = await fs.lstat(destination.effectiveOutput, { bigint: true });
    } catch (error) {
      return this.failureAssessment(
        destination,
        "unknown",
        "The direct patch launch reported success but the output package is missing or uninspectable.",
        [bounded(error, "output package could not be inspected")],
        "semantic_unknown",
        true,
      );
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return this.failureAssessment(
        destination,
        "failed",
        "The direct patch output is not a regular package file.",
        [`Observed non-regular output: ${destination.effectiveOutput}`],
        "semantic_failed",
        true,
      );
    }
    this.patchStreams = { stdout, stderr };
    return { proceed: true, evaluation: null };
  }

  /**
   * Only an accepted pre-mutation preparation report names exact generated
   * members. Their native `.tmp_translations` paths are observed by lstat for
   * availability; unknown siblings are never enumerated or hashed.
   */
  private knownCombinedTempPaths(): readonly {
    readonly member: string;
    readonly path: string;
  }[] {
    const report = this.preparedReportValue;
    const owned = this.combinedOwnedEnvironmentValue;
    if (!this.hasTranslations || report === undefined || owned === undefined) {
      return [];
    }
    const members = [
      ...report.outputs.map((output) => output.member),
      ...(report.projectConfig === null ? [] : [report.projectConfig.member]),
    ];
    const base = joinPath(owned.userData, ".tmp_translations");
    const seen = new Set<string>();
    const paths: { member: string; path: string }[] = [];
    for (const member of members) {
      if (!member.startsWith("res://")) continue;
      const relative = member.slice("res://".length);
      if (relative.length === 0) continue;
      const target = joinPath(base, relative);
      const identity = pathIdentity(target);
      if (seen.has(identity)) continue;
      seen.add(identity);
      paths.push({ member, path: target });
    }
    return paths;
  }

  private async observeKnownCombinedTempFiles(): Promise<
    readonly CombinedTempObservation[]
  > {
    return Promise.all(
      this.knownCombinedTempPaths().map(async (entry) => ({
        ...entry,
        observation: await observeAvailable(entry.path),
      })),
    );
  }

  /**
   * Bounded post-stop assessment: retain only already-available output/.tmp and
   * specifically known prepared temp observations. This never reads an
   * inspection report, fingerprints an input, hashes a payload or runs an
   * inventory. Terminal status, timeout, cancellation and cleanup classification
   * stay owned by shared Execution.
   */
  public async assessStopped(
    observation: ProcessObservation,
    stage:
      | "source-inspection"
      | "patch"
      | "output-inspection"
      | "combined-preparation"
      | "verification",
  ): Promise<EvaluationResult<PckPatchSemanticData>> {
    const destination = this.requireDestination();
    const available: AvailableObservation[] = [];
    for (const file of [
      destination.effectiveOutput,
      `${destination.effectiveOutput}.tmp`,
    ]) {
      available.push(await observeAvailable(file));
    }
    const combinedTempObservations = await this.observeKnownCombinedTempFiles();
    available.push(
      ...combinedTempObservations.map((entry) => entry.observation),
    );
    const unverified = available
      .filter((entry) => entry.exists === true)
      .map((entry) => entry.path);
    const sourceReportObservation =
      stage === "source-inspection"
        ? await observeAvailable(this.sourceReportPathValue)
        : null;
    const combinedReportObservation =
      stage === "combined-preparation"
        ? await observeAvailable(this.preparationReportPathValue)
        : stage === "verification"
          ? await observeAvailable(this.verificationReportPathValue)
          : null;
    if (stage === "combined-preparation") {
      this.preparationReportKnownPresent =
        combinedReportObservation?.exists === true;
    } else if (stage === "verification") {
      this.verificationReportKnownPresent =
        combinedReportObservation?.exists === true;
    }
    const sourceReportPath =
      sourceReportObservation?.exists === true
        ? this.sourceReportPathValue
        : null;
    const summary =
      stage === "source-inspection"
        ? "The source inspection stopped before its report could be accepted."
        : stage === "patch"
          ? "The direct package-patch launch stopped before content verification."
          : stage === "output-inspection"
            ? "The package output inspection stopped before content verification."
            : stage === "combined-preparation"
              ? "The combined translation preparation stopped before its report could be accepted; no direct patch was launched."
              : "The combined translation verification stopped before its report could be accepted.";
    const diagnostics = [
      summary,
      `Observed exit code ${String(observation.exitCode)} and signal ${String(observation.signal)}.`,
      ...(sourceReportObservation === null
        ? []
        : [
            sourceReportObservation.exists === true
              ? `Acquired source inspection report was retained without parsing after stop: ${this.sourceReportPathValue}`
              : "No source inspection report was acquired before stop.",
          ]),
      ...(combinedReportObservation === null
        ? []
        : [
            combinedReportObservation.exists === true
              ? `Acquired combined ${stage === "verification" ? "verification" : "preparation"} report was retained without parsing after stop: ${combinedReportObservation.path}`
              : `No combined ${stage === "verification" ? "verification" : "preparation"} report was acquired before stop.`,
          ]),
      ...unverified.map(
        (file) =>
          `Unverified package-patch output or temporary observation retained without content audit: ${file}`,
      ),
    ];
    const data = this.baseData(
      "unknown",
      {
        mappings: this.input.patches.length,
        verifiedReplacements: 0,
        verifiedRetainedMembers: 0,
        unverifiedFiles: unverified.length,
      },
      diagnostics,
      [],
      [],
      unverified,
    );
    // A stopped run never acquired a parsed output inspection report.
    const stoppedData: PckPatchSemanticData = {
      ...data,
      reports: {
        ...data.reports,
        outputInspection: null,
        ...(sourceReportObservation === null
          ? {}
          : { sourceInspection: sourceReportPath }),
      },
    };
    await this.writeVerification({
      schemaVersion: 1,
      rule: PCK_PATCH_RULE,
      completeness: "unknown",
      stopped: true,
      stage,
      exitCode: observation.exitCode,
      signal: observation.signal,
      reportsParsed: false,
      inputFingerprintsRechecked: false,
      outputPath: destination.effectiveOutput,
      effectiveOutputRealPath: destination.effectiveRealPath,
      mappings: this.input.patches.map((mapping, index) => ({
        logicalMember: mapping.logicalMember,
        hostSource: this.replacementsValue[index]?.display ?? null,
      })),
      sourceInspection: this.sourceReportValue ?? null,
      sourceReportObservation,
      combinedReportObservation,
      combinedTempObservations,
      availableFiles: available,
      inventoryAuditedByOperation: false,
    });
    return {
      status: "unknown",
      rule: PCK_PATCH_RULE,
      summary: bounded(summary, "package-patch stopped"),
      evidence: [bounded(summary, "package-patch stopped")],
      data: stoppedData,
    };
  }

  /**
   * Compare complete source/output inspection reports and independently
   * acquired ordinary payload bytes. Combined calls finalize only through the
   * independent native getter verification launch; this method is the ordinary
   * success path.
   */
  public async evaluate(
    patchObservation: ProcessObservation,
    outputInspectionObservation: ProcessObservation,
  ): Promise<EvaluationResult<PckPatchSemanticData>> {
    const destination = this.requireDestination();
    if (this.hasTranslations) {
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          "Combined package-patch content cannot be finalized without independent getter verification.",
          [
            "The direct content assessment must be followed by the fixed combined verification launch.",
          ],
          "semantic_unknown",
          true,
        )
      ).evaluation!;
    }
    const assessment = await this.assessContentInspection(
      outputInspectionObservation,
    );
    if (!assessment.proceed) return assessment.evaluation;
    const outcome = assessment.outcome;
    const verifiedReplacements = outcome.verifiedReplacements;
    const verifiedRetained = outcome.verifiedRetained;
    const patchStreams = outcome.patchStreams;

    const data = this.baseData(
      "complete",
      {
        mappings: this.input.patches.length,
        verifiedReplacements: verifiedReplacements.length,
        verifiedRetainedMembers: verifiedRetained.length,
        unverifiedFiles: 0,
      },
      [],
      verifiedReplacements,
      verifiedRetained,
      [],
    );
    await this.writeVerification({
      schemaVersion: 1,
      rule: PCK_PATCH_RULE,
      completeness: "complete",
      outputPath: destination.effectiveOutput,
      effectiveOutputRealPath: destination.effectiveRealPath,
      mappings: this.input.patches.map((mapping, index) => ({
        logicalMember: mapping.logicalMember,
        hostSource: this.replacementsValue[index]!.display,
        bytes: this.replacementsValue[index]!.bytes,
        sha256: this.replacementsValue[index]!.sha256,
      })),
      sourceFingerprint: this.sourceValue,
      replacementFingerprints: this.replacementsValue,
      sourceInspection: this.sourceReportValue!,
      outputInspection: outcome.outputReport,
      verifiedReplacements,
      verifiedRetainedMembers: verifiedRetained,
      patchProcess: {
        exitCode: patchObservation.exitCode,
        stdoutBytes: Buffer.byteLength(patchStreams.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(patchStreams.stderr, "utf8"),
      },
      outputInspectionProcess: {
        exitCode: outputInspectionObservation.exitCode,
        signal: outputInspectionObservation.signal,
      },
      inventoryAuditedByOperation: false,
    });

    return {
      status: "succeeded",
      rule: PCK_PATCH_RULE,
      summary:
        "GDRE patched the standalone package with a complete source/output inspection and verified replacement and retained payloads.",
      evidence: [
        "The source and output inspection reports describe the same unencrypted metadata and exact logical member set.",
        `Verified ${String(verifiedReplacements.length)} replacement payload(s) against independently acquired host files.`,
        `Verified ${String(verifiedRetained.length)} retained member payload(s) against the inspected source.`,
        "Source and replacement host file identities and content were unchanged after patching.",
      ]
        .slice(0, MAX_EVIDENCE)
        .map((entry) => bounded(entry, "package-patch evidence")),
      data,
    };
  }

  /**
   * Accept output metadata/member bytes before the independent getter launch.
   * Selected translation members and the regenerated project configuration are
   * excluded from byte retention because native getters verify that evidence;
   * only permitted new-locale additions may extend the source member set.
   */
  public async assessCombinedContent(
    outputInspectionObservation: ProcessObservation,
  ): Promise<CombinedContentAssessment> {
    const destination = this.requireDestination();
    if (!this.hasTranslations || this.preparedReportValue === undefined) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            "Combined package-patch content assessment was invoked without accepted preparation evidence.",
            ["No accepted combined preparation report was available."],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }
    const assessment = await this.assessContentInspection(
      outputInspectionObservation,
    );
    if (!assessment.proceed) {
      return { proceed: false, evaluation: assessment.evaluation };
    }
    this.combinedContentValue = assessment.outcome;
    return { proceed: true, evaluation: null };
  }

  /**
   * Accept the independent native getter verification over the output package.
   * Complete success requires the accepted preparation, the byte/member gate
   * and every expected getter observation to agree.
   */
  public async acceptVerification(
    observation: ProcessObservation,
  ): Promise<EvaluationResult<PckPatchSemanticData>> {
    const destination = this.requireDestination();
    const prepared = this.preparedReportValue;
    const content = this.combinedContentValue;
    const owned = this.combinedOwnedEnvironmentValue;
    if (
      prepared === undefined ||
      content === undefined ||
      owned === undefined
    ) {
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          "Combined verification was invoked without accepted preparation and content evidence.",
          [
            "The byte/member gate or the owned profile context was not accepted before verification.",
          ],
          "semantic_unknown",
          true,
        )
      ).evaluation!;
    }
    const processFailure = this.inspectCombinedProcessFailure(observation);
    if (processFailure !== null) {
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          "The combined verification did not complete naturally; getter success cannot be claimed.",
          [processFailure.message],
          "semantic_unknown",
          true,
        )
      ).evaluation!;
    }
    let report: CombinedVerificationReport;
    try {
      const value = await this.readCombinedReport(
        this.verificationReportPathValue,
        "verification",
      );
      report = acceptCombinedVerificationReport(value, {
        package: destination.effectiveOutput,
        outputs: prepared.outputs,
        retainedLocales: prepared.retainedLocales,
        projectConfig: prepared.projectConfig,
        ownedEnvironment: owned,
      });
    } catch (error) {
      const code =
        error instanceof PckPatchOperationError
          ? error.code
          : "semantic_unknown";
      const message = messageOf(
        error,
        "combined verification report is unavailable",
      );
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          message,
          [message],
          code,
          true,
        )
      ).evaluation!;
    }
    if (!report.ok) {
      const message = `the fixed combined verification rejected the output: ${report.error ?? "no native message"}`;
      return (
        await this.failureAssessment(
          destination,
          "failed",
          message,
          [report.error ?? "Native combined verification returned ok:false."],
          "semantic_failed",
          true,
        )
      ).evaluation!;
    }
    if (observation.exitCode !== 0) {
      const message =
        "the combined verification report claims success from a nonzero natural exit.";
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          message,
          [message],
          "semantic_unknown",
          true,
        )
      ).evaluation!;
    }
    // No complete success while a protected input or the prepared copy changed
    // at any point through the independent verification.
    try {
      await this.confirmInputsUnchanged();
    } catch (error) {
      const message = messageOf(
        error,
        "combined input identity could not be confirmed after verification",
      );
      return (
        await this.failureAssessment(
          destination,
          "unknown",
          message,
          [message],
          "semantic_unknown",
          true,
        )
      ).evaluation!;
    }
    this.verifiedReportValue = report;
    const verifiedTexts = report.outputs.reduce(
      (total, output) => total + output.verifiedTexts,
      0,
    );

    const data = this.baseData(
      "complete",
      {
        mappings: this.input.patches.length,
        verifiedReplacements: content.verifiedReplacements.length,
        verifiedRetainedMembers: content.verifiedRetained.length,
        unverifiedFiles: 0,
      },
      [],
      content.verifiedReplacements,
      content.verifiedRetained,
      [],
    );
    await this.writeVerification({
      schemaVersion: 1,
      rule: PCK_PATCH_RULE,
      completeness: "complete",
      outputPath: destination.effectiveOutput,
      effectiveOutputRealPath: destination.effectiveRealPath,
      sourceFingerprint: this.sourceValue,
      replacementFingerprints: this.replacementsValue,
      originalCsvFingerprint: this.originalCsvValue,
      preparedCsvFingerprint: this.preparedCsvValue,
      sourceInspection: this.sourceReportValue!,
      outputInspection: content.outputReport,
      verifiedReplacements: content.verifiedReplacements,
      verifiedRetainedMembers: content.verifiedRetained,
      combinedOutputs: prepared.outputs.map((output) => ({
        resource: output.resource,
        member: output.member,
        locale: output.locale,
        kind: output.kind,
      })),
      combinedRetainedLocales: prepared.retainedLocales.map((entry) => ({
        resource: entry.resource,
        member: entry.member,
        locale: entry.locale,
      })),
      combinedProjectConfig: prepared.projectConfig,
      preparationReport: this.preparationReportPathValue,
      verificationReport: this.verificationReportPathValue,
      combinedVerification: report,
      inventoryAuditedByOperation: false,
    });

    return {
      status: "succeeded",
      rule: PCK_PATCH_RULE,
      summary:
        "GDRE patched the package with host-prepared translations, exact byte/member checks and independent native getter verification.",
      evidence: [
        "The accepted preparation identified the actual native import, default-locale and generated destination identities before mutation.",
        "The output package metadata and member set matched the source plus only permitted additions.",
        `Verified ${String(content.verifiedReplacements.length)} ordinary replacement payload(s) and ${String(content.verifiedRetained.length)} byte-retained member payload(s).`,
        `Native getters verified ${String(report.outputs.length)} translation output(s), ${String(verifiedTexts)} requested text(s) and ${String(report.retainedLocales.length)} retained locale(s).`,
        `The project configuration verification ${prepared.projectConfig === null ? "confirmed actual absence" : "matched the expected registration"}.`,
        "Source package, replacement files, original CSV and operation-owned prepared CSV were unchanged.",
      ]
        .slice(0, MAX_EVIDENCE)
        .map((entry) => bounded(entry, "package-patch evidence")),
      data,
    };
  }

  /**
   * Re-fingerprint every protected host input and the operation-owned prepared
   * copy. This never re-asserts destination absence, so it is safe after output
   * exists and immediately before a complete success is published.
   */
  private async confirmInputsUnchanged(): Promise<void> {
    const currentSource = await fingerprintFile(
      this.workspace,
      this.input.source,
      "package source",
      this.signal,
    );
    if (!sameFingerprint(this.sourceValue!, currentSource)) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        "The source package identity or content changed during patching.",
      );
    }
    for (const [index, previous] of this.replacementsValue.entries()) {
      const mapping = this.input.patches[index]!;
      const current = await fingerprintFile(
        this.workspace,
        mapping.hostSource,
        `package replacement at index ${String(index)}`,
        this.signal,
      );
      if (!sameFingerprint(previous, current)) {
        throw new PckPatchOperationError(
          "semantic_unknown",
          `The replacement host file changed during patching: ${mapping.hostSource}`,
        );
      }
    }
    if (this.originalCsvValue !== undefined) {
      const current = await fingerprintFile(
        this.workspace,
        this.input.translations![0]!.csv,
        "translation CSV",
        this.signal,
      );
      if (!sameFingerprint(this.originalCsvValue, current)) {
        throw new PckPatchOperationError(
          "semantic_unknown",
          "The original translation CSV changed during patching.",
        );
      }
    }
    if (this.preparedCsvValue !== undefined) {
      const current = await fingerprintFile(
        this.workspace,
        this.preparedCsvValue.display,
        "prepared translation CSV",
        this.signal,
      );
      if (!sameFingerprint(this.preparedCsvValue, current)) {
        throw new PckPatchOperationError(
          "semantic_unknown",
          "The operation-owned prepared translation CSV changed during patching.",
        );
      }
    }
  }

  /**
   * Shared source/output content assessment. Ordinary calls use the base member
   * set and ordinary-target exclusions; combined calls additionally admit only
   * prepared new-locale members and exclude getter-verified selected/config
   * members from byte retention.
   */
  private async assessContentInspection(
    outputInspectionObservation: ProcessObservation,
  ): Promise<ContentAssessment> {
    const destination = this.requireDestination();
    const sourceReport = this.sourceReportValue;
    const patchStreams = this.patchStreams;
    if (sourceReport === undefined || patchStreams === undefined) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            "Package-patch content evaluation was invoked without accepted source and patch evidence.",
            [
              "No accepted source inspection or direct patch observation was available.",
            ],
            "semantic_unknown",
            false,
          )
        ).evaluation!,
      };
    }

    const processFailure = this.inspectProcessFailure(outputInspectionObservation);
    if (processFailure !== null) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            "The output inspection did not complete naturally; package-patch content success cannot be claimed.",
            [processFailure.message],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }
    let report: PckPatchInspectionReport;
    try {
      report = await this.readInspectionReport(this.outputReportPathValue, "output");
    } catch (error) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            messageOf(error, "output inspection report is unavailable"),
            [messageOf(error, "output inspection report is unavailable")],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }
    if (!report.ok) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "failed",
            `the fixed package inspector rejected the output package: ${report.error ?? "no native message"}`,
            [report.error ?? "Native output inspection returned ok:false."],
            "semantic_failed",
            true,
          )
        ).evaluation!,
      };
    }
    if (
      !packagePathMatches(
        report.packagePath,
        destination.effectiveOutput,
        destination.effectiveIdentity,
      )
    ) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            "The output inspection report describes a different package than the accepted output.",
            [
              `Reported package ${report.packagePath} does not match ${destination.effectiveOutput}.`,
            ],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }
    const outputMetadata = report.metadata!;
    if (
      outputMetadata.encrypted ||
      !sameMetadata(sourceReport.metadata!, outputMetadata)
    ) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "failed",
            "The output package metadata does not match the inspected source package.",
            [
              "Format version, engine version or encryption state changed between source and output.",
            ],
            "semantic_failed",
            true,
          )
        ).evaluation!,
      };
    }

    const outputMembers = new Map(
      report.members!.map((member) => [member.logicalMember, member]),
    );
    const sourceMembers = new Map(
      sourceReport.members!.map((member) => [member.logicalMember, member]),
    );
    const prepared = this.hasTranslations
      ? this.preparedReportValue
      : undefined;
    if (this.hasTranslations && prepared === undefined) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            "Combined content assessment was invoked without accepted preparation evidence.",
            ["No accepted combined preparation report was available."],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }
    const permittedMembers =
      prepared === undefined
        ? []
        : prepared.outputs
            .filter((output) => output.kind === "new")
            .map((output) => output.member);
    const expectedMembers = new Set([
      ...sourceMembers.keys(),
      ...permittedMembers,
    ]);
    const sameMemberSet =
      outputMembers.size === expectedMembers.size &&
      [...expectedMembers].every((member) => outputMembers.has(member));
    if (!sameMemberSet) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "failed",
            "The output package logical member set differs from the inspected source.",
            [
              this.hasTranslations
                ? "Package-patch output must retain the source member set plus only permitted new-locale additions."
                : "Package-patch output must retain exactly the source member set.",
            ],
            "semantic_failed",
            true,
          )
        ).evaluation!,
      };
    }

    const targetByMember = new Map(
      this.input.patches.map((mapping, index) => [
        mapping.logicalMember,
        this.replacementsValue[index]!,
      ]),
    );
    const verifiedReplacements: string[] = [];
    for (const [member, replacement] of targetByMember) {
      const observed = outputMembers.get(member)!;
      if (
        observed.size !== replacement.bytes ||
        observed.sha256 !== replacement.sha256
      ) {
        return {
          proceed: false,
          evaluation: (
            await this.failureAssessment(
              destination,
              "failed",
              `The output package does not contain the intended replacement payload for ${member}.`,
              [`Expected ${String(replacement.bytes)} bytes/${replacement.sha256}.`],
              "semantic_failed",
              true,
            )
          ).evaluation!,
        };
      }
      verifiedReplacements.push(member);
    }
    const excludedMembers = new Set<string>([
      ...targetByMember.keys(),
      ...(prepared === undefined
        ? []
        : prepared.outputs.map((output) => output.member)),
      ...(prepared?.projectConfig == null
        ? []
        : [prepared.projectConfig.member]),
    ]);
    const verifiedRetained: string[] = [];
    for (const [member, sourceMember] of sourceMembers) {
      if (excludedMembers.has(member)) continue;
      const observed = outputMembers.get(member)!;
      if (
        observed.size !== sourceMember.size ||
        observed.sha256 !== sourceMember.sha256
      ) {
        return {
          proceed: false,
          evaluation: (
            await this.failureAssessment(
              destination,
              "failed",
              `The output package did not retain the original payload for ${member}.`,
              [`Expected ${String(sourceMember.size)} bytes/${sourceMember.sha256}.`],
              "semantic_failed",
              true,
            )
          ).evaluation!,
        };
      }
      verifiedRetained.push(member);
    }

    // Inputs must be unchanged after the native transaction. This is a content
    // recheck only; it must never re-assert destination absence after output
    // exists.
    try {
      await this.confirmInputsUnchanged();
    } catch (error) {
      return {
        proceed: false,
        evaluation: (
          await this.failureAssessment(
            destination,
            "unknown",
            messageOf(error, "package-patch input identity could not be reverified"),
            [messageOf(error, "package-patch input identity could not be reverified")],
            "semantic_unknown",
            true,
          )
        ).evaluation!,
      };
    }

    return {
      proceed: true,
      outcome: {
        outputReport: report,
        patchStreams,
        verifiedReplacements,
        verifiedRetained,
      },
    };
  }
  private requireSource(): PckPatchFingerprint {
    if (this.sourceValue === undefined) {
      throw new PckPatchOperationError(
        "validation_failed",
        "package source was not prepared",
      );
    }
    return this.sourceValue;
  }

  private requireDestination(): PckPatchDestination {
    if (this.destinationValue === undefined) {
      throw new PckPatchOperationError(
        "path_unsupported",
        "package-patch destination was not prepared",
      );
    }
    return this.destinationValue;
  }

  private assertDistinctHostFiles(
    source: PckPatchFingerprint,
    replacements: readonly PckPatchFingerprint[],
    translationCsv?: PckPatchFingerprint,
  ): void {
    const all = [
      source,
      ...replacements,
      ...(translationCsv === undefined ? [] : [translationCsv]),
    ];
    const labels = [
      "package source",
      ...replacements.map((_, index) => `replacement ${String(index)}`),
      ...(translationCsv === undefined ? [] : ["translation CSV"]),
    ];
    for (let left = 0; left < all.length; left += 1) {
      for (let right = left + 1; right < all.length; right += 1) {
        if (sameFile(all[left]!, all[right]!)) {
          throw new PckPatchOperationError(
            "validation_failed",
            `${labels[left]!} and ${labels[right]!} resolve to the same canonical file or hardlink.`,
          );
        }
      }
    }
    const admin = joinPath(this.workspace, ".gdre");
    for (const fingerprint of all) {
      if (pathOverlaps(fingerprint.identity, admin)) {
        throw new PckPatchOperationError(
          "validation_failed",
          `package-patch host inputs must not overlap operation administrative metadata: ${fingerprint.display}`,
        );
      }
    }
  }

  private async resolveDestination(
    source: PckPatchFingerprint,
    replacements: readonly PckPatchFingerprint[],
    extraInputs: readonly PckPatchFingerprint[] = [],
  ): Promise<PckPatchDestination> {
    let effectiveOutput: string;
    if (this.input.output === undefined) {
      try {
        effectiveOutput = defaultSiblingOutput({
          operationDirectory: this.operationDirectory,
          kind: "patched",
          primaryInputs: [{ realPath: source.realPath, kind: "file" }],
        });
      } catch (error) {
        if (error instanceof OutputPlacementError) {
          throw new PckPatchOperationError("path_unsupported", error.message, {
            cause: error,
          });
        }
        throw error;
      }
    } else {
      try {
        effectiveOutput = resolveDisplayPath(
          this.workspace,
          this.input.output,
          true,
        );
      } catch (error) {
        throw new PckPatchOperationError(
          "path_unsupported",
          `package-patch output is not a supported path: ${this.input.output}`,
          { cause: error },
        );
      }
    }
    if (!isSupportedAbsolutePath(effectiveOutput)) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output must be an absolute local file path: ${effectiveOutput}`,
      );
    }
    const parent = parentDirectory(effectiveOutput);
    let parentStats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      parentStats = await fs.lstat(parent);
    } catch (error) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output parent directory does not exist: ${parent}`,
        { cause: error },
      );
    }
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output parent is not a supported directory: ${parent}`,
      );
    }
    let resolved: Awaited<ReturnType<typeof canonicalizePath>>;
    try {
      resolved = await canonicalizePath(effectiveOutput);
      await assertSupportedLocalDrive(resolved.realPath);
    } catch (error) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output is not a supported local path: ${effectiveOutput}`,
        { cause: error },
      );
    }
    const destination: PckPatchDestination = {
      effectiveOutput,
      effectiveRealPath: resolved.realPath,
      effectiveIdentity: resolved.identity,
      parent,
    };
    for (const fingerprint of [
      source,
      ...replacements,
      ...extraInputs,
    ]) {
      if (pathOverlaps(destination.effectiveIdentity, fingerprint.identity)) {
        throw new PckPatchOperationError(
          "path_unsupported",
          `package-patch output overlaps a host input: ${effectiveOutput}`,
        );
      }
    }
    const admin = joinPath(this.workspace, ".gdre");
    if (pathOverlaps(destination.effectiveIdentity, admin)) {
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output overlaps operation administrative metadata: ${effectiveOutput}`,
      );
    }
    await this.assertDestinationAbsent(destination);
    return destination;
  }

  private async assertDestinationAbsent(
    destination: PckPatchDestination,
  ): Promise<void> {
    try {
      await fs.lstat(destination.effectiveOutput);
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output already exists: ${destination.effectiveOutput}`,
      );
    } catch (error) {
      if (error instanceof PckPatchOperationError) throw error;
      if (!isMissing(error)) {
        throw new PckPatchOperationError(
          "path_unsupported",
          `package-patch output could not be inspected: ${destination.effectiveOutput}`,
          { cause: error },
        );
      }
    }
    const temporary = `${destination.effectiveOutput}.tmp`;
    try {
      await fs.lstat(temporary);
      throw new PckPatchOperationError(
        "path_unsupported",
        `package-patch output temporary sibling is occupied: ${temporary}`,
      );
    } catch (error) {
      if (error instanceof PckPatchOperationError) throw error;
      if (!isMissing(error)) {
        throw new PckPatchOperationError(
          "path_unsupported",
          `package-patch output temporary sibling could not be inspected: ${temporary}`,
          { cause: error },
        );
      }
    }
  }

  /**
   * Combined scripts may intentionally exit nonzero while still writing a
   * complete rejection report. Only signals and incomplete stream capture make
   * the acquired report unreadable; the caller decides whether a natural
   * nonzero exit is eligible for report acceptance.
   */
  private inspectCombinedProcessFailure(
    observation: ProcessObservation,
  ): PckPatchOperationError | null {
    if (observation.signal !== null) {
      return new PckPatchOperationError(
        "semantic_failed",
        "GDRE did not finish with a natural process signal.",
      );
    }
    if (
      observation.stdoutEvidence?.complete !== true ||
      observation.stderrEvidence?.complete !== true
    ) {
      return new PckPatchOperationError(
        "semantic_unknown",
        "Process stream capture was incomplete; combined evidence cannot be claimed.",
      );
    }
    return null;
  }

  private inspectProcessFailure(
    observation: ProcessObservation,
  ): PckPatchOperationError | null {
    if (observation.signal !== null || observation.exitCode !== 0) {
      return new PckPatchOperationError(
        "semantic_failed",
        "GDRE did not finish with a natural exit code 0.",
      );
    }
    if (
      observation.stdoutEvidence?.complete !== true ||
      observation.stderrEvidence?.complete !== true
    ) {
      return new PckPatchOperationError(
        "semantic_unknown",
        "Process stream capture was incomplete; package-patch evidence cannot be claimed.",
      );
    }
    return null;
  }

  private async readInspectionReport(
    reportPath: string,
    label: "source" | "output",
  ): Promise<PckPatchInspectionReport> {
    let text: string;
    try {
      text = await fs.readFile(reportPath, "utf8");
    } catch (error) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        `the ${label} inspection report could not be read: ${reportPath}`,
        { cause: error },
      );
    }
    if (label === "output") this.outputReportKnownPresent = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        `the ${label} inspection report is not valid JSON.`,
        { cause: error },
      );
    }
    try {
      return parseInspectionReport(parsed);
    } catch (error) {
      throw new PckPatchOperationError(
        "semantic_unknown",
        error instanceof ReportParseError
          ? `${label} inspection report is untrustworthy: ${error.message}`
          : `the ${label} inspection report does not have a trustworthy shape.`,
        { cause: error },
      );
    }
  }

  private baseData(
    completeness: PckPatchSemanticData["completeness"],
    counts: PckPatchSemanticData["counts"],
    diagnostics: readonly string[],
    replacements: readonly string[],
    retained: readonly string[],
    unverified: readonly string[],
  ): PckPatchSemanticData {
    const destination = this.destinationValue;
    return {
      completeness,
      outputPath: bounded(
        destination?.effectiveOutput ?? "",
        "output path",
      ),
      counts: { ...counts },
      reports: {
        sourceInspection:
          this.sourceReportValue === undefined ? null : this.sourceReportPathValue,
        outputInspection:
          this.outputReportAvailable() ? this.outputReportPathValue : null,
        verification: this.verificationPath,
      },
      ...(this.hasTranslations
        ? { translations: this.translationsData() }
        : {}),
      samples: {
        replacements: replacements
          .slice(0, MAX_SAMPLE)
          .map((entry) => bounded(entry, "replacement member")),
        retainedMembers: retained
          .slice(0, MAX_SAMPLE)
          .map((entry) => bounded(entry, "retained member")),
        unverifiedFiles: unverified
          .slice(0, MAX_SAMPLE)
          .map((entry) => bounded(entry, "unverified file")),
        truncated:
          replacements.length > MAX_SAMPLE ||
          retained.length > MAX_SAMPLE ||
          unverified.length > MAX_SAMPLE,
      },
      diagnostics: diagnostics
        .slice(0, 16)
        .map((entry) => bounded(entry, "package-patch diagnostic")),
    };
  }

  /**
   * Bounded combined translation summary. Identities/paths/counts only: desired
   * and expected translation text never crosses the public result seam.
   */
  private translationsData(): NonNullable<
    PckPatchSemanticData["translations"]
  > {
    const prepared = this.preparedReportValue;
    const verified = this.verifiedReportValue;
    const items =
      this.originalCsvValue === undefined || this.preparedCsvValue === undefined
        ? []
        : [
            {
              original: this.originalCsvValue.display,
              prepared: this.preparedCsvValue.display,
              bomNormalized: this.combinedBomNormalized,
            },
          ];
    const outputs = prepared?.outputs ?? [];
    const retained = prepared?.retainedLocales ?? [];
    const permitted = outputs
      .filter((output) => output.kind === "new")
      .map((output) => output.member);
    return {
      localeSelection: {
        mode:
          this.input.locales === undefined
            ? "new-locales-only"
            : "explicit",
        locales: [...(this.input.locales ?? [])],
      },
      counts: {
        mappings: this.input.translations?.length ?? 0,
        outputs: outputs.length,
        verifiedResources:
          verified === undefined
            ? 0
            : new Set(verified.outputs.map((output) => output.resource)).size,
        verifiedTexts:
          verified === undefined
            ? 0
            : verified.outputs.reduce(
                (total, output) => total + output.verifiedTexts,
                0,
              ),
        retainedLocales: retained.length,
        permittedAdditions: permitted.length,
      },
      preparedCsvs: {
        items: items.slice(0, MAX_SAMPLE),
        truncated: items.length > MAX_SAMPLE,
      },
      reports: {
        preparation: this.preparationReportKnownPresent
          ? this.preparationReportPathValue
          : null,
        verification: this.verificationReportKnownPresent
          ? this.verificationReportPathValue
          : null,
      },
      samples: {
        outputs: outputs.slice(0, MAX_SAMPLE).map((output) => output.member),
        permittedAdditions: permitted.slice(0, MAX_SAMPLE),
        retainedLocales: retained
          .slice(0, MAX_SAMPLE)
          .map((entry) => entry.member),
        truncated:
          outputs.length > MAX_SAMPLE ||
          permitted.length > MAX_SAMPLE ||
          retained.length > MAX_SAMPLE,
      },
      diagnostics: [],
    };
  }

  private outputReportAvailable(): boolean {
    // The report is written by the fixed inspector. Keep the reference only
    // when the evidence file actually existed for this assessment.
    return this.outputReportKnownPresent;
  }

  /**
   * Produce a bounded failure result and retain the verification observations.
   * No exhaustive post-stop inventory or payload hash runs here.
   */
  private async failureAssessment(
    destination: PckPatchDestination,
    completeness: PckPatchSemanticData["completeness"],
    summary: string,
    evidence: readonly string[],
    code: PckPatchOperationError["code"],
    checkOutputReport: boolean,
  ): Promise<{ readonly proceed: false; readonly evaluation: EvaluationResult<PckPatchSemanticData> }> {
    const available: AvailableObservation[] = [];
    for (const file of [
      destination.effectiveOutput,
      `${destination.effectiveOutput}.tmp`,
    ]) {
      available.push(await observeAvailable(file));
    }
    const combinedTempObservations = await this.observeKnownCombinedTempFiles();
    available.push(
      ...combinedTempObservations.map((entry) => entry.observation),
    );
    const unverified = available
      .filter((entry) => entry.exists === true)
      .map((entry) => entry.path);
    // A known combined failure with acquired unverified output/temp is partial
    // evidence, not a bare failed claim. Stops remain unknown.
    const effectiveCompleteness =
      this.hasTranslations && completeness === "failed" && unverified.length > 0
        ? "partial"
        : completeness;
    if (checkOutputReport) {
      this.outputReportKnownPresent = await fs
        .lstat(this.outputReportPathValue)
        .then(() => true)
        .catch(() => false);
    }
    const diagnostics = [
      summary,
      ...evidence,
      ...unverified.map(
        (file) =>
          `Unverified package-patch output or temporary observation retained without content audit: ${file}`,
      ),
    ];
    const data = this.baseData(
      effectiveCompleteness,
      {
        mappings: this.input.patches.length,
        verifiedReplacements: 0,
        verifiedRetainedMembers: 0,
        unverifiedFiles: unverified.length,
      },
      diagnostics,
      [],
      [],
      unverified,
    );
    const evaluation: EvaluationResult<PckPatchSemanticData> = {
      status: code === "semantic_unknown" ? "unknown" : "failed",
      rule: PCK_PATCH_RULE,
      summary: bounded(summary, "package-patch evaluation failed"),
      evidence: evidence
        .slice(0, MAX_EVIDENCE)
        .map((entry) => bounded(entry, "package-patch evidence")),
      data,
    };
    await this.writeVerification({
      schemaVersion: 1,
      rule: PCK_PATCH_RULE,
      completeness: effectiveCompleteness,
      code,
      summary,
      evidence: [...evidence],
      outputPath: destination.effectiveOutput,
      effectiveOutputRealPath: destination.effectiveRealPath,
      mappings: this.input.patches.map((mapping, index) => ({
        logicalMember: mapping.logicalMember,
        hostSource: this.replacementsValue[index]?.display ?? null,
      })),
      sourceInspection: this.sourceReportValue ?? null,
      availableFiles: available,
      combinedTempObservations,
      inventoryAuditedByOperation: false,
    });
    return { proceed: false, evaluation };
  }

  private async writeVerification(value: Record<string, unknown>): Promise<void> {
    if (this.store === undefined) return;
    try {
      await this.store.writeAuxiliaryJson(
        PCK_PATCH_EVIDENCE_NAMESPACE,
        PCK_PATCH_VERIFICATION_FILE,
        value,
      );
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new PckPatchOperationError(
        "storage_failed",
        `package-patch verification evidence could not be written: ${bounded(error, "write failure")}`,
        { cause: error },
      );
    }
  }
}
