import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ArtifactEntry, ArtifactInventory } from "./artifacts.js";
import {
  buildExportExpectations,
  EXPORT_RULE,
  exportAdministrativePaths,
  isExportAccompanyingRelative,
  normalizeExportOutputPath,
  type ExportExpectations,
  type ExportImportExpectation,
  type ExportOutputRoot,
} from "./export-planning.js";
import { isSupportedAbsolutePath, pathContains, pathIdentity } from "./paths.js";
import { boundedUtf8 } from "./text.js";
import type {
  EvaluationResult,
  ExportEvaluationContext,
  ExportSemanticData,
  ProcessObservation,
} from "./types.js";

/**
 * Artifact-dependent export evaluation. It maps the native per-import JSON
 * report back to validated preflight imports, verifies primary saved paths as
 * regular hashed inventory files, and classifies requested-export completeness.
 * Exit zero or file existence alone is never success.
 */

const MAX_EVIDENCE = 32;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

type Completeness = ExportSemanticData["completeness"];
type SemanticStatus = EvaluationResult<ExportSemanticData>["status"];

export interface ExportEvaluationOptions {
  readonly observation: ProcessObservation;
  readonly artifacts?: ArtifactInventory;
  readonly context?: ExportEvaluationContext;
}

export interface ExportEvaluationOutput {
  readonly evaluation: EvaluationResult<ExportSemanticData>;
  readonly detail: Record<string, unknown>;
}

type ReportCategory = "success" | "failed" | "not_converted";

interface NativeReportEntry {
  readonly category: ReportCategory;
  readonly importMdPath: string;
  readonly preferredPath: string;
  readonly importer: string;
  readonly type: string;
  readonly destFiles: readonly string[];
  readonly resourcesUsed: readonly string[];
  readonly exporter: string;
  readonly savedPath: string | null;
  readonly message: string | null;
  readonly messageDetail: string | null;
  readonly errorMessages: readonly string[];
  readonly error: number | null;
  readonly unsupportedFormatType: string | null;
  readonly missingKeys: number | null;
  readonly totalKeys: number | null;
  readonly rewroteMetadata: number | null;
  readonly lossType: number | null;
}

interface NativeExportReport {
  readonly reportVersion: 1;
  readonly gdreVersion: string;
  readonly outputDir: string;
  readonly sessionFilesTotal: number;
  readonly logFileLocation: string;
  readonly translationExportMessage: string;
  readonly hadEncryptionError: boolean;
  readonly decompiledScripts: readonly string[];
  readonly failedScripts: readonly string[];
  readonly unsupportedTypes: readonly string[];
  readonly failedPluginCfgCreate: readonly unknown[];
  readonly downloadedPlugins: readonly unknown[];
  readonly success: readonly NativeReportEntry[];
  readonly failed: readonly NativeReportEntry[];
  readonly notConverted: readonly NativeReportEntry[];
}

type ParseReportResult =
  | { readonly ok: true; readonly report: NativeExportReport }
  | { readonly ok: false; readonly reason: string };

class ReportParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReportParseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const requiredRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new ReportParseError(`${label} must be an object`);
  return value;
};

const exporterLabel = (
  entry: NativeReportEntry,
  fallback?: ExportImportExpectation,
): string =>
  entry.exporter.length > 0
    ? entry.exporter
    : entry.importer.length > 0
      ? entry.importer
      : entry.type.length > 0
        ? entry.type
        : fallback !== undefined && fallback.importer.length > 0
          ? fallback.importer
          : fallback !== undefined && fallback.type.length > 0
            ? fallback.type
            : "unknown exporter";

const optionalString = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ReportParseError(`${label}.${key} must be a string`);
  return value;
};

const optionalNonNegativeInteger = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!nonNegativeInteger(value)) {
    throw new ReportParseError(`${label}.${key} must be a nonnegative integer`);
  }
  return value;
};

const optionalIntegerAtLeast = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
): number | null => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new ReportParseError(
      `${label}.${key} must be an integer no less than ${String(minimum)}`,
    );
  }
  return value;
};

const optionalStringArray = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] => {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ReportParseError(`${label}.${key} must be an array of strings`);
  }
  return value as readonly string[];
};

const requiredArray = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly unknown[] => {
  const value = record[key];
  if (!Array.isArray(value)) throw new ReportParseError(`${label}.${key} must be an array`);
  return value;
};

const requiredStringArray = (
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] => {
  const value = requiredArray(record, key, label);
  if (value.some((entry) => typeof entry !== "string")) {
    throw new ReportParseError(`${label}.${key} must be an array of strings`);
  }
  return value as readonly string[];
};

const parseEntry = (
  value: unknown,
  category: ReportCategory,
  index: number,
): NativeReportEntry => {
  const label = `report ${category}[${String(index)}]`;
  const entry = requiredRecord(value, label);
  const importInfo = requiredRecord(entry["import_info"], `${label}.import_info`);
  const extra = entry["extra_info"];
  if (extra !== undefined && extra !== null && !isRecord(extra)) {
    throw new ReportParseError(`${label}.extra_info must be an object`);
  }
  const extraRecord = isRecord(extra) ? extra : {};
  return {
    category,
    importMdPath: optionalString(importInfo, "import_md_path", `${label}.import_info`) ?? "",
    preferredPath:
      optionalString(importInfo, "preferred_import_path", `${label}.import_info`) ?? "",
    importer: optionalString(importInfo, "importer", `${label}.import_info`) ?? "",
    type: optionalString(importInfo, "type", `${label}.import_info`) ?? "",
    destFiles: optionalStringArray(importInfo, "dest_files", `${label}.import_info`),
    resourcesUsed: optionalStringArray(entry, "resources_used", label),
    exporter: optionalString(entry, "exporter", label) ?? "",
    savedPath: optionalString(entry, "saved_path", label),
    message: optionalString(entry, "message", label),
    messageDetail: optionalStringArray(entry, "message_detail", label).join("\n") || null,
    errorMessages: optionalStringArray(entry, "error_messages", label),
    error: optionalNonNegativeInteger(entry, "error", label),
    unsupportedFormatType: optionalString(entry, "unsupported_format_type", label),
    missingKeys: optionalNonNegativeInteger(extraRecord, "missing_keys", `${label}.extra_info`),
    totalKeys: optionalNonNegativeInteger(extraRecord, "total_keys", `${label}.extra_info`),
    rewroteMetadata: optionalNonNegativeInteger(entry, "rewrote_metadata", label),
    lossType: optionalIntegerAtLeast(entry, "loss_type", label, -1),
  };
};

const parseNativeExportReport = (value: unknown): ParseReportResult => {
  try {
    const root = requiredRecord(value, "native export report");
    if (root["report_version"] !== 1) {
      throw new ReportParseError("native export report has an unsupported report_version");
    }
    const sessionFilesTotal = root["session_files_total"];
    if (!nonNegativeInteger(sessionFilesTotal)) {
      throw new ReportParseError("native export report session_files_total must be a nonnegative integer");
    }
    const parseList = (key: string, category: ReportCategory): readonly NativeReportEntry[] =>
      requiredArray(root, key, "native export report").map((entry, index) =>
        parseEntry(entry, category, index),
      );
    const success = parseList("success", "success");
    const failed = parseList("failed", "failed");
    const notConverted = parseList("not_converted", "not_converted");
    const total = success.length + failed.length + notConverted.length;
    if (sessionFilesTotal !== total) {
      throw new ReportParseError(
        `native export report session_files_total ${String(sessionFilesTotal)} does not match ${String(total)} report entries`,
      );
    }
    return {
      ok: true,
      report: {
        reportVersion: 1,
        gdreVersion: optionalString(root, "gdre_version", "native export report") ?? "",
        outputDir: optionalString(root, "output_dir", "native export report") ?? "",
        sessionFilesTotal,
        logFileLocation: optionalString(root, "log_file_location", "native export report") ?? "",
        translationExportMessage:
          optionalString(root, "translation_export_message", "native export report") ?? "",
        hadEncryptionError: root["had_encryption_error"] === true,
        decompiledScripts: optionalStringArray(root, "decompiled_scripts", "native export report"),
        failedScripts: optionalStringArray(root, "failed_scripts", "native export report"),
        unsupportedTypes: optionalStringArray(root, "unsupported_types", "native export report"),
        failedPluginCfgCreate: requiredArray(root, "failed_plugin_cfg_create", "native export report"),
        downloadedPlugins: requiredArray(root, "downloaded_plugins", "native export report"),
        success,
        failed,
        notConverted,
      },
    };
  } catch (error) {
    if (error instanceof ReportParseError) return { ok: false, reason: error.message };
    throw error;
  }
};

const interrupted = (observation: ProcessObservation): boolean =>
  observation.abortSignal?.aborted === true ||
  (observation.deadlineMono !== undefined && performance.now() >= observation.deadlineMono);

const bounded = (value: unknown, fallback: string): string =>
  boundedUtf8(value, fallback);

const boundedList = (values: readonly string[], limit: number): string[] =>
  values.slice(0, limit).map((value) => bounded(value, "export diagnostic"));

const validRegularArtifact = (
  entry: ArtifactEntry | undefined,
  root: string,
): entry is ArtifactEntry =>
  entry !== undefined &&
  entry.kind === "file" &&
  entry.error === null &&
  entry.bytes !== null &&
  typeof entry.sha256 === "string" &&
  HASH_PATTERN.test(entry.sha256) &&
  pathContains(root, entry.path);

const findEntry = (
  inventory: ArtifactInventory,
  file: string,
): ArtifactEntry | undefined => {
  const identity = pathIdentity(file);
  return inventory.entries.find((entry) => pathIdentity(entry.path) === identity);
};

interface SavedPathEvidence {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly realPath: string | null;
}

const verifySavedPath = (
  savedPath: string | null,
  inventory: ArtifactInventory,
  outputRoot: ExportOutputRoot,
  administrativeIdentities: ReadonlySet<string>,
): SavedPathEvidence => {
  if (savedPath === null || savedPath.length === 0) {
    return {
      ok: false,
      reason: "native success entry has no saved_path",
      realPath: null,
    };
  }
  if (!isSupportedAbsolutePath(savedPath)) {
    return {
      ok: false,
      reason: `saved_path is not a supported local absolute path: ${savedPath}`,
      realPath: null,
    };
  }
  const realPath = normalizeExportOutputPath(savedPath, outputRoot);
  if (realPath === null) {
    return {
      ok: false,
      reason: `saved_path is outside the accepted output: ${savedPath}`,
      realPath: null,
    };
  }
  const realIdentity = pathIdentity(realPath);
  for (const administrative of administrativeIdentities) {
    if (
      realIdentity === administrative ||
      realIdentity.startsWith(`${administrative}/`) ||
      administrative.startsWith(`${realIdentity}/`)
    ) {
      return {
        ok: false,
        reason: `saved_path collides with administrative export evidence: ${savedPath}`,
        realPath: null,
      };
    }
  }
  if (!pathContains(outputRoot.realPath, realPath)) {
    return {
      ok: false,
      reason: `saved_path is outside the accepted output: ${savedPath}`,
      realPath: null,
    };
  }
  const entry = findEntry(inventory, realPath);
  if (!validRegularArtifact(entry, outputRoot.realPath)) {
    return {
      ok: false,
      reason: `saved_path is not a verified regular hashed inventory file: ${savedPath}`,
      realPath: null,
    };
  }
  return { ok: true, reason: null, realPath };
};

interface ImportEvaluation {
  readonly expectation: ExportImportExpectation;
  readonly status: "success" | "failed" | "unsupported" | "unaccounted" | "ambiguous";
  readonly entryIndexes: readonly number[];
  readonly savedPath: string | null;
  readonly savedPathOk: boolean;
  readonly missingKeys: number | null;
  readonly totalKeys: number | null;
}

const addTo = <T>(map: Map<T, Set<number>>, key: T, value: number): void => {
  const current = map.get(key);
  if (current === undefined) map.set(key, new Set([value]));
  else current.add(value);
};

export const evaluateExport = async (
  options: ExportEvaluationOptions,
): Promise<ExportEvaluationOutput> => {
  const { observation } = options;
  const artifacts = options.artifacts ?? observation.artifacts;
  const context = options.context ?? observation.exportContext;
  const processDetail = {
    exitCode: observation.exitCode,
    signal: observation.signal,
    stdoutPath: observation.stdoutEvidence?.rawPath ?? null,
    stderrPath: observation.stderrEvidence?.rawPath ?? null,
    stdoutComplete: observation.stdoutEvidence?.complete ?? null,
    stderrComplete: observation.stderrEvidence?.complete ?? null,
  };

  if (context === undefined) {
    return {
      evaluation: {
        status: "unknown",
        rule: EXPORT_RULE,
        summary: "Export evaluation was invoked without validated preflight expectations.",
        evidence: ["No export expectation context was available for semantic evaluation."],
        data: null,
      },
      detail: {
        schemaVersion: 1,
        rule: EXPORT_RULE,
        completeness: "unknown",
        reason: "missing export evaluation context",
        process: processDetail,
      },
    };
  }

  const baseData = (
    completeness: Completeness,
    counts: Partial<ExportSemanticData["counts"]> = {},
    roles: Partial<ExportSemanticData["artifactRoles"]> = {},
    diagnostics: readonly string[] = [],
  ): ExportSemanticData => ({
    completeness,
    outputPath: context.effectiveOutput,
    selection: { ...context.selection },
    counts: {
      completeMembers: context.completeMembers.length,
      selectedMembers: context.selectedMembers.length,
      nativeImports: 0,
      exportSuccess: 0,
      exportFailed: 0,
      exportUnsupported: 0,
      unverifiedSuccess: 0,
      unaccountedImports: 0,
      unmappedMembers: 0,
      missingKeys: null,
      totalKeys: null,
      ...counts,
    },
    artifactRoles: {
      editableExports: 0,
      unverifiedExports: 0,
      rawOrUnmappedMembers: 0,
      accompanying: 0,
      administrative: 0,
      ...roles,
    },
    reports: {
      native: context.nativeReportPath,
      nativeLog: context.nativeLogPath,
      adapter: null,
    },
    sideEffects: [],
    diagnostics: boundedList(diagnostics, 16),
    previews: { editableExports: [], failed: [], unsupported: [] },
  });

  const early = (
    completeness: Completeness,
    status: SemanticStatus,
    summary: string,
    reason: string,
    data: ExportSemanticData | null,
    extraDetail: Record<string, unknown> = {},
  ): ExportEvaluationOutput => ({
    evaluation: {
      status,
      rule: EXPORT_RULE,
      summary: bounded(summary, "export evaluation failed"),
      evidence: [bounded(reason, "export evaluation evidence")],
      data,
    },
    detail: {
      schemaVersion: 1,
      rule: EXPORT_RULE,
      completeness,
      reason,
      process: processDetail,
      outputPath: context.effectiveOutput,
      selection: {
        kind: context.selection.kind,
        group: context.selection.group,
        completeMembers: [...context.completeMembers],
        selectedMembers: [...context.selectedMembers],
      },
      ...extraDetail,
    },
  });

  if (interrupted(observation)) {
    return early(
      "unknown",
      "unknown",
      "Export evaluation was cancelled or exceeded its execution deadline.",
      observation.abortSignal?.aborted === true
        ? "The retained process/inventory evidence could not be evaluated because the operation was cancelled."
        : "The retained process/inventory evidence could not be fully evaluated within the operation budget.",
      baseData("unknown"),
    );
  }

  let expectations: ExportExpectations;
  try {
    expectations = buildExportExpectations({
      effectiveOutput: context.effectiveOutput,
      completeMembers: context.completeMembers,
      selectedMembers: context.selectedMembers,
      imports: context.imports,
      dumpResourceStrings: context.dumpResourceStrings,
      signal: observation.abortSignal,
      deadlineMono: observation.deadlineMono,
    });
  } catch (error) {
    const reason = `The validated export expectation graph could not be revalidated: ${bounded(error, "path validation failed")}`;
    return early(
      "failed",
      "failed",
      "Export evaluation rejected the retained member/import expectation graph.",
      reason,
      baseData("failed", {}, {}),
    );
  }
  const selectedReportable = expectations.selectedReportableImports;
  const expectationCounts = {
    nativeImports: selectedReportable.length,
    unmappedMembers: expectations.unmappedMembers.length,
  };

  if (observation.signal !== null) {
    return early(
      "failed",
      "failed",
      "GDRE export did not naturally finish because the process ended by signal.",
      `Observed signal ${observation.signal}.`,
      baseData("failed", expectationCounts, {
        rawOrUnmappedMembers: expectationCounts.unmappedMembers,
      }),
    );
  }
  if (observation.exitCode !== 0) {
    return early(
      "failed",
      "failed",
      "GDRE export did not finish with a natural exit code 0.",
      `Observed exit code ${String(observation.exitCode)}.`,
      baseData("failed", expectationCounts, {
        rawOrUnmappedMembers: expectationCounts.unmappedMembers,
      }),
    );
  }
  if (context.selectedMembers.length === 0) {
    return early(
      "failed",
      "failed",
      "The selected member set is empty; an empty selection is never a successful export.",
      "A no-match selection must fail before recovery; an empty selected set cannot be reported as success.",
      baseData("failed", expectationCounts),
    );
  }
  if (artifacts === undefined) {
    return early(
      "unknown",
      "unknown",
      "Artifact-dependent export evaluation was invoked without an actual inventory.",
      "No retained output inventory was available for semantic evaluation.",
      baseData("unknown", expectationCounts),
    );
  }
  if (!artifacts.complete || artifacts.errors.length > 0) {
    return early(
      "unknown",
      "unknown",
      "The retained artifact inventory is incomplete; export success cannot be claimed.",
      artifacts.errors[0] ?? "Artifact inventory completeness was not established.",
      baseData("unknown", expectationCounts),
      {
        inventoryErrors: artifacts.errors.map((error) => bounded(error, "inventory error")),
        inventoryComplete: artifacts.complete,
      },
    );
  }
  const inventoryIdentities = new Set<string>();
  for (const entry of artifacts.entries) {
    const identity = pathIdentity(entry.path);
    if (inventoryIdentities.has(identity)) {
      return early(
        "unknown",
        "unknown",
        "The retained artifact inventory contains a duplicate path.",
        `Duplicate inventory path: ${entry.path}`,
        baseData("unknown", expectationCounts),
      );
    }
    inventoryIdentities.add(identity);
  }

  const root = context.effectiveOutputRealPath;
  const outputRoot: ExportOutputRoot = {
    display: context.effectiveOutput,
    realPath: root,
  };
  const administrative = exportAdministrativePaths(
    context.effectiveOutput,
    context.dumpResourceStrings,
  );
  const realReportPath = normalizeExportOutputPath(administrative.report, outputRoot);
  const realLogPath = normalizeExportOutputPath(administrative.log, outputRoot);
  const realResourceStringsPath =
    administrative.resourceStrings === null
      ? null
      : normalizeExportOutputPath(administrative.resourceStrings, outputRoot);
  if (
    realReportPath === null ||
    realLogPath === null ||
    (administrative.resourceStrings !== null && realResourceStringsPath === null)
  ) {
    return early(
      "unknown",
      "unknown",
      "The accepted destination could not be normalized to its validated real root.",
      "Administrative evidence paths were outside the accepted display/real destination pair.",
      baseData("unknown", expectationCounts),
    );
  }
  const administrativeIdentities = new Set(
    [realReportPath, realLogPath, ...(realResourceStringsPath === null ? [] : [realResourceStringsPath])]
      .map((value) => pathIdentity(value)),
  );
  const reportEntry = findEntry(artifacts, realReportPath);
  if (!validRegularArtifact(reportEntry, root)) {
    return early(
      "unknown",
      "unknown",
      "The native export report is not a verified regular hashed inventory file.",
      `Required native report is missing or unverifiable under the accepted output: ${context.nativeReportPath}`,
      baseData("unknown", expectationCounts),
    );
  }
  const logEntry = findEntry(artifacts, realLogPath);
  if (!validRegularArtifact(logEntry, root)) {
    return early(
      "unknown",
      "unknown",
      "The native export log is not a verified regular hashed inventory file.",
      `Required native log is missing or unverifiable under the accepted output: ${context.nativeLogPath}`,
      baseData("unknown", expectationCounts),
    );
  }

  let reportText: string;
  try {
    reportText = await fs.readFile(realReportPath, {
      encoding: "utf8",
      signal: observation.abortSignal,
    });
  } catch (error) {
    if (interrupted(observation)) {
      return early(
        "unknown",
        "unknown",
        "Export report reading was cancelled or exceeded its execution deadline.",
        "The native report could not be read within the operation budget.",
        baseData("unknown", expectationCounts),
      );
    }
    return early(
      "unknown",
      "unknown",
      "The native export report could not be read.",
      bounded(error, "native report read failure"),
      baseData("unknown", expectationCounts),
    );
  }

  let parsedReport: unknown;
  try {
    parsedReport = JSON.parse(reportText) as unknown;
  } catch (error) {
    return early(
      "unknown",
      "unknown",
      "The native export report is not valid JSON.",
      bounded(error, "native report parse failure"),
      baseData("unknown", expectationCounts),
    );
  }
  const parsed = parseNativeExportReport(parsedReport);
  if (!parsed.ok) {
    return early(
      "unknown",
      "unknown",
      "The native export report does not have a trustworthy shape.",
      parsed.reason,
      baseData("unknown", expectationCounts),
    );
  }
  const report = parsed.report;
  if (
    report.outputDir.length > 0 &&
    pathIdentity(report.outputDir) !== pathIdentity(context.effectiveOutput)
  ) {
    return early(
      "unknown",
      "unknown",
      "The native export report describes a different output directory.",
      `Report output_dir ${report.outputDir} does not match ${context.effectiveOutput}.`,
      baseData("unknown", expectationCounts),
    );
  }
  if (
    report.logFileLocation.length > 0 &&
    pathIdentity(report.logFileLocation) !== pathIdentity(context.nativeLogPath)
  ) {
    return early(
      "unknown",
      "unknown",
      "The native export report describes a different log location.",
      `Report log_file_location ${report.logFileLocation} does not match ${context.nativeLogPath}.`,
      baseData("unknown", expectationCounts),
    );
  }

  const entries: readonly NativeReportEntry[] = [
    ...report.success,
    ...report.failed,
    ...report.notConverted,
  ];
  const selectedIndexes = new Set(selectedReportable.map((entry) => entry.index));
  const keyMap = new Map<string, Set<number>>();
  const destinationMap = new Map<string, Set<number>>();
  for (const entry of expectations.reportableImports) {
    for (const key of [entry.path, entry.importMdPath]) {
      if (key.length > 0) addTo(keyMap, key, entry.index);
    }
    for (const destination of entry.destFiles) addTo(destinationMap, destination, entry.index);
  }

  const coverage = new Map<number, number[]>();
  const ambiguousImports = new Set<number>();
  const unaccountedEntries: number[] = [];
  const unexpectedEntries: number[] = [];
  const entryMatches = new Map<number, readonly number[]>();
  entries.forEach((entry, entryIndex) => {
    const keyMatches = new Set<number>();
    for (const key of [entry.preferredPath, entry.importMdPath]) {
      if (key.length === 0) continue;
      for (const matched of keyMap.get(key) ?? []) keyMatches.add(matched);
    }
    const resourceMatches = new Set<number>();
    for (const resource of [...entry.resourcesUsed, ...entry.destFiles]) {
      for (const matched of destinationMap.get(resource) ?? []) resourceMatches.add(matched);
    }
    const candidates = new Set<number>([...keyMatches, ...resourceMatches]);
    const selectedCandidates = [...candidates].filter((index) => selectedIndexes.has(index));
    const unexpectedCandidates = [...candidates].filter((index) => !selectedIndexes.has(index));
    if (unexpectedCandidates.length > 0) unexpectedEntries.push(entryIndex);
    if (selectedCandidates.length === 0) {
      unaccountedEntries.push(entryIndex);
      entryMatches.set(entryIndex, []);
      return;
    }
    if (keyMatches.size > 1) {
      for (const index of selectedCandidates) ambiguousImports.add(index);
    }
    entryMatches.set(entryIndex, selectedCandidates);
    for (const index of selectedCandidates) {
      const current = coverage.get(index);
      if (current === undefined) coverage.set(index, [entryIndex]);
      else current.push(entryIndex);
    }
  });

  const verifiedByEntry = new Map<number, SavedPathEvidence>();
  entries.forEach((entry, index) => {
    if (entry.category === "success") {
      verifiedByEntry.set(
        index,
        verifySavedPath(
          entry.savedPath,
          artifacts,
          outputRoot,
          administrativeIdentities,
        ),
      );
    }
  });

  const importEvaluations: ImportEvaluation[] = selectedReportable.map((expectation) => {
    const entryIndexes = coverage.get(expectation.index) ?? [];
    const ambiguous = ambiguousImports.has(expectation.index) || entryIndexes.length > 1;
    const selectedEntry = entryIndexes.length === 1 ? entries[entryIndexes[0]!]! : undefined;
    const status: ImportEvaluation["status"] = ambiguous
      ? "ambiguous"
      : selectedEntry === undefined
        ? "unaccounted"
        : selectedEntry.category === "success"
          ? "success"
          : selectedEntry.category === "failed"
            ? "failed"
            : "unsupported";
    return {
      expectation,
      status,
      entryIndexes,
      savedPath: selectedEntry?.category === "success" ? selectedEntry.savedPath : null,
      savedPathOk:
        selectedEntry !== undefined &&
        (verifiedByEntry.get(entryIndexes[0]!)?.ok ?? false),
      missingKeys: selectedEntry?.missingKeys ?? null,
      totalKeys: selectedEntry?.totalKeys ?? null,
    };
  });

  const exportSuccess = importEvaluations.filter((entry) => entry.status === "success").length;
  const exportFailed = importEvaluations.filter((entry) => entry.status === "failed").length;
  const exportUnsupported = importEvaluations.filter(
    (entry) => entry.status === "unsupported",
  ).length;
  const unaccountedImports = importEvaluations.filter(
    (entry) => entry.status === "unaccounted" || entry.status === "ambiguous",
  ).length;
  const unverifiedSuccess = importEvaluations.filter(
    (entry) => entry.status === "success" && !entry.savedPathOk,
  ).length;

  const selectedEntryIndexes = new Set<number>();
  for (const entryIndexes of coverage.values()) {
    for (const entryIndex of entryIndexes) selectedEntryIndexes.add(entryIndex);
  }
  let missingKeys: number | null = null;
  let totalKeys: number | null = null;
  for (const entryIndex of selectedEntryIndexes) {
    const entry = entries[entryIndex]!;
    if (entry.category !== "success") continue;
    if (entry.missingKeys !== null) missingKeys = (missingKeys ?? 0) + entry.missingKeys;
    if (entry.totalKeys !== null) totalKeys = (totalKeys ?? 0) + entry.totalKeys;
  }

  const editablePaths = new Map<string, string>();
  const unverifiedSuccessEntries: number[] = [];
  for (const entryIndex of selectedEntryIndexes) {
    const entry = entries[entryIndex]!;
    if (entry.category !== "success") continue;
    const verified = verifiedByEntry.get(entryIndex);
    if (
      verified?.ok === true &&
      verified.realPath !== null &&
      entry.savedPath !== null
    ) {
      editablePaths.set(pathIdentity(verified.realPath), entry.savedPath);
    } else {
      unverifiedSuccessEntries.push(entryIndex);
    }
  }

  const administrativeCount = artifacts.entries.filter((entry) =>
    administrativeIdentities.has(pathIdentity(entry.path)),
  ).length;
  const selectedMemberIdentities = new Set<string>();
  for (const member of expectations.selectedMembers) {
    const file = expectations.memberPaths.get(member);
    if (file === undefined) continue;
    const real = normalizeExportOutputPath(file, outputRoot);
    if (real !== null) selectedMemberIdentities.add(pathIdentity(real));
  }
  const editableIdentities = new Set(editablePaths.keys());
  const rootIdentity = pathIdentity(root);
  const accompanyingCount = artifacts.entries.filter((entry) => {
    const identity = pathIdentity(entry.path);
    if (administrativeIdentities.has(identity)) return false;
    if (selectedMemberIdentities.has(identity)) return false;
    if (editableIdentities.has(identity)) return false;
    if (identity !== rootIdentity && !identity.startsWith(`${rootIdentity}/`)) return false;
    const relative = identity.slice(rootIdentity.length).replace(/^\//u, "");
    return isExportAccompanyingRelative(relative);
  }).length;
  const hasScaffolding = accompanyingCount > 0;

  const entryLabels = new Map<NativeReportEntry, string>();
  entries.forEach((entry, index) => {
    const candidates = entryMatches.get(index) ?? [];
    const matched = selectedReportable.find((candidate) =>
      candidates.includes(candidate.index),
    );
    entryLabels.set(entry, exporterLabel(entry, matched));
  });
  const labelFor = (entry: NativeReportEntry): string =>
    entryLabels.get(entry) ?? exporterLabel(entry);

  const diagnostics: string[] = [];
  if (report.translationExportMessage.length > 0) {
    diagnostics.push(report.translationExportMessage);
  }
  for (const entry of report.success) {
    if (entry.missingKeys !== null && entry.missingKeys > 0) {
      diagnostics.push(
        `${labelFor(entry)}: ${String(entry.missingKeys)} missing of ${String(entry.totalKeys ?? "unknown")} translation keys.${entry.message === null ? "" : ` ${entry.message}`}`,
      );
    }
  }
  for (const entry of report.failed) {
    diagnostics.push(
      `${labelFor(entry)} failed: ${entry.message ?? entry.messageDetail ?? (entry.error === null ? "no diagnostic" : `error ${String(entry.error)}`)}`,
    );
  }
  for (const entry of report.notConverted) {
    diagnostics.push(
      `${labelFor(entry)} was not converted: ${entry.unsupportedFormatType ?? entry.message ?? entry.messageDetail ?? (entry.error === null ? "no diagnostic" : `error ${String(entry.error)}`)}`,
    );
  }
  for (const entry of entries) {
    for (const message of entry.errorMessages) diagnostics.push(message);
  }
  if (report.failedScripts.length > 0) {
    diagnostics.push(
      `${String(report.failedScripts.length)} script member(s) were skipped before report token creation: ${report.failedScripts.slice(0, 4).join(", ")}`,
    );
  }
  if (report.unsupportedTypes.length > 0) {
    diagnostics.push(
      `Native unsupported type entries: ${report.unsupportedTypes.slice(0, 4).join(", ")}`,
    );
  }
  if (report.hadEncryptionError) {
    diagnostics.push(
      "The native report recorded an encryption error; encrypted export support is not claimed.",
    );
  }
  if (unaccountedEntries.length > 0) {
    diagnostics.push(
      `${String(unaccountedEntries.length)} native report entr${unaccountedEntries.length === 1 ? "y" : "ies"} did not account for a selected import.`,
    );
  }
  if (unexpectedEntries.length > 0) {
    diagnostics.push(
      `${String(unexpectedEntries.length)} native report entr${unexpectedEntries.length === 1 ? "y" : "ies"} matched an unselected import.`,
    );
  }

  const sideEffects: string[] = [];
  if (expectations.unmappedMembers.length > 0) {
    sideEffects.push(
      `${String(expectations.unmappedMembers.length)} selected member(s) had no reportable import destination and were not editable exports.`,
    );
  }
  // Native MetadataStatus: REWRITTEN=3, FAILED=4, MD5_FAILED=5 (not file counts).
  const rewroteMetadata = entries.filter((entry) => entry.rewroteMetadata === 3).length;
  if (rewroteMetadata > 0) {
    sideEffects.push(`${String(rewroteMetadata)} import metadata file(s) were rewritten.`);
  }
  const failedMetadata = entries.filter(
    (entry) => entry.rewroteMetadata === 4 || entry.rewroteMetadata === 5,
  ).length;
  if (failedMetadata > 0) {
    sideEffects.push(`${String(failedMetadata)} import metadata rewrite(s) failed; inspect the native report.`);
  }
  const lossyExports = entries.filter(
    (entry) => entry.lossType !== null && entry.lossType > 0,
  ).length;
  if (lossyExports > 0) {
    sideEffects.push(`${String(lossyExports)} export(s) reported a lossy conversion.`);
  }
  if (report.failedPluginCfgCreate.length > 0) {
    sideEffects.push(
      `${String(report.failedPluginCfgCreate.length)} plugin configuration file creation(s) failed.`,
    );
  }
  if (report.downloadedPlugins.length > 0) {
    sideEffects.push(`${String(report.downloadedPlugins.length)} plugin(s) were downloaded.`);
  }
  if (hasScaffolding) {
    sideEffects.push(
      "Recovery scaffolding and project configuration were written under the accepted output.",
    );
  }
  if (context.resourceStringsPath !== null) {
    sideEffects.push(
      `A native resource-string dump was requested at ${context.resourceStringsPath}.`,
    );
  }

  const gaps =
    exportFailed > 0 ||
    exportUnsupported > 0 ||
    unaccountedImports > 0 ||
    expectations.unmappedMembers.length > 0 ||
    unaccountedEntries.length > 0 ||
    unexpectedEntries.length > 0 ||
    (missingKeys !== null && missingKeys > 0) ||
    unverifiedSuccess > 0 ||
    report.translationExportMessage.length > 0 ||
    (report.unsupportedTypes.length > 0 && exportUnsupported === 0) ||
    report.hadEncryptionError ||
    report.failedScripts.length > 0;
  const completeness: Completeness =
    !gaps
      ? editablePaths.size > 0
        ? "complete"
        : "unknown"
      : editablePaths.size > 0
        ? "partial"
        : exportFailed > 0 || report.failedScripts.length > 0
          ? "failed"
          : exportUnsupported > 0 ||
              expectations.unmappedMembers.length > 0 ||
              unaccountedImports > 0 ||
              unaccountedEntries.length > 0
            ? "unsupported"
            : "unknown";
  const status: SemanticStatus =
    completeness === "complete"
      ? "succeeded"
      : completeness === "unknown"
        ? "unknown"
        : "failed";

  const counts = {
    completeMembers: expectations.completeMembers.length,
    selectedMembers: expectations.selectedMembers.length,
    nativeImports: selectedReportable.length,
    exportSuccess,
    exportFailed,
    exportUnsupported,
    unverifiedSuccess,
    unaccountedImports,
    unmappedMembers: expectations.unmappedMembers.length,
    missingKeys,
    totalKeys,
  };
  const artifactRoles = {
    editableExports: editablePaths.size,
    unverifiedExports: unverifiedSuccessEntries.length,
    rawOrUnmappedMembers: expectations.unmappedMembers.length,
    accompanying: accompanyingCount,
    administrative: administrativeCount,
  };
  const previews = {
    editableExports: boundedList([...editablePaths.values()], 8),
    failed: boundedList(
      report.failed.map(
        (entry) =>
          `${labelFor(entry)}: ${entry.message ?? (entry.error === null ? "failed" : `error ${String(entry.error)}`)}`,
      ),
      8,
    ),
    unsupported: boundedList(
      report.notConverted.map(
        (entry) =>
          `${labelFor(entry)}: ${entry.unsupportedFormatType ?? entry.message ?? (entry.error === null ? "not converted" : `error ${String(entry.error)}`)}`,
      ),
      8,
    ),
  };
  const data: ExportSemanticData = {
    completeness,
    outputPath: context.effectiveOutput,
    selection: { ...context.selection },
    counts,
    artifactRoles,
    reports: {
      native: context.nativeReportPath,
      nativeLog: context.nativeLogPath,
      adapter: null,
    },
    sideEffects: boundedList(sideEffects, 16),
    diagnostics: boundedList(diagnostics, 16),
    previews,
  };
  const summary =
    completeness === "complete"
      ? "GDRE exported the selected resources with verified editable artifact evidence."
      : completeness === "partial"
        ? "GDRE exported part of the requested selection; remaining gaps are reported with full evidence references."
        : completeness === "unsupported"
          ? "The requested selection produced no verified editable export; selected members were unconverted, raw-only, or unaccounted."
          : completeness === "failed"
            ? "GDRE did not complete the requested export."
            : "Export completeness could not be established from the retained evidence.";
  const evidence = [
    "Natural exit code 0 is accepted for export.",
    `Native report ${context.nativeReportPath} parsed with ${String(entries.length)} entries and session_files_total ${String(report.sessionFilesTotal)}.`,
    `Selected ${String(expectations.selectedMembers.length)} member(s) across ${String(selectedReportable.length)} reportable import(s); ${String(expectations.unmappedMembers.length)} unmapped member(s).`,
    `${String(editablePaths.size)} editable artifact(s) verified; ${String(exportSuccess)} native success, ${String(exportFailed)} failed, ${String(exportUnsupported)} unsupported selected import(s).`,
    ...diagnostics,
  ];
  const detail: Record<string, unknown> = {
    schemaVersion: 1,
    rule: EXPORT_RULE,
    completeness,
    process: processDetail,
    outputPath: context.effectiveOutput,
    effectiveOutputRealPath: context.effectiveOutputRealPath,
    selection: {
      kind: context.selection.kind,
      group: context.selection.group,
      completeMembers: [...expectations.completeMembers],
      selectedMembers: [...expectations.selectedMembers],
    },
    preflight: {
      path: context.nativePreflightPath,
      expectationsPath: context.expectationsPath,
      imports: expectations.imports,
      selectedReportableImports: selectedReportable.map((entry) => entry.index),
      unmappedMembers: [...expectations.unmappedMembers],
      memberPaths: Object.fromEntries(expectations.memberPaths),
    },
    nativeReport: {
      path: context.nativeReportPath,
      gdreVersion: report.gdreVersion,
      outputDir: report.outputDir,
      sessionFilesTotal: report.sessionFilesTotal,
      logFileLocation: report.logFileLocation,
      translationExportMessage: report.translationExportMessage,
      hadEncryptionError: report.hadEncryptionError,
      decompiledScripts: [...report.decompiledScripts],
      failedScripts: [...report.failedScripts],
      unsupportedTypes: [...report.unsupportedTypes],
      failedPluginCfgCreate: [...report.failedPluginCfgCreate],
      downloadedPlugins: [...report.downloadedPlugins],
    },
    entries: entries.map((entry, index) => ({
      index,
      category: entry.category,
      importMdPath: entry.importMdPath,
      preferredPath: entry.preferredPath,
      importer: entry.importer,
      type: entry.type,
      destFiles: [...entry.destFiles],
      resourcesUsed: [...entry.resourcesUsed],
      exporter: entry.exporter,
      savedPath: entry.savedPath,
      savedPathEvidence: verifiedByEntry.get(index) ?? null,
      message: entry.message,
      messageDetail: entry.messageDetail,
      errorMessages: [...entry.errorMessages],
      error: entry.error,
      unsupportedFormatType: entry.unsupportedFormatType,
      missingKeys: entry.missingKeys,
      totalKeys: entry.totalKeys,
      rewroteMetadata: entry.rewroteMetadata,
      lossType: entry.lossType,
      matchedSelectedImportIndexes: entryMatches.get(index) ?? [],
    })),
    imports: importEvaluations.map((entry) => ({
      index: entry.expectation.index,
      importer: entry.expectation.importer,
      type: entry.expectation.type,
      path: entry.expectation.path,
      importMdPath: entry.expectation.importMdPath,
      destFiles: [...entry.expectation.destFiles],
      selectedMembers: [...entry.expectation.selectedMembers],
      status: entry.status,
      entryIndexes: [...entry.entryIndexes],
      savedPath: entry.savedPath,
      savedPathOk: entry.savedPathOk,
      missingKeys: entry.missingKeys,
      totalKeys: entry.totalKeys,
    })),
    counts,
    artifactRoles,
    sideEffects: [...data.sideEffects],
    diagnostics: [...data.diagnostics],
    inventory: artifacts.entries.map((entry) => ({
      path: entry.path,
      role: entry.role,
      kind: entry.kind,
      bytes: entry.bytes,
      sha256: entry.sha256,
      error: entry.error,
    })),
    unaccountedReportEntries: unaccountedEntries,
    unexpectedReportEntries: unexpectedEntries,
  };

  return {
    evaluation: {
      status,
      rule: EXPORT_RULE,
      summary,
      evidence: boundedList(evidence, MAX_EVIDENCE),
      data,
    },
    detail,
  };
};
