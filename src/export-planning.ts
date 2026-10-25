import {
  EXTRACTION_ROOT_LOG,
  ExtractionPathError,
  mapExtractionMembers,
  prepareExtractionDestination,
  revalidateExtractionDestination,
  validateLogicalMember,
  type ExtractionDestinationOptions,
  type ExtractionDestinationPreparation,
  type ExtractionDestinationRevalidationOptions,
} from "./extraction-paths.js";
import {
  deriveSelectedMembers,
  type ExtractionSourceKind,
} from "./extraction-selection.js";
import {
  prepareListingInputs,
  revalidateListingInputs,
  type ListingPreparation,
  type ListingPreparationOptions,
} from "./listing-paths.js";
import { isSupportedAbsolutePath, joinPath, pathIdentity } from "./paths.js";
import type {
  ExportImportMetadata,
  ExportResourcesInput,
  ExportSelection,
  InvocationPlan,
  ListFilesSessionAction,
} from "./types.js";

/**
 * Export-local planning, selection, path validation and expectation building.
 * It consumes adapter-owned native preflight metadata and never implements
 * resource conversion or a second exporter.
 */

export const EXPORT_RULE = "gdre-export-resources-v1";
export const EXPORT_ARGV_PREFIX = ["--headless", "--no-header", "--"] as const;
export const EXPORT_EVIDENCE_NAMESPACE = "export-preflight";
export const EXPORT_REPORT_FILENAME = "gdre_export.json";
export const EXPORT_RESOURCE_STRINGS_FILENAME = "resource_strings.stringdump";

/** A rejected export destination or logical member/import path. */
export class ExportPathError extends Error {
  public readonly code = "path_unsupported" as const;

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ExportPathError";
  }
}

const asExportPathError = (error: unknown): never => {
  if (error instanceof ExportPathError) throw error;
  if (error instanceof ExtractionPathError) {
    throw new ExportPathError(error.message.replaceAll("extraction", "export"), { cause: error });
  }
  throw error;
};

export interface ExportSelectionProvenance {
  readonly kind: "members" | "group";
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly group: "scripts" | "translations" | null;
}

export const exportSelectionProvenance = (
  value: ExportSelection,
): ExportSelectionProvenance =>
  value.kind === "members"
    ? {
        kind: "members",
        include: [...value.include],
        exclude: [...(value.exclude ?? [])],
        group: null,
      }
    : { kind: "group", include: [], exclude: [], group: value.group };

export type ExportSelectionOutcome =
  | {
      readonly ok: true;
      readonly classification: "selected" | "no_match";
      readonly members: readonly string[];
      readonly provenance: ExportSelectionProvenance;
      readonly sourceKind: ExtractionSourceKind;
    }
  | {
      readonly ok: false;
      readonly reason: "directory_filter_unsupported";
      readonly message: string;
      readonly patterns: readonly string[];
      readonly provenance: ExportSelectionProvenance;
      readonly sourceKind: ExtractionSourceKind;
    };

export interface ExportSelectionOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
}

/**
 * Derive the selected member set with the same native include/exclude semantics
 * verified for extraction. Group selections are the native script/translation
 * extension classes. An empty result is an explicit no-match, never "all".
 */
export const selectExportMembers = (
  selection: ExportSelection,
  completeMembers: readonly string[],
  sourceKind: ExtractionSourceKind,
  options: ExportSelectionOptions = {},
): ExportSelectionOutcome => {
  const provenance = exportSelectionProvenance(selection);
  const request = {
    mode: selection.kind === "group" ? selection.group : ("all" as const),
    include: provenance.include,
    exclude: provenance.exclude,
  };
  const derived = deriveSelectedMembers(request, completeMembers, sourceKind, options);
  if (!derived.ok) {
    return {
      ok: false,
      reason: derived.reason,
      message: derived.message,
      patterns: [...derived.patterns],
      provenance,
      sourceKind,
    };
  }
  return {
    ok: true,
    classification: derived.classification,
    members: [...derived.expectedMembers],
    provenance,
    sourceKind,
  };
};

/** The extracted `.app` bundle is a package input, not a logical directory. */
export const sourceKindFromPreparation = (
  preparedInputs: ListingPreparation,
): ExtractionSourceKind => {
  const primary = preparedInputs.fingerprints.find(
    (fingerprint) => fingerprint.role === "input",
  );
  return primary !== undefined &&
    primary.kind === "directory" &&
    !/\.app$/iu.test(primary.path)
    ? "directory"
    : "package";
};

/**
 * Resolve protected translation-hint host files separately from recovery
 * primaries. Only regular files are admitted; expected loader paths stay those
 * of the primary input graph.
 */
export const prepareExportHints = async (
  workspace: string,
  hints: readonly string[] | undefined,
  signal?: AbortSignal,
  deadlineMono?: number,
  options: ListingPreparationOptions = {},
): Promise<ListingPreparation | undefined> => {
  if (hints === undefined || hints.length === 0) return undefined;
  const preparation = await prepareListingInputs(
    workspace,
    { inputs: hints.map((value) => ({ kind: "path" as const, path: value })) },
    signal,
    deadlineMono,
    options,
  );
  for (const fingerprint of preparation.fingerprints) {
    if (fingerprint.kind !== "file") {
      throw new ExportPathError(
        `translation hint is not a regular file: ${fingerprint.path}`,
      );
    }
  }
  return preparation;
};

export const revalidateExportHints = async (
  preparation: ListingPreparation,
  signal?: AbortSignal,
  deadlineMono?: number,
  options: ListingPreparationOptions = {},
): Promise<ListingPreparation> => {
  try {
    return await revalidateListingInputs(preparation, signal, deadlineMono, options);
  } catch (error) {
    return asExportPathError(error);
  }
};

/**
 * Combine primary and hint fingerprints for destination-overlap protection
 * only. Expected loader paths remain the primary input graph.
 */
export const combineInputFingerprints = (
  primary: ListingPreparation,
  hints: ListingPreparation | undefined,
): ListingPreparation => {
  if (hints === undefined) return primary;
  const seen = new Set(primary.fingerprints.map((entry) => entry.identity));
  const fingerprints = [...primary.fingerprints];
  for (const fingerprint of hints.fingerprints) {
    if (seen.has(fingerprint.identity)) continue;
    seen.add(fingerprint.identity);
    fingerprints.push(fingerprint);
  }
  return { ...primary, fingerprints };
};

export type ExportDestinationOptions = Omit<
  ExtractionDestinationOptions,
  "preparedInputs"
> & { readonly preparedInputs: ListingPreparation };

export const prepareExportDestination = async (
  options: ExportDestinationOptions,
): Promise<ExtractionDestinationPreparation> => {
  try {
    return await prepareExtractionDestination(options);
  } catch (error) {
    return asExportPathError(error);
  }
};

export const revalidateExportDestination = async (
  preparation: ExtractionDestinationPreparation,
  options: ExtractionDestinationRevalidationOptions = {},
): Promise<ExtractionDestinationPreparation> => {
  try {
    return await revalidateExtractionDestination(preparation, options);
  } catch (error) {
    return asExportPathError(error);
  }
};

export interface ExportAdministrativePaths {
  readonly log: string;
  readonly report: string;
  readonly resourceStrings: string | null;
}

export const exportAdministrativePaths = (
  effectiveOutput: string,
  dumpResourceStrings: boolean,
): ExportAdministrativePaths => ({
  log: joinPath(effectiveOutput, EXTRACTION_ROOT_LOG),
  report: joinPath(effectiveOutput, EXPORT_REPORT_FILENAME),
  resourceStrings: dumpResourceStrings
    ? joinPath(effectiveOutput, ".assets", EXPORT_RESOURCE_STRINGS_FILENAME)
    : null,
});

/** Output-relative paths that are recovery scaffolding or rewritten metadata. */
export const isExportAccompanyingRelative = (relative: string): boolean =>
  relative === "project.godot" ||
  relative === "project.binary" ||
  relative.startsWith(".godot/") ||
  relative.startsWith(".autoconverted/") ||
  /\.(?:import|remap|uid)$/u.test(relative);

export interface ExportOutputRoot {
  readonly display: string;
  readonly realPath: string;
}

/**
 * Map a display-spelling path under the already validated display destination
 * onto the known real destination. Paths outside both roots return null; this
 * never broadens containment or accepts an unrelated root.
 */
export const normalizeExportOutputPath = (
  value: string,
  root: ExportOutputRoot,
): string | null => {
  const valueIdentity = pathIdentity(value);
  const displayIdentity = pathIdentity(root.display);
  const realIdentity = pathIdentity(root.realPath);
  if (valueIdentity === realIdentity || valueIdentity === displayIdentity) {
    return root.realPath;
  }
  if (valueIdentity.startsWith(`${realIdentity}/`)) return value;
  if (!valueIdentity.startsWith(`${displayIdentity}/`)) return null;
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedDisplay = root.display.replaceAll("\\", "/");
  const suffix = normalizedValue
    .slice(normalizedDisplay.length)
    .replace(/^\/+/u, "");
  return suffix.length === 0
    ? root.realPath
    : joinPath(root.realPath, ...suffix.split("/"));
};

export interface ExportImportExpectation extends ExportImportMetadata {
  readonly index: number;
  /** An importer that can produce a native report entry for this import. */
  readonly reportable: boolean;
  /** Selected destination members covered by this import, in caller order. */
  readonly selectedMembers: readonly string[];
}

export interface ExportExpectations {
  readonly completeMembers: readonly string[];
  readonly selectedMembers: readonly string[];
  readonly imports: readonly ExportImportExpectation[];
  readonly reportableImports: readonly ExportImportExpectation[];
  readonly selectedReportableImports: readonly ExportImportExpectation[];
  readonly unmappedMembers: readonly string[];
  readonly administrative: ExportAdministrativePaths;
  /** Selected-member absolute output path keyed by the exact logical member. */
  readonly memberPaths: ReadonlyMap<string, string>;
}

export interface BuildExportExpectationsOptions {
  readonly effectiveOutput: string;
  readonly completeMembers: readonly string[];
  readonly selectedMembers: readonly string[];
  readonly imports: readonly ExportImportMetadata[];
  readonly dumpResourceStrings: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
}

const mapMembers = (
  effectiveOutput: string,
  members: readonly string[],
  options: BuildExportExpectationsOptions,
) => {
  try {
    return mapExtractionMembers({
      effectiveOutput,
      members,
      signal: options.signal,
      deadlineMono: options.deadlineMono,
    });
  } catch (error) {
    return asExportPathError(error);
  }
};

const validateImportLogicalPath = (value: string, label: string): void => {
  if (value.length === 0) return;
  if (!value.startsWith("res://")) {
    throw new ExportPathError(`${label} is not a res:// logical path: ${value}`);
  }
  try {
    validateLogicalMember(value);
  } catch (error) {
    asExportPathError(error);
  }
};

/**
 * Validate the complete preflight member/import graph and retain predictable
 * expectations before any native recovery write. Unsafe logical paths, Windows
 * ambiguity and administrative output collisions are rejected here.
 */
export const buildExportExpectations = (
  options: BuildExportExpectationsOptions,
): ExportExpectations => {
  const completeMapping = mapMembers(
    options.effectiveOutput,
    options.completeMembers,
    options,
  );
  const selectedMembers = [...new Set(options.selectedMembers)];
  const completeSet = new Set(options.completeMembers);
  const outside = selectedMembers.filter((member) => !completeSet.has(member));
  if (outside.length > 0) {
    throw new ExportPathError(
      `selected members are absent from the complete preflight set: ${outside.slice(0, 8).join(", ")}`,
    );
  }
  const selectedMapping = mapMembers(
    options.effectiveOutput,
    selectedMembers,
    options,
  );

  const administrative = exportAdministrativePaths(
    options.effectiveOutput,
    options.dumpResourceStrings,
  );
  const administrativeRelative = [
    EXTRACTION_ROOT_LOG,
    EXPORT_REPORT_FILENAME,
    ...(options.dumpResourceStrings
      ? [`.assets/${EXPORT_RESOURCE_STRINGS_FILENAME}`]
      : []),
  ].map(pathIdentity);
  const administrativeCollision = (identity: string): string | undefined =>
    administrativeRelative.find(
      (admin) =>
        identity === admin ||
        identity.startsWith(`${admin}/`) ||
        admin.startsWith(`${identity}/`),
    );

  const selectedSet = new Set(selectedMembers);
  const imports = options.imports.map((raw, index): ExportImportExpectation => {
    validateImportLogicalPath(raw.path, "import preferred path");
    validateImportLogicalPath(raw.importMdPath, "import metadata path");
    if (raw.sourceFile.startsWith("res://")) {
      validateImportLogicalPath(raw.sourceFile, "import source path");
    }
    for (const destination of raw.destFiles) {
      validateImportLogicalPath(destination, "import destination");
    }
    const destFiles = [...new Set(raw.destFiles)];
    return {
      ...raw,
      destFiles,
      index,
      reportable:
        raw.importer.length > 0 &&
        raw.importer !== "<NONE>" &&
        raw.sourceFile.length > 0,
      selectedMembers: destFiles.filter((destination) => selectedSet.has(destination)),
    };
  });

  for (const member of selectedMapping.members) {
    const collision = administrativeCollision(pathIdentity(member.relative));
    if (collision !== undefined) {
      throw new ExportPathError(
        `export member collides with adapter administrative output ${collision}: ${member.member}`,
      );
    }
  }
  const generatedTargets = new Map<string, string>();
  for (const entry of imports) {
    if (entry.selectedMembers.length === 0) continue;
    const targets = [
      ...(entry.sourceFile.startsWith("res://") ? [entry.sourceFile] : []),
      ...(entry.importMdPath.startsWith("res://") ? [entry.importMdPath] : []),
      ...entry.destFiles,
    ];
    for (const target of targets) {
      generatedTargets.set(pathIdentity(target.slice("res://".length)), target);
    }
  }
  for (const [identity, target] of generatedTargets) {
    const collision = administrativeCollision(identity);
    if (collision !== undefined) {
      throw new ExportPathError(
        `selected import generated target collides with adapter administrative output ${collision}: ${target}`,
      );
    }
  }

  const reportableImports = imports.filter((entry) => entry.reportable);
  const selectedReportableImports = reportableImports.filter(
    (entry) => entry.selectedMembers.length > 0,
  );
  const covered = new Set<string>();
  for (const entry of selectedReportableImports) {
    for (const member of entry.selectedMembers) covered.add(member);
  }
  const unmappedMembers = selectedMembers.filter((member) => !covered.has(member));

  const memberPaths = new Map<string, string>();
  for (const mapping of completeMapping.members) {
    memberPaths.set(mapping.member, mapping.path);
  }

  return {
    completeMembers: [...options.completeMembers],
    selectedMembers,
    imports,
    reportableImports,
    selectedReportableImports,
    unmappedMembers,
    administrative,
    memberPaths,
  };
};

export const exportPreflightEvidencePath = (
  operationDirectory: string,
): string =>
  joinPath(
    operationDirectory,
    EXPORT_EVIDENCE_NAMESPACE,
    "native-preflight.json",
  );

export interface ExportPreflightPlanOptions {
  /** Adapter-owned fixed inspector script; never caller-controlled. */
  readonly preflightScriptPath: string;
  readonly operationDirectory: string;
  readonly resolvedInputs: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * Launch only the fixed native metadata inspector. It performs no recovery or
 * conversion and receives the evidence path plus ordered resolved inputs.
 */
export const buildExportPreflightPlan = (
  options: ExportPreflightPlanOptions,
): InvocationPlan => {
  if (!isSupportedAbsolutePath(options.preflightScriptPath)) {
    throw new Error("export preflight script must be an absolute supported local path");
  }
  if (options.resolvedInputs.length === 0) {
    throw new ExportPathError("export preflight requires at least one resolved input");
  }
  const evidencePath = exportPreflightEvidencePath(options.operationDirectory);
  return {
    argv: [
      "--headless",
      "--script",
      options.preflightScriptPath,
      "--",
      evidencePath,
      ...options.resolvedInputs,
    ],
    cwd: options.operationDirectory,
    timeoutMs: options.timeoutMs,
    effects: {
      reads: [options.preflightScriptPath, ...options.resolvedInputs],
      writes: [evidencePath],
      network: false,
      codeExecution: false,
      unknownScope: false,
    },
  };
};

export interface ExportRecoveryPlanOptions {
  readonly input: ExportResourcesInput;
  readonly resolvedInputs: readonly string[];
  readonly hintPaths: readonly string[];
  readonly effectiveOutput: string;
  readonly session: readonly ListFilesSessionAction[];
  readonly operationDirectory: string;
}

/**
 * Plan the native filtered recovery that owns editable export. The output is
 * always explicit, the JSON report is always enabled internally, and hints and
 * string controls are emitted as bare native flags. No key or checksum
 * override is introduced.
 */
export const buildExportRecoveryPlan = (
  options: ExportRecoveryPlanOptions,
): InvocationPlan => {
  if (options.resolvedInputs.length === 0) {
    throw new ExportPathError("export recovery requires at least one resolved input");
  }
  if (!isSupportedAbsolutePath(options.effectiveOutput)) {
    throw new ExportPathError("export destination must be an absolute local path");
  }
  const session = options.session.map(
    (action) => `--disable-multithreading=${action.disabled ? "true" : "false"}`,
  );
  const primary = options.resolvedInputs.map((value) => `--recover=${value}`);
  const selection =
    options.input.selection.kind === "members"
      ? [
          ...options.input.selection.include.map((value) => `--include=${value}`),
          ...(options.input.selection.exclude ?? []).map((value) => `--exclude=${value}`),
        ]
      : [options.input.selection.group === "scripts" ? "--scripts-only" : "--translation-only"];
  const hints = options.hintPaths.map((value) => `--translation-hint=${value}`);
  const controls = [
    ...(options.input.collectResourceStrings === false
      ? ["--skip-loading-resource-strings"]
      : []),
    ...(options.input.dumpResourceStrings === true
      ? ["--dump-resource-strings"]
      : []),
  ];
  return {
    argv: [
      ...EXPORT_ARGV_PREFIX,
      ...session,
      ...primary,
      `--output=${options.effectiveOutput}`,
      ...selection,
      ...hints,
      ...controls,
      "--setting=write_json_report=true",
    ],
    cwd: options.operationDirectory,
    timeoutMs: options.input.timeoutMs,
    effects: {
      reads: [...options.resolvedInputs, ...options.hintPaths],
      writes: [options.effectiveOutput],
      network: false,
      codeExecution: false,
      unknownScope: false,
    },
  };
};
