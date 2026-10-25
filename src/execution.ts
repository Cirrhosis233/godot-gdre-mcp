import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { CommandInvocation } from "./command-invocation.js";
import { loadConfig, ConfigError, type LoadedConfig } from "./config.js";
import {
  OperationStorage,
  StorageError,
  type JsonWriter,
  type StorageFaults,
} from "./storage.js";
import {
  defaultProcessRunner,
  boundedPreview,
  type ProcessRunResult,
  type ProcessRunner,
  type StreamSink,
} from "./process.js";
import { prepareNativeOwnershipHelper, type OwnershipFactory } from "./process-tree.js";
import {
  inventoryArtifacts,
  type ArtifactInventory,
  type ArtifactRoot,
} from "./artifacts.js";
import { joinPath, operationRoot, pathContains, resolveDisplayPath, resolveWorkspacePath } from "./paths.js";
import { RuntimeManager, type RuntimeHealthOptions } from "./runtime.js";
import { getCommandById } from "./registry.js";
import {
  operationResultSchema,
  type ExportResourcesInput,
  type ExtractInput,
  type ListFilesInput,
  type OperationResultOutput,
  type PatchTranslationsInput,
  type PckPatchInput,
  type VersionInput,
} from "./schemas.js";
import { prepareListingInputs, revalidateListingInputs, type ListingDirectoryInspector, type ListingPreparation } from "./listing-paths.js";
import { EXTRACTION_EVIDENCE_NAMESPACE, ExtractionOperation, extractionEvidencePaths } from "./extraction-operation.js";
import {
  ExportOperation,
  exportAuxiliaryEvidencePaths,
} from "./export-operation.js";
import {
  EXPORT_EVIDENCE_NAMESPACE,
  exportPreflightEvidencePath,
} from "./export-planning.js";
import { TranslationOperation } from "./translation-operation.js";
import {
  PckPatchOperation,
  PckPatchOperationError,
  PCK_PATCH_OUTPUT_INSPECTION_NAMESPACE,
  PCK_PATCH_SOURCE_INSPECTION_NAMESPACE,
  pckPatchInspectorScriptPath,
} from "./pck-patch-operation.js";
import {
  PCK_COMBINED_PREPARATION_NAMESPACE,
  PCK_COMBINED_VERIFICATION_NAMESPACE,
} from "./pck-patch-translations.js";
import { boundedUtf8 } from "./text.js";
import type {
  AnyCommandDescriptor,
  CommandId,
  CommandInput,
  InvocationPlan,
  OperationResult,
  ParameterDescriptor,
  Phase,
  ProcessObservation,
} from "./types.js";

export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly progress?: (update: { readonly phase: Phase; readonly sequence: number }) => void;
}

export interface Execution {
  readonly runtime: import("./types.js").RuntimeState;
  execute(commandId: CommandId, arguments_: unknown, context: ExecutionContext): Promise<OperationResult>;
  close(reason: "shutdown" | "disconnect"): Promise<void>;
}

export interface ExecutionOpenOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly processRunner?: ProcessRunner;
  readonly ownershipFactory?: OwnershipFactory;
  readonly storageFaults?: StorageFaults;
  /** Internal deterministic operation-manifest writer seam for lifecycle tests. */
  readonly writer?: JsonWriter;
  /** Optional native directory-inspection boundary double for deterministic listing tests. */
  readonly listingInspector?: ListingDirectoryInspector;
  readonly runtime?: RuntimeHealthOptions;
}

type TerminalStatus = OperationResult["status"];
type ErrorCode = NonNullable<OperationResult["error"]>["code"];

const MAX_TEXT = 2_048;

const bounded = (value: unknown, fallback: string): string => boundedUtf8(value, fallback, MAX_TEXT);

const boundedSecret = (value: unknown, fallback: string, redactText?: (text: string) => string): string => {
  const raw = value instanceof Error ? value.message : String(value ?? fallback);
  return boundedUtf8(redactText === undefined ? raw : redactText(raw), fallback, MAX_TEXT);
};

const now = (): string => new Date().toISOString();
const monotonic = (): number => performance.now();

const emptyStream = (rawPath: string | null = null, textPath: string | null = null) => ({
  bytes: 0,
  text: "",
  truncated: false,
  utf8Valid: true,
  rawPath,
  textPath,
  complete: rawPath !== null && textPath !== null,
});

const emptyArtifacts: OperationResult["artifacts"] = {
  count: 0,
  items: [],
  truncated: false,
  complete: false,
};

class PathPreparationError extends Error {
  public readonly code = "path_unsupported" as const;
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "PathPreparationError";
  }
}

/**
 * A pre-launch rejection of this one operation: the request was cancelled, its
 * owned native cleanup could not be confirmed.
 * It is per-call state, not a decision about other in-flight calls.
 */
class PreLaunchError extends Error {
  public readonly status: TerminalStatus;
  public readonly code: ErrorCode;
  public constructor(status: TerminalStatus, code: ErrorCode, message: string) {
    super(message);
    this.name = "PreLaunchError";
    this.status = status;
    this.code = code;
  }
}

const errorValue = (
  code: ErrorCode,
  stage: Phase,
  message: unknown,
  redactText?: (text: string) => string,
) => ({
  code,
  stage,
  message: boundedSecret(message, code, redactText),
});

const issuePathText = (value: readonly (string | number)[]): string =>
  value.reduce<string>(
    (text, part) =>
      typeof part === "number"
        ? `${text}[${String(part)}]`
        : text.length === 0
          ? part
          : `${text}.${part}`,
    "",
  );

/**
 * Builtin workspace provenance means the temporary root is internal state,
 * never an implicit base for caller host paths. Descriptor projections carry
 * both the submitted value and its exact issue location; values are validated
 * without normalization and rejected before an operation record is allocated.
 */
const hostPathAdmissionIssue = (
  workspace: string,
  command: AnyCommandDescriptor,
  input: CommandInput,
): string | null => {
  // Validation paired this input with this exact descriptor. Erase only the
  // command-family generic here; each descriptor still requires typed projectors.
  const parameters = command.parameterDescriptors as readonly ParameterDescriptor[];
  for (const parameter of parameters) {
    if (parameter.pathRole !== "input" && parameter.pathRole !== "output") continue;
    for (const projection of parameter.hostPaths(input)) {
      try {
        resolveDisplayPath(workspace, projection.value, false);
      } catch {
        return `${issuePathText(projection.path)} must be an absolute local path while the automatic temporary workspace is in use. Pass an absolute host path or select workspace explicitly.`;
      }
    }
  }
  return null;
};

type ExecutionInput =
  | VersionInput
  | ListFilesInput
  | ExtractInput
  | ExportResourcesInput
  | PatchTranslationsInput
  | PckPatchInput;

const semanticRuleFor = (commandId: OperationResult["commandId"]): string =>
  commandId === "list-files"
    ? "gdre-list-files-v1"
    : commandId === "extract"
      ? "gdre-extract-v1"
      : commandId === "export-resources"
        ? "gdre-export-resources-v1"
        : commandId === "patch-translations"
          ? "gdre-patch-translations-v1"
          : commandId === "pck-patch"
            ? "gdre-pck-patch-v1"
            : "gdre-version-line-v1";

const semanticSummaryFor = (commandId: OperationResult["commandId"]): string =>
  commandId === "list-files"
    ? "GDRE listing was not evaluated."
    : commandId === "extract"
      ? "GDRE extraction was not evaluated."
      : commandId === "export-resources"
        ? "GDRE export was not evaluated."
        : commandId === "patch-translations"
          ? "GDRE translation patch was not evaluated."
          : commandId === "pck-patch"
            ? "GDRE package patch was not evaluated."
            : "GDRE version was not evaluated.";

const redactParameters = (value: unknown, redactText?: (text: string) => string): unknown => {
  if (Array.isArray(value)) return value.map((child) => redactParameters(child, redactText));
  if (typeof value === "string") return redactText?.(value) ?? value;
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) result[key] = key === "key" && typeof child === "string" ? { redacted: true } : redactParameters(child, redactText);
  return result;
};

const operationId = (): string => randomUUID().toLowerCase();

const profileEnvironment = async (
  operation: string,
  profile: string,
  configureApplication = false,
): Promise<{ readonly env: NodeJS.ProcessEnv; readonly record: { readonly root: string; readonly userData: string | null; readonly configFile?: string; readonly generatedConfigFile?: string; readonly configSha256?: string; readonly controls?: Record<string, boolean>; readonly overrides: Record<string, string> } }> => {
  const roots = {
    appData: joinPath(profile, "appdata"),
    localAppData: joinPath(profile, "localappdata"),
    userProfile: joinPath(profile, "userprofile"),
    home: joinPath(profile, "home"),
    temp: joinPath(profile, "temp"),
    tmp: joinPath(profile, "tmp"),
    pluginCache: joinPath(profile, "plugin-cache"),
  };
  await Promise.all(Object.values(roots).map((directory) => fs.mkdir(directory, { recursive: true })));
  const inheritedNames = [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LANGUAGE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const overrides: Record<string, string> = {
    APPDATA: roots.appData,
    LOCALAPPDATA: roots.localAppData,
    USERPROFILE: roots.userProfile,
    HOME: roots.home,
    TEMP: roots.temp,
    TMP: roots.tmp,
    GDRE_PLUGIN_CACHE_DIR: roots.pluginCache,
  };
  Object.assign(env, overrides);
  let userData: string | null = null;
  let configFile: string | undefined;
  let generatedConfigFile: string | undefined;
  let configSha256: string | undefined;
  let controls: Record<string, boolean> | undefined;
  if (configureApplication) {
    userData = joinPath(roots.appData, "Godot", "app_userdata", "Godot RE Tools");
    configFile = joinPath(userData, "gdre_settings.cfg");
    await fs.mkdir(userData, { recursive: true });
    controls = {
      "General/download_plugins": false,
      "General/execute_visual_shader_node_scripts": false,
      "General/delete_auto_converted_files": false,
      "General/force_single_threaded": false,
      "Recovery/clear_output_dir_except_git_before_full_recovery": false,
      "Recovery/git/create_git_repo": false,
      "Recovery/git/add_imports_to_git_repo": false,
      "CSharp/compile_after_decompile": false,
      "CSharp/verify_nuget_package_is_from_nuget_org": false,
      "CSharp/automatically_search_workshop_dependencies": false,
      "CSharp/copy_out_of_tree_references": false,
    };
    const sections = new Map<string, string[]>();
    for (const [key, value] of Object.entries(controls)) {
      const separator = key.indexOf("/");
      const section = key.slice(0, separator);
      const name = key.slice(separator + 1);
      const values = sections.get(section) ?? [];
      values.push(`${name}=${value ? "true" : "false"}`);
      sections.set(section, values);
    }
    const text = [...sections.entries()].map(([section, values]) => `[${section}]\n${values.join("\n")}\n`).join("\n");
    await fs.writeFile(configFile, text, { flag: "wx", encoding: "utf8" });
    // The runtime rewrites gdre_settings.cfg on exit, omitting settings equal to
    // its own defaults. Retain the exact pre-start generated configuration so
    // the safety controls actually supplied to this operation remain auditable.
    const safetyDirectory = joinPath(profile, "safety-config");
    await fs.mkdir(safetyDirectory, { recursive: true });
    generatedConfigFile = joinPath(safetyDirectory, "gdre_settings.generated.cfg");
    await fs.writeFile(generatedConfigFile, text, { flag: "wx", encoding: "utf8" });
    configSha256 = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  }
  return {
    env,
    record: {
      root: profile,
      userData,
      ...(configFile === undefined ? {} : { configFile }),
      ...(generatedConfigFile === undefined ? {} : { generatedConfigFile }),
      ...(configSha256 === undefined ? {} : { configSha256 }),
      ...(controls === undefined ? {} : { controls }),
      overrides: { ...overrides, CWD: operation },
    },
  };
};

const initialResult = (
  runtime: OperationResult["runtime"],
  id: string,
  requestedAt: string,
  commandId: OperationResult["commandId"],
): OperationResult => ({
  schemaVersion: 1,
  operationId: id,
  commandId,
  success: false,
  status: "failed",
  error: null,
  runtime,
  timing: {
    requestedAt,
    queuedAt: null,
    startedAt: null,
    processExitedAt: null,
    finishedAt: requestedAt,
    queueMs: 0,
    processMs: null,
    totalMs: 0,
  },
  process: { pid: null, exitCode: null, signal: null, spawnError: null },
  semantic: {
    status: "not_evaluated",
    rule: semanticRuleFor(commandId),
    summary: semanticSummaryFor(commandId),
    evidence: [],
    data: null,
  },
  paths: {
    workspace: null,
    operation: null,
    output: null,
    effectiveDestination: null,
    manifest: null,
    artifactInventory: null,
  },
  stdout: emptyStream(),
  stderr: emptyStream(),
  artifacts: emptyArtifacts,
  cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
  persistence: { state: "unavailable", error: null },
  warnings: [],
});

const manifestFor = (
  result: OperationResult,
  state: TerminalStatus,
  input: unknown,
  effectiveParameters: Record<string, unknown>,
  parameterSources: Record<string, string>,
  invocation: Record<string, unknown>,
  effects: Record<string, unknown>,
  session: readonly unknown[] = [],
  redactText?: (text: string) => string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> => {
  const projection = redactParameters(result, redactText) as Record<string, unknown>;
  return {
    ...projection,
    recordVersion: 2,
    state,
    requestedParameters: redactParameters(input, redactText),
    effectiveParameters: redactParameters(effectiveParameters, redactText),
    parameterSources,
    session: redactParameters([...session], redactText),
    invocation: redactParameters(invocation, redactText),
    effects: redactParameters(effects, redactText),
    ...(redactParameters(extras, redactText) as Record<string, unknown>),
  };
};

type AbortKind = "cancelled" | "disconnected" | "shutdown" | "timeout";

const mapAbortReason = (reason: unknown): AbortKind => {
  if (typeof reason === "string" && reason === "disconnect") return "disconnected";
  if (typeof reason === "string" && reason === "shutdown") return "shutdown";
  if (reason && typeof reason === "object" && "kind" in reason) {
    const kind = (reason as { readonly kind?: unknown }).kind;
    if (kind === "disconnect") return "disconnected";
    if (kind === "shutdown") return "shutdown";
    if (kind === "timeout") return "timeout";
  }
  return "cancelled";
};

const terminalForAbort = (kind: AbortKind): { readonly status: TerminalStatus; readonly code: ErrorCode } => {
  if (kind === "timeout") return { status: "timed_out", code: "execution_timeout" };
  if (kind === "cancelled") return { status: "cancelled", code: "cancelled" };
  if (kind === "disconnected") return { status: "interrupted", code: "disconnected" };
  return { status: "interrupted", code: "shutdown" };
};

/** Recover a result whose bounded text violated the strict output schema. */
const recoverResult = (result: OperationResult, id: string): OperationResult => {
  const stream = (value: OperationResult["stdout"]) => {
    const preview = boundedPreview(value.text);
    return { ...value, text: preview.text, truncated: value.truncated || preview.truncated };
  };
  const boundedList = (values: readonly string[]): string[] =>
    values.slice(0, 32).map((value) => bounded(value, "evidence"));
  const timing = {
    ...result.timing,
    finishedAt: typeof result.timing.finishedAt === "string" ? result.timing.finishedAt : now(),
  };
  const semanticData = result.semantic.data === null
    ? null
    : "version" in result.semantic.data
      ? { version: bounded(result.semantic.data.version, "version") }
      : "extractedFiles" in result.semantic.data
        ? {
            totalFiles: result.semantic.data.totalFiles,
            selectedFiles: result.semantic.data.selectedFiles,
            extractedFiles: result.semantic.data.extractedFiles,
            outputPath: bounded(result.semantic.data.outputPath, "output path"),
            checksum: "default" as const,
            checksumCoverage: {
              scope: result.semantic.data.checksumCoverage.scope,
              verifiedFiles: result.semantic.data.checksumCoverage.verifiedFiles,
              skippedFiles: result.semantic.data.checksumCoverage.skippedFiles,
            },
          }
        : "completeness" in result.semantic.data
          ? "selection" in result.semantic.data
            ? {
                completeness: result.semantic.data.completeness,
                outputPath: bounded(result.semantic.data.outputPath, "output path"),
                selection: { ...result.semantic.data.selection },
                counts: { ...result.semantic.data.counts },
                artifactRoles: { ...result.semantic.data.artifactRoles },
                reports: {
                  native:
                    result.semantic.data.reports.native === null
                      ? null
                      : bounded(result.semantic.data.reports.native, "native report path"),
                  nativeLog:
                    result.semantic.data.reports.nativeLog === null
                      ? null
                      : bounded(result.semantic.data.reports.nativeLog, "native log path"),
                  adapter:
                    result.semantic.data.reports.adapter === null
                      ? null
                      : bounded(result.semantic.data.reports.adapter, "adapter report path"),
                },
                sideEffects: boundedList(result.semantic.data.sideEffects),
                diagnostics: boundedList(result.semantic.data.diagnostics),
                previews: {
                  editableExports: boundedList(
                    result.semantic.data.previews.editableExports,
                  ),
                  failed: boundedList(result.semantic.data.previews.failed),
                  unsupported: boundedList(
                    result.semantic.data.previews.unsupported,
                  ),
                },
              }
            : "localeSelection" in result.semantic.data
              ? {
                  completeness: result.semantic.data.completeness,
                  outputPath: bounded(result.semantic.data.outputPath, "output path"),
                  localeSelection: {
                    mode: result.semantic.data.localeSelection.mode,
                    locales: result.semantic.data.localeSelection.locales
                      .slice(0, 32)
                      .map((value) => bounded(value, "locale")),
                  },
                  counts: { ...result.semantic.data.counts },
                  reports: {
                    request:
                      result.semantic.data.reports.request === null
                        ? null
                        : bounded(
                            result.semantic.data.reports.request,
                            "request path",
                          ),
                    native:
                      result.semantic.data.reports.native === null
                        ? null
                        : bounded(
                            result.semantic.data.reports.native,
                            "native report path",
                          ),
                  },
                  preparedCsvs: {
                    items: result.semantic.data.preparedCsvs.items
                      .slice(0, 8)
                      .map((item) => ({
                        original: bounded(item.original, "original CSV path"),
                        prepared: bounded(item.prepared, "prepared CSV path"),
                        bomNormalized: item.bomNormalized,
                      })),
                    truncated: result.semantic.data.preparedCsvs.truncated,
                  },
                  samples: {
                    mappings: boundedList(result.semantic.data.samples.mappings),
                    outputs: boundedList(result.semantic.data.samples.outputs),
                    unverifiedFiles: boundedList(
                      result.semantic.data.samples.unverifiedFiles,
                    ),
                    truncated: result.semantic.data.samples.truncated,
                  },
                  diagnostics: boundedList(result.semantic.data.diagnostics),
                }
              : {
                  completeness: result.semantic.data.completeness,
                  outputPath: bounded(
                    result.semantic.data.outputPath,
                    "output path",
                  ),
                  counts: { ...result.semantic.data.counts },
                  reports: {
                    sourceInspection:
                      result.semantic.data.reports.sourceInspection === null
                        ? null
                        : bounded(
                            result.semantic.data.reports.sourceInspection,
                            "source inspection path",
                          ),
                    outputInspection:
                      result.semantic.data.reports.outputInspection === null
                        ? null
                        : bounded(
                            result.semantic.data.reports.outputInspection,
                            "output inspection path",
                          ),
                    verification:
                      result.semantic.data.reports.verification === null
                        ? null
                        : bounded(
                            result.semantic.data.reports.verification,
                            "verification path",
                          ),
                  },
                  samples: {
                    replacements: boundedList(
                      result.semantic.data.samples.replacements,
                    ),
                    retainedMembers: boundedList(
                      result.semantic.data.samples.retainedMembers,
                    ),
                    unverifiedFiles: boundedList(
                      result.semantic.data.samples.unverifiedFiles,
                    ),
                    truncated: result.semantic.data.samples.truncated,
                  },
                  diagnostics: boundedList(result.semantic.data.diagnostics),
                }
          : {
              totalFiles: result.semantic.data.totalFiles,
              files: result.semantic.data.files.slice(0, 32).map((value) => bounded(value, "file name")),
              truncated: result.semantic.data.truncated,
              stdoutPath: bounded(result.semantic.data.stdoutPath, "stdout evidence"),
            };
  const recovered: OperationResult = {
    ...result,
    semantic: {
      ...result.semantic,
      summary: bounded(result.semantic.summary, "semantic summary"),
      evidence: boundedList(result.semantic.evidence),
      data: semanticData,
    },
    error: result.error === null
      ? null
      : { ...result.error, message: bounded(result.error.message, result.error.code) },
    runtime: {
      ...result.runtime,
      warnings: boundedList(result.runtime.warnings),
      probe: {
        ...result.runtime.probe,
        error: result.runtime.probe.error === null ? null : bounded(result.runtime.probe.error, "probe error"),
      },
    },
    timing,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
    cleanup: {
      ...result.cleanup,
      actions: boundedList(result.cleanup.actions),
      error: result.cleanup.error === null ? null : bounded(result.cleanup.error, "cleanup error"),
    },
    persistence: {
      ...result.persistence,
      error: result.persistence.error === null ? null : bounded(result.persistence.error, "persistence error"),
    },
    warnings: boundedList(result.warnings),
  };
  const parsed = operationResultSchema.safeParse(recovered);
  if (parsed.success) return parsed.data;
  return {
    schemaVersion: 1,
    operationId: id,
    commandId: result.commandId,
    success: false,
    status: "failed",
    error: errorValue("process_failed", "finalizing", "operation result could not be normalized"),
    runtime: result.runtime,
    timing,
    process: { pid: null, exitCode: null, signal: null, spawnError: null },
    semantic: {
      status: "unknown",
      rule: semanticRuleFor(result.commandId),
      summary:
        result.commandId === "list-files"
          ? "The listing operation result could not be normalized."
          : result.commandId === "extract"
            ? "The extraction operation result could not be normalized."
            : result.commandId === "export-resources"
              ? "The export operation result could not be normalized."
              : "The operation result could not be normalized.",
      evidence: [],
      data: null,
    },
    paths: result.paths,
    stdout: stream(result.stdout),
    stderr: stream(result.stderr),
    artifacts: { count: 0, items: [], truncated: false, complete: false },
    cleanup: { state: "unconfirmed", trigger: null, actions: [], error: "result normalization failed" },
    persistence: { state: "incomplete", error: "result normalization failed" },
    warnings: [],
  };
};

class ExecutionImpl implements Execution {
  private readonly config: LoadedConfig;
  private readonly runtimeManager: RuntimeManager;
  private readonly processRunner: ProcessRunner;
  private readonly ownershipFactory: OwnershipFactory | undefined;
  private readonly storageFaults: StorageFaults;
  private readonly storageWriter: JsonWriter | undefined;
  private readonly listingInspector: ListingDirectoryInspector | undefined;
  private readonly helperScriptPath: string;
  private readonly exportPreflightScriptPath: string;
  private readonly patchTranslationsScriptPath: string;
  private readonly pckPatchInspectorScriptPath: string;
  private readonly pckPatchPrepareScriptPath: string;
  private readonly pckPatchVerifyScriptPath: string;
  private readonly active = new Map<string, { readonly controller: AbortController; readonly completion: Promise<void> }>();
  /**
   * Fail-closed launch guard, not a scheduler. Once one owned process tree
   * cannot be confirmed clean, no further operation allocates storage or
   * launches a process; calls that are already running keep their own
   * cancellation and cleanup ownership.
   */
  private cleanupUnconfirmed = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  public constructor(
    config: LoadedConfig,
    runtimeManager: RuntimeManager,
    options: ExecutionOpenOptions,
  ) {
    this.config = config;
    this.runtimeManager = runtimeManager;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.ownershipFactory = options.ownershipFactory;
    this.storageFaults = options.storageFaults ?? {};
    this.storageWriter = options.writer;
    this.listingInspector = options.listingInspector;
    this.helperScriptPath = joinPath(config.installationRoot, "native", "gdre-job-object.ps1");
    this.exportPreflightScriptPath = joinPath(
      config.installationRoot,
      "native",
      "gdre-export-preflight.gd",
    );
    this.patchTranslationsScriptPath = joinPath(
      config.installationRoot,
      "native",
      "gdre-patch-translations.gd",
    );
    this.pckPatchInspectorScriptPath = pckPatchInspectorScriptPath(
      config.installationRoot,
    );
    this.pckPatchPrepareScriptPath = joinPath(
      config.installationRoot,
      "native",
      "gdre-pck-combined-prepare.gd",
    );
    this.pckPatchVerifyScriptPath = joinPath(
      config.installationRoot,
      "native",
      "gdre-pck-combined-verify.gd",
    );
  }

  public get runtime(): OperationResult["runtime"] {
    return this.runtimeManager.state;
  }

  public async execute(commandId: CommandId, arguments_: unknown, context: ExecutionContext): Promise<OperationResult> {
    const requestedAt = now();
    const requestMono = monotonic();
    const id = operationId();
    const controller = new AbortController();
    if (context.signal.aborted) {
      controller.abort(context.signal.reason);
      return this.executeInternal(commandId, arguments_, context, id, requestedAt, requestMono, controller);
    }
    const abortFromRequest = (): void => controller.abort(context.signal.reason);
    context.signal.addEventListener("abort", abortFromRequest, { once: true });
    let completed!: () => void;
    const completion = new Promise<void>((resolve) => { completed = resolve; });
    this.active.set(id, { controller, completion });
    try {
      return await this.executeInternal(commandId, arguments_, context, id, requestedAt, requestMono, controller);
    } finally {
      context.signal.removeEventListener("abort", abortFromRequest);
      this.active.delete(id);
      completed();
    }
  }

  private async executeInternal(
    commandId: CommandId,
    arguments_: unknown,
    context: ExecutionContext,
    id: string,
    requestedAt: string,
    requestMono: number,
    controller: AbortController,
  ): Promise<OperationResult> {
    const descriptor = getCommandById(commandId);
    let result = initialResult(this.runtimeManager.state, id, requestedAt, commandId);
    if (this.closed) return this.finishPrelaunch(result, "failed", "shutdown", "execution is closed", [], "validating", requestMono);
    if (descriptor === undefined) return this.finishPrelaunch(result, "failed", "unsupported_capability", `Unsupported command ${commandId}.`, [], "validating", requestMono);
    const validation = descriptor.validate(arguments_);
    if (!validation.ok) {
      return this.finishPrelaunch(result, "failed", "validation_failed", validation.error.message, validation.error.issues.map((issue) => issue.message), "validating", requestMono);
    }
    const invocation = new CommandInvocation(descriptor, validation.value, this.config);
    const input = invocation.requested;
    const isApplication = invocation.isApplication;
    const isExtract = invocation.commandId === "extract";
    const isExport = invocation.commandId === "export-resources";
    const isPatch = invocation.commandId === "patch-translations";
    const isPckPatch = invocation.commandId === "pck-patch";
    const isArtifactProducing = isExtract || isExport;
    const isInventoryProducing = isArtifactProducing || isPatch || isPckPatch;
    const operationLabel = invocation.operationLabel;
    const knownKey = invocation.knownKey;
    const redactText = invocation.redactText;
    if (invocation.settingsRejection !== null) {
      return this.finishPrelaunch(
        result,
        "failed",
        "validation_failed",
        invocation.settingsRejection,
        [],
        "validating",
        requestMono,
      );
    }
    if (input.timeoutMs !== undefined && input.timeoutMs > this.config.timeouts.maxMs) {
      return this.finishPrelaunch(
        result,
        "failed",
        "validation_failed",
        `timeoutMs must be between 1 and the configured maximum of ${String(this.config.timeouts.maxMs)} ms.`,
        [],
        "validating",
        requestMono,
      );
    }
    if (context.signal.aborted) {
      const mapped = terminalForAbort(mapAbortReason(context.signal.reason));
      return this.finishPrelaunch(result, mapped.status, mapped.code, "The operation was cancelled before allocation.", [], "validating", requestMono);
    }

    const workspaceDisplay = input.workspace ?? this.config.workspaceRoot;
    let workspace: string;
    try {
      const resolved = await resolveWorkspacePath(workspaceDisplay);
      workspace = resolved.display;
    } catch (error) {
      return this.finishPrelaunch(result, "failed", "path_unsupported", boundedSecret(error, "workspace path is unsupported", redactText), [], "validating", requestMono);
    }
    if (invocation.parameterSources.workspace === "builtin") {
      const admissionIssue = hostPathAdmissionIssue(workspace, descriptor, invocation.input);
      if (admissionIssue !== null) {
        return this.finishPrelaunch(result, "failed", "validation_failed", admissionIssue, [admissionIssue], "validating", requestMono);
      }
    }
    const prospectiveOperation = joinPath(operationRoot(workspace), id);
    const prospectiveOutput = joinPath(prospectiveOperation, "output");
    let listingPreparation: ListingPreparation | undefined;
    let extraction: ExtractionOperation | undefined;
    let exportResources: ExportOperation | undefined;
    let translationPatch: TranslationOperation | undefined;
    let pckPatch: PckPatchOperation | undefined;
    let plan: InvocationPlan | undefined;
    const planningInput: ExecutionInput = invocation.input;
    const effectiveSession = invocation.session;
    let sequence = 0;
    let currentPhase: Phase = "validating";
    let invocationProfile: Record<string, unknown> | null = null;
    let storage: OperationStorage | undefined;
    let storageError: string | null = null;
    let finalState: TerminalStatus = "failed";
    let finalError: OperationResult["error"] = null;
    let artifactObservation: ProcessObservation | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timeoutStarted = false;
    let streamsClosePromise: Promise<void> | null = null;
    let preflightSink: StreamSink | undefined;
    const pckInspectionSinks: StreamSink[] = [];
    let effectLimitations: string[] = isApplication
      ? [
          "operation-local profile controls are administrative; no security sandbox or universal external-effect isolation is claimed",
          "the fixed runtime may emit an OS_Windows::get_system_dir diagnostic under the synthetic profile; raw stderr remains retained evidence",
        ]
      : [];
    let inventory: ArtifactInventory = { entries: [], errors: [], complete: false, stopReason: null };

    if (this.cleanupUnconfirmed) {
      // Fail closed before any allocation: an earlier call could not confirm
      // native cleanup, so this call must not create a record or launch.
      return this.finishPrelaunch(
        result,
        "failed",
        "cleanup_failed",
        "Owned GDRE process cleanup could not be confirmed; new operations are blocked.",
        [],
        "validating",
        requestMono,
      );
    }
    if (isApplication) {
      try {
        storage = await OperationStorage.create(
          workspace,
          { faults: this.storageFaults, writer: this.storageWriter, idFactory: () => id },
        );
      } catch (error) {
        return this.finishPrelaunch(result, "failed", "storage_failed", boundedSecret(error, `${operationLabel} operation storage could not be allocated`, redactText), [], "validating", requestMono);
      }
      result = {
        ...result,
        paths: { workspace, operation: storage.paths.operation, output: storage.paths.output, effectiveDestination: null, manifest: storage.paths.manifest, artifactInventory: storage.paths.artifacts },
        stdout: emptyStream(storage.paths.stdoutBin, storage.paths.stdoutText),
        stderr: emptyStream(storage.paths.stderrBin, storage.paths.stderrText),
        persistence: { state: "complete", error: null },
      };
    }
    let preparationFailure: { readonly status: TerminalStatus; readonly code: ErrorCode; readonly message: string } | null = null;
    if (isApplication) {
      try {
        if (isPckPatch) {
          pckPatch = new PckPatchOperation({
            workspace,
            operationDirectory: storage?.paths.operation ?? prospectiveOperation,
            input: planningInput as PckPatchInput,
            signal: controller?.signal ?? context.signal,
            inspectorScriptPath: this.pckPatchInspectorScriptPath,
            prepareScriptPath: this.pckPatchPrepareScriptPath,
            verifyScriptPath: this.pckPatchVerifyScriptPath,
            store: storage,
          });
          await pckPatch.prepare();
        } else {
          listingPreparation = await prepareListingInputs(
            workspace,
            planningInput as ListFilesInput,
            controller?.signal ?? context.signal,
            undefined,
            { directoryInspector: this.listingInspector },
          );
          if (isExtract) {
            extraction = new ExtractionOperation({
              workspace,
              operationDirectory: storage?.paths.operation ?? prospectiveOperation,
              input: planningInput as ExtractInput,
              session: effectiveSession,
              preparedInputs: listingPreparation,
              signal: controller?.signal ?? context.signal,
              directoryInspector: this.listingInspector,
            });
            await extraction.prepareDestination();
          } else if (isExport) {
            exportResources = new ExportOperation({
              workspace,
              operationDirectory: storage?.paths.operation ?? prospectiveOperation,
              input: planningInput as ExportResourcesInput,
              preparedInputs: listingPreparation,
              signal: controller?.signal ?? context.signal,
              preflightScriptPath: this.exportPreflightScriptPath,
              directoryInspector: this.listingInspector,
              store: storage,
            });
            await exportResources.prepareDestination();
          } else if (isPatch) {
            translationPatch = new TranslationOperation({
              workspace,
              operationDirectory: storage?.paths.operation ?? prospectiveOperation,
              input: planningInput as PatchTranslationsInput,
              preparedInputs: listingPreparation,
              session: effectiveSession,
              signal: controller?.signal ?? context.signal,
              ...(redactText === undefined ? {} : { redactText }),
              store: storage,
            });
            await translationPatch.prepare();
          }
        }
      } catch (error) {
        const cancelled = controller?.signal.aborted === true;
        const disclosedCode = (error as { readonly code?: unknown }).code;
        const disclosedPreparationCode =
          disclosedCode === "validation_failed" ||
          disclosedCode === "path_unsupported" ||
          disclosedCode === "storage_failed" ||
          disclosedCode === "semantic_failed" ||
          disclosedCode === "semantic_unknown" ||
          disclosedCode === "unsupported_capability"
            ? disclosedCode
            : undefined;
        const preparationCode: ErrorCode =
          (isPatch || isPckPatch) && disclosedPreparationCode !== undefined
            ? disclosedPreparationCode
            : "path_unsupported";
        const mapped = cancelled
          ? terminalForAbort(mapAbortReason(controller?.signal.reason))
          : { status: "failed" as const, code: preparationCode };
        preparationFailure = {
          status: mapped.status,
          code: mapped.code,
          message: boundedSecret(
            error,
            isExtract
              ? "extraction input/destination preparation failed"
              : isExport
                ? "export input/hint/destination preparation failed"
                : isPatch
                  ? "translation patch input/destination preparation failed"
                  : isPckPatch
                    ? "package-patch input/destination preparation failed"
                    : "listing input preparation failed",
            redactText,
          ),
        };
        finalState = mapped.status;
        finalError = errorValue(mapped.code, "validating", preparationFailure.message, redactText);
      }
    }
    if (preparationFailure === null) {
      try {
        plan = invocation.plan({
          workspace,
          operationDirectory: prospectiveOperation,
          resolvedInputs: listingPreparation?.resolvedInputs,
          effectiveOutput:
            extraction?.effectiveOutput ??
            exportResources?.effectiveOutput ??
            translationPatch?.effectiveOutput ??
            pckPatch?.effectiveOutput,
          resolvedHints: exportResources?.resolvedHints,
          resolvedTranslations: translationPatch?.resolvedTranslations,
          resolvedPckSource: pckPatch?.resolvedPckSource,
          resolvedPatches: pckPatch?.resolvedPatches,
          resolvedPckTranslations: pckPatch?.resolvedPckTranslations,
          preparedPckTranslations: pckPatch?.preparedPckTranslations,
          patchTranslationsScriptPath: isPatch
            ? this.patchTranslationsScriptPath
            : undefined,
        });
      } catch (error) {
        if (isApplication) {
          preparationFailure = { status: "failed", code: "process_failed", message: boundedSecret(error, "command planning failed", redactText) };
          finalState = "failed";
          finalError = errorValue("process_failed", "validating", preparationFailure.message, redactText);
        } else {
          return this.finishPrelaunch(result, "failed", "process_failed", boundedSecret(error, "command planning failed", redactText), [], "validating", requestMono);
        }
      }
    }
    if (plan?.timeoutMs !== undefined && (!Number.isSafeInteger(plan.timeoutMs) || plan.timeoutMs < 1 || plan.timeoutMs > this.config.timeouts.maxMs)) {
      if (isApplication) {
        preparationFailure = { status: "failed", code: "validation_failed", message: `planned timeoutMs must be between 1 and the configured maximum of ${String(this.config.timeouts.maxMs)} ms.` };
        finalState = "failed";
        finalError = errorValue("validation_failed", "validating", preparationFailure.message, redactText);
      } else {
        return this.finishPrelaunch(result, "failed", "validation_failed", `planned timeoutMs must be between 1 and the configured maximum of ${String(this.config.timeouts.maxMs)} ms.`, [], "validating", requestMono);
      }
    }
    const artifactDestination =
      extraction?.effectiveOutput ??
      exportResources?.effectiveOutput ??
      translationPatch?.effectiveOutput ??
      pckPatch?.effectiveOutput;
    if (artifactDestination !== undefined) {
      result = { ...result, paths: { ...result.paths, effectiveDestination: artifactDestination } };
    }
    const effective = invocation.effectiveParameters(
      {
        workspace,
        resolvedInputs: listingPreparation?.resolvedInputs,
        effectiveOutput: artifactDestination,
        resolvedHints: exportResources?.resolvedHints,
        resolvedTranslations: translationPatch?.resolvedTranslations,
        resolvedPckSource: pckPatch?.resolvedPckSource,
        resolvedPatches: pckPatch?.resolvedPatches,
        resolvedPckTranslations: pckPatch?.resolvedPckTranslations,
      },
      plan?.timeoutMs,
    );
    const emit = (phase: Phase): void => {
      currentPhase = phase;
      sequence += 1;
      context.progress?.({ phase, sequence });
    };

    const activeController = controller;
    if (activeController === undefined) throw new Error("execution controller was not registered");

    const invocationFor = (next: OperationResult): Record<string, unknown> => {
      const operation = next.paths.operation ?? prospectiveOperation;
      const output = next.paths.output ?? prospectiveOutput;
      const mutationRoots = [...new Set([output, ...(plan?.effects.writes ?? [])])];
      return {
        executable: this.runtimeManager.state.executable,
        argv: plan?.argv.map((token) => redactText?.(token) ?? token) ?? [],
        cwd: plan?.cwd ?? null,
        environmentProfile: invocationProfile ?? { root: joinPath(operation, "profile"), userData: null, overrides: {} },
        inputPaths: [
          ...(listingPreparation?.fingerprints.map((fingerprint) => ({
            role: fingerprint.role,
            path: fingerprint.path,
            realPath: fingerprint.realPath,
            identity: fingerprint.identity,
            kind: fingerprint.kind,
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
            mtimeNs: fingerprint.mtimeNs,
            fileId: fingerprint.fileId,
          })) ?? []),
          ...(exportResources?.hintPreparation?.fingerprints.map((fingerprint) => ({
            role: "hint",
            path: fingerprint.path,
            realPath: fingerprint.realPath,
            identity: fingerprint.identity,
            kind: fingerprint.kind,
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
            mtimeNs: fingerprint.mtimeNs,
            fileId: fingerprint.fileId,
          })) ?? []),
          ...(translationPatch?.csvFingerprints.map((fingerprint) => ({
            role: "translation-csv",
            path: fingerprint.display,
            realPath: fingerprint.realPath,
            identity: fingerprint.identity,
            kind: "file",
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
            mtimeNs: fingerprint.mtimeNs,
            fileId: fingerprint.fileId,
          })) ?? []),
          ...(pckPatch?.sourceFingerprint === undefined
            ? []
            : [
                {
                  role: "pck-source",
                  path: pckPatch.sourceFingerprint.display,
                  realPath: pckPatch.sourceFingerprint.realPath,
                  identity: pckPatch.sourceFingerprint.identity,
                  kind: "file",
                  bytes: pckPatch.sourceFingerprint.bytes,
                  sha256: pckPatch.sourceFingerprint.sha256,
                  mtimeNs: pckPatch.sourceFingerprint.mtimeNs,
                  fileId: pckPatch.sourceFingerprint.fileId,
                },
              ]),
          ...(pckPatch?.replacementFingerprints.map((fingerprint) => ({
            role: "pck-replacement",
            path: fingerprint.display,
            realPath: fingerprint.realPath,
            identity: fingerprint.identity,
            kind: "file",
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
            mtimeNs: fingerprint.mtimeNs,
            fileId: fingerprint.fileId,
          })) ?? []),
        ],
        mutationRoots,
      };
    };
    const effectsFor = (next: OperationResult): Record<string, unknown> => {
      const operation = next.paths.operation ?? prospectiveOperation;
      const output = next.paths.output ?? prospectiveOutput;
      const profile = joinPath(operation, "profile");
      const writes = [
        ...(plan?.effects.writes ?? []),
        output,
        profile,
        next.paths.manifest ?? joinPath(operation, "manifest.json"),
        next.paths.artifactInventory ?? joinPath(operation, "artifacts.json"),
        next.stdout.rawPath ?? joinPath(operation, "stdout.bin"),
        next.stdout.textPath ?? joinPath(operation, "stdout.txt"),
        next.stderr.rawPath ?? joinPath(operation, "stderr.bin"),
        next.stderr.textPath ?? joinPath(operation, "stderr.txt"),
        ...(isExtract ? extractionEvidencePaths(operation) : []),
        ...(isExport ? exportAuxiliaryEvidencePaths(operation) : []),
        ...(translationPatch?.evidencePaths() ?? []),
        ...(pckPatch?.evidencePaths() ?? []),
      ];
      const reads = [
        ...(plan?.effects.reads ?? []),
        ...(listingPreparation?.fingerprints.map((fingerprint) => fingerprint.path) ?? []),
        ...(exportResources?.resolvedHints ?? []),
        ...(translationPatch?.readPaths() ?? []),
        ...(pckPatch?.readPaths() ?? []),
        ...(isExport
          ? [
              this.exportPreflightScriptPath,
              exportPreflightEvidencePath(operation),
            ]
          : []),
        this.runtimeManager.state.executable,
        ...this.runtimeManager.state.companions.map((companion) => companion.path),
      ];
      const knownSideEffectRoots = [
        operation,
        output,
        profile,
        ...(artifactDestination === undefined ? [] : [artifactDestination]),
      ];
      return {
        reads: [...new Set(reads.filter((value) => value.length > 0))],
        writes: [...new Set(writes.filter((value) => value.length > 0))],
        network: plan?.effects.network ?? false,
        codeExecution: plan?.effects.codeExecution ?? false,
        unknownScope: plan?.effects.unknownScope ?? false,
        knownSideEffectRoots: [...new Set(knownSideEffectRoots)],
        limitations: [...effectLimitations],
      };
    };

    const closeStreams = async (): Promise<void> => {
      const current = storage;
      if (current === undefined) return;
      if (streamsClosePromise === null) {
        streamsClosePromise = (async () => {
          const outcomes = await Promise.allSettled([current.closeStreams(), preflightSink?.close()]);
          const failure = outcomes.find((outcome) => outcome.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        })();
      }
      await streamsClosePromise;
    };

    const throwIfAborted = (): void => {
      if (!activeController.signal.aborted) return;
      const kind = mapAbortReason(activeController.signal.reason);
      const mapped = terminalForAbort(kind);
      throw new PreLaunchError(mapped.status, mapped.code, `operation was ${kind} before launch`);
    };

    /**
     * Refuse to start another owned process once any operation in this server
     * could not confirm native cleanup. Calls that already launched keep their
     * own cancellation and cleanup ownership.
     */
    const throwIfLaunchBlocked = (): void => {
      if (this.cleanupUnconfirmed) {
        throw new PreLaunchError("failed", "cleanup_failed", "owned GDRE process cleanup could not be confirmed; no further process was launched");
      }
    };

    /** Recheck invocation inputs and destination before each owned launch. */
    const revalidatePreparedGraph = async (): Promise<void> => {
      if (!isApplication) return;
      throwIfAborted();
      if (pckPatch !== undefined) {
        try {
          await pckPatch.revalidate();
        } catch (error) {
          if (activeController.signal.aborted) throw error;
          throw new PathPreparationError(
            boundedSecret(error, `${operationLabel} host identities or destination changed before launch`, redactText),
            { cause: error },
          );
        }
        throwIfAborted();
        return;
      }
      if (listingPreparation === undefined) return;
      try {
        listingPreparation = await revalidateListingInputs(
          listingPreparation,
          activeController.signal,
          undefined,
          { directoryInspector: this.listingInspector },
        );
        if (extraction !== undefined) {
          await extraction.revalidateDestination(listingPreparation);
        } else if (exportResources !== undefined) {
          await exportResources.revalidateDestination(listingPreparation);
        } else if (translationPatch !== undefined) {
          await translationPatch.revalidate();
        }
      } catch (error) {
        if (activeController.signal.aborted) throw error;
        throw new PathPreparationError(
          boundedSecret(error, `${operationLabel} input/destination graph changed before launch`, redactText),
          { cause: error },
        );
      }
      throwIfAborted();
    };

    const startTimeout = (): void => {
      if (timeoutStarted) return;
      timeoutStarted = true;
      if (plan?.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => activeController.abort({ kind: "timeout" }), plan.timeoutMs);
      }
    };

    // Failure priority is cleanup_failed > storage_failed > trigger > process.
    // Storage can never overwrite an unconfirmed-cleanup classification.
    const applyStorageFailure = (message: string): void => {
      const value = storageError ?? message;
      storageError = value;
      if (finalState === "failed" && finalError?.code === "cleanup_failed") return;
      finalState = "failed";
      finalError = errorValue("storage_failed", "finalizing", value);
    };

    const applyCancellation = (stage: Phase, message?: string): boolean => {
      if (!activeController.signal.aborted) return false;
      if (finalError?.code === "cleanup_failed" || storageError !== null) return true;
      const kind = mapAbortReason(activeController.signal.reason);
      const mapped = terminalForAbort(kind);
      finalState = mapped.status;
      finalError = errorValue(mapped.code, stage, message ?? "The operation was " + kind + ".");
      return true;
    };

    const persist = async (state: TerminalStatus, next: OperationResult): Promise<void> => {
      if (storage === undefined) throw new StorageError("operation storage is unavailable");
      const preflight = (extraction ?? exportResources)?.preflightEvidence ?? null;
      const translationEvidence = translationPatch?.preparationEvidence ?? null;
      const manifest = manifestFor(
        next,
        state,
        input,
        effective,
        invocation.parameterSources,
        invocationFor(next),
        effectsFor(next),
        effectiveSession,
        redactText,
        {
          ...(preflight === null ? {} : { preflight }),
          ...(translationEvidence === null
            ? {}
            : { translationPatch: translationEvidence }),
        },
      );
      await storage.writeManifest(manifest);
    };

    // Keep every path after registration inside this one cleanup boundary,
    // including initial-record failures.
    try {
      try {
        if (storage === undefined) {
          try {
            storage = await OperationStorage.create(
              workspace,
              {
                faults: this.storageFaults,
                writer: this.storageWriter,
                idFactory: () => id,
              },
            );
          } catch (error) {
            return this.finishPrelaunch(result, "failed", "storage_failed", boundedSecret(error, "operation storage could not be created", redactText), [], "validating", requestMono);
          }

          result = {
            ...result,
            paths: {
              workspace,
              operation: storage.paths.operation,
              output: storage.paths.output,
              effectiveDestination: null,
              manifest: storage.paths.manifest,
              artifactInventory: storage.paths.artifacts,
            },
            stdout: emptyStream(storage.paths.stdoutBin, storage.paths.stdoutText),
            stderr: emptyStream(storage.paths.stderrBin, storage.paths.stderrText),
            persistence: { state: "complete", error: null },
          };
        }

        if (preparationFailure === null) {
        throwIfAborted();
        emit("preparing");

        let runtime = this.runtimeManager.state;
        try {
          runtime = await this.runtimeManager.refreshIfChanged();
        } catch (error) {
          throw new StorageError(`runtime health evidence could not be refreshed: ${boundedSecret(error, "storage failure", redactText)}`, { cause: error });
        }
        result = { ...result, runtime };
        throwIfAborted();
        if (isApplication && listingPreparation !== undefined) {
          await revalidatePreparedGraph();
        }

        if (runtime.health !== "ready") {
          finalError = errorValue("runtime_unavailable", "preparing", "The GDRE runtime is unavailable; inspect runtime warnings and startup evidence.");
          finalState = "failed";
        } else {
          let profile: Awaited<ReturnType<typeof profileEnvironment>>;
          try {
            profile = await profileEnvironment(plan!.cwd, storage.paths.profile, isApplication);
          } catch (error) {
            throw new StorageError(`operation-local profile could not be created: ${boundedSecret(error, "storage failure", redactText)}`, { cause: error });
          }
          invocationProfile = profile.record;
          if (pckPatch?.hasTranslations) {
            const userData = profile.record.userData;
            const temp = [
              profile.record.overrides.TEMP,
              profile.record.overrides.TMP,
            ].filter((value): value is string => value !== undefined);
            if (userData === null || temp.length === 0) {
              throw new StorageError(
                "the operation-local profile did not expose owned userData/temp paths",
              );
            }
            pckPatch.setOwnedEnvironment({ userData, temp });
          }
          throwIfAborted();
          emit("running");
          throwIfAborted();
          if (isApplication && listingPreparation !== undefined) {
            await revalidatePreparedGraph();
          }

          const sink: StreamSink = {
            append: (kind, raw, text) => storage!.appendStream(kind, raw, text),
            close: () => storage!.closeStreams(),
          };
          const applyProcessTerminal = (run: ProcessRunResult, stage: Phase): boolean => {
            // Cleanup state is authority on its own: an unknown root PID or a
            // concurrent spawn/ownership error must not bypass quarantine.
            if (run.cleanup.state === "unconfirmed") {
              this.cleanupUnconfirmed = true;
              finalError = errorValue("cleanup_failed", "finalizing", run.cleanup.error ?? "Owned GDRE process cleanup could not be confirmed.", redactText);
              finalState = "failed";
              return true;
            }
            if (run.trigger === "storage" || run.storageError !== null) {
              storageError = run.storageError ?? "process stream storage failed";
              finalError = errorValue("storage_failed", "finalizing", storageError, redactText);
              finalState = "failed";
              return true;
            }
            if (run.trigger === "timeout") {
              finalError = errorValue("execution_timeout", "running", `${operationLabel} operation exceeded its finite execution deadline.`);
              finalState = "timed_out";
              return true;
            }
            if (run.trigger === "cancel" || run.trigger === "disconnect" || run.trigger === "shutdown") {
              const abortKind = run.trigger === "cancel" ? "cancelled" : run.trigger === "disconnect" ? "disconnected" : "shutdown";
              const mapped = terminalForAbort(abortKind);
              finalError = errorValue(mapped.code, "running", `The operation was ${abortKind}.`);
              finalState = mapped.status;
              return true;
            }
            if (applyCancellation(stage)) return true;
            if (run.spawnError !== null) {
              finalError = errorValue("spawn_failed", stage, run.spawnError.message, redactText);
              finalState = "failed";
              return true;
            }
            const successfulExit = run.exitCode === 0 || (!isApplication && run.exitCode === 1);
            if (run.signal !== null || !successfulExit) {
              finalState = "failed";
              finalError = errorValue("process_failed", stage, "GDRE did not exit normally with the command's successful exit code.");
              return true;
            }
            if (run.captureError !== null || !run.stdout.complete || !run.stderr.complete) {
              finalState = "failed";
              finalError = errorValue("process_failed", stage, "Process stream capture was incomplete; semantic success cannot be claimed.");
              return true;
            }
            return false;
          };
          const observeProcess = (run: ProcessRunResult): ProcessObservation => ({
            exitCode: run.exitCode,
            signal: run.signal,
            stdout: run.stdoutText,
            stderr: run.stderrText,
            stdoutTruncated: run.stdout.truncated,
            stderrTruncated: run.stderr.truncated,
            stdoutEvidence: run.stdout,
            stderrEvidence: run.stderr,
            abortSignal: activeController.signal,
            redactText,
            expectedLoads: listingPreparation?.expectedLoads,
          });
          const recordProcessObservation = (run: ProcessRunResult): void => {
            result = {
              ...result,
              runtime,
              timing: {
                ...result.timing,
                startedAt: run.spawnedAt,
                processExitedAt: run.exitedAt,
                processMs: run.spawnedAtMono !== null && run.exitedAtMono !== null
                  ? Math.max(0, Math.round(run.exitedAtMono - run.spawnedAtMono))
                  : null,
              },
              process: {
                pid: run.pid,
                exitCode: run.exitCode,
                signal: run.signal,
                spawnError: run.spawnError,
              },
              stdout: run.stdout,
              stderr: run.stderr,
              cleanup: { state: run.cleanup.state, trigger: run.cleanup.trigger, actions: [...run.cleanup.actions], error: run.cleanup.error },
              warnings: [...runtime.warnings, ...(run.stderrText.length > 0 ? ["GDRE wrote stderr; inspect the retained stderr evidence."] : [])].slice(0, 32),
            };
          };
          /**
           * Preserve a later auxiliary launch's cleanup observation without
           * downgrading an already-unconfirmed owned tree.
           */
          const recordAuxiliaryCleanup = (run: ProcessRunResult): void => {
            if (result.cleanup.state === "unconfirmed") return;
            result = {
              ...result,
              cleanup: {
                state: run.cleanup.state,
                trigger: run.cleanup.trigger,
                actions: [...run.cleanup.actions],
                error: run.cleanup.error,
              },
            };
          };

          /**
           * A combined script may intentionally exit nonzero after writing a
           * complete rejection report. Only this natural, confirmed-cleanup
           * shape is eligible for report classification; stops never parse.
           */
          const naturalRejectionEligible = (run: ProcessRunResult): boolean =>
            run.exitCode !== null &&
            run.exitCode !== 0 &&
            run.trigger === null &&
            run.signal === null &&
            run.spawnError === null &&
            run.captureError === null &&
            run.stdout.complete &&
            run.stderr.complete &&
            run.storageError === null &&
            run.cleanup.state !== "unconfirmed" &&
            finalError?.code === "process_failed" &&
            !activeController.signal.aborted;

          /** Apply one package-patch evaluation's semantic result terminally. */
          const applyPackagePatchEvaluation = (evaluation: {
            readonly status: string;
            readonly summary: string;
          }): void => {
            if (activeController.signal.aborted) {
              const abortKind = mapAbortReason(activeController.signal.reason);
              const mapped = terminalForAbort(abortKind);
              finalError = errorValue(
                mapped.code,
                "finalizing",
                `The operation was ${abortKind} during semantic evaluation.`,
              );
              finalState = mapped.status;
            } else if (evaluation.status === "unknown") {
              finalError = errorValue(
                "semantic_unknown",
                "finalizing",
                evaluation.summary,
                redactText,
              );
              finalState = "failed";
            } else if (evaluation.status !== "succeeded") {
              finalError = errorValue(
                "semantic_failed",
                "finalizing",
                evaluation.summary,
                redactText,
              );
              finalState = "failed";
            } else {
              finalState = "succeeded";
            }
          };

          let mainRun: ProcessRunResult | null = null;
          if (isArtifactProducing) {
            let skipMain = false;
            const operation: ExtractionOperation | ExportOperation | undefined =
              extraction ?? exportResources;
            if (operation === undefined) {
              throw new Error(
                "artifact-producing operation was not prepared before launch",
              );
            }
            const preflightBranch = await storage.createAuxiliaryStreams(
              isExtract
                ? EXTRACTION_EVIDENCE_NAMESPACE
                : EXPORT_EVIDENCE_NAMESPACE,
            );
            preflightSink = preflightBranch.sink;
            const preflightPlan = operation.preflightPlan();
            throwIfLaunchBlocked();
            startTimeout();
            throwIfAborted();
            const preflightRun = await this.processRunner.run({
              executable: runtime.executable,
              argv: [...preflightPlan.argv],
              cwd: preflightPlan.cwd,
              env: profile.env,
              streamPaths: {
                stdoutBin: preflightBranch.stdoutBin,
                stdoutText: preflightBranch.stdoutText,
                stderrBin: preflightBranch.stderrBin,
                stderrText: preflightBranch.stderrText,
              },
              signal: activeController.signal,
              statusPath: operation.preflightStatusPath,
              ownershipFactory: this.ownershipFactory,
              helperScriptPath: this.helperScriptPath,
              sink: preflightBranch.sink,
            });
            // Preserve observed preflight cleanup across every later early exit.
            // A main artifact-producing run replaces it without mixing primary
            // process/streams.
            result = {
              ...result,
              cleanup: {
                state: preflightRun.cleanup.state,
                trigger: preflightRun.cleanup.trigger,
                actions: [...preflightRun.cleanup.actions],
                error: preflightRun.cleanup.error,
              },
            };
            skipMain = applyProcessTerminal(preflightRun, "running");
            const preparation = await operation.prepareFromPreflight({
              run: preflightRun,
              observation: observeProcess(preflightRun),
              processStopped: skipMain,
              executable: runtime.executable,
              plan: preflightPlan,
              environmentProfile: invocationProfile,
              statusPath: operation.preflightStatusPath,
              store: storage,
            });
            if (preparation.ready) {
              applyCancellation("running");
              skipMain ||= finalError !== null;
            } else if (preparation.stopped) {
              applyCancellation("running");
              skipMain = true;
            } else if ("interrupted" in preparation) {
              if (preparation.interrupted.beforeLaunch) throwIfAborted();
              applyCancellation(preparation.interrupted.stage, preparation.interrupted.message);
              skipMain = true;
            } else {
              applyCancellation("running");
              skipMain ||= finalError !== null;
              if (!skipMain) {
                finalState = "failed";
                finalError = errorValue(
                  preparation.code,
                  "finalizing",
                  preparation.summary,
                  redactText,
                );
                if (preparation.semantic !== undefined) {
                  result = { ...result, semantic: preparation.semantic };
                }
                skipMain = true;
              }
            }

            if (!skipMain) {
              await revalidatePreparedGraph();
              throwIfAborted();
              operation.markAttempted();
              throwIfLaunchBlocked();
              startTimeout();
              throwIfAborted();
              mainRun = await this.processRunner.run({
                executable: runtime.executable,
                argv: [...plan!.argv],
                cwd: plan!.cwd,
                env: profile.env,
                streamPaths: {
                  stdoutBin: storage.paths.stdoutBin,
                  stdoutText: storage.paths.stdoutText,
                  stderrBin: storage.paths.stderrBin,
                  stderrText: storage.paths.stderrText,
                },
                signal: activeController.signal,
                statusPath: joinPath(storage.paths.operation, "ownership.json"),
                ownershipFactory: this.ownershipFactory,
                helperScriptPath: this.helperScriptPath,
                sink,
                redactSecrets: knownKey === undefined ? undefined : [knownKey],
              });
              recordProcessObservation(mainRun);
              const naturalExitSuccess = mainRun.exitCode === 0 && mainRun.signal === null && mainRun.spawnError === null;
              if (!applyProcessTerminal(mainRun, "running") && naturalExitSuccess) {
                // Provisional success until the artifact-dependent evaluation
                // runs; inventory/cancellation and semantic failures
                // can still supersede it below. A non-natural exit stays failed
                // so inventory errors never mask the process outcome.
                finalState = "succeeded";
              }
              artifactObservation = operation.enrichObservation(observeProcess(mainRun));
            }
          } else {
            // Package-patch host adaptation: read-only source inspection,
            // then the direct CLI patch, then output inspection. Every launch
            // crosses the existing owned runner and shares this call's timeout,
            // cancellation and cleanup priority.
            let prePatchFailed = false;
            if (pckPatch !== undefined) {
              await revalidatePreparedGraph();
              throwIfLaunchBlocked();
              startTimeout();
              throwIfAborted();
              const sourceBranch = await storage.createAuxiliaryStreams(
                PCK_PATCH_SOURCE_INSPECTION_NAMESPACE,
              );
              pckInspectionSinks.push(sourceBranch.sink);
              const sourcePlan = pckPatch.sourceInspectionPlan();
              const sourceRun = await this.processRunner.run({
                executable: runtime.executable,
                argv: [...sourcePlan.argv],
                cwd: sourcePlan.cwd,
                env: profile.env,
                streamPaths: {
                  stdoutBin: sourceBranch.stdoutBin,
                  stdoutText: sourceBranch.stdoutText,
                  stderrBin: sourceBranch.stderrBin,
                  stderrText: sourceBranch.stderrText,
                },
                signal: activeController.signal,
                statusPath: joinPath(sourceBranch.directory, "ownership.json"),
                ownershipFactory: this.ownershipFactory,
                helperScriptPath: this.helperScriptPath,
                sink: sourceBranch.sink,
              });
              recordProcessObservation(sourceRun);
              prePatchFailed = applyProcessTerminal(sourceRun, "running");
              if (prePatchFailed) {
                if (
                  sourceRun.storageError === null &&
                  sourceRun.trigger !== "storage"
                ) {
                  // Bounded stopped assessment: preserve acquired source
                  // report existence without parsing it, hashing or auditing.
                  // The cleanup/storage/timeout/cancellation terminal above
                  // keeps priority.
                  const evaluation = await pckPatch.assessStopped(
                    observeProcess(sourceRun),
                    "source-inspection",
                  );
                  result = {
                    ...result,
                    semantic: {
                      ...evaluation,
                      evidence: [...evaluation.evidence],
                    },
                  };
                }
              } else {
                const assessment = await pckPatch.acceptSourceInspection(
                  observeProcess(sourceRun),
                );
                if (!assessment.accepted) {
                  if (assessment.evaluation !== null) {
                    result = {
                      ...result,
                      semantic: {
                        ...assessment.evaluation,
                        evidence: [...assessment.evaluation.evidence],
                      },
                    };
                  }
                  finalState = "failed";
                  finalError = errorValue(
                    assessment.code ?? "semantic_unknown",
                    "running",
                    assessment.evaluation?.summary ??
                      "The source inspection could not be accepted.",
                    redactText,
                  );
                  prePatchFailed = true;
                }
              }
            }

            // A combined request derives the actual native destinations before
            // mutation. Report rejection is terminal: no direct patch follows.
            if (!prePatchFailed && pckPatch?.hasTranslations === true) {
              await revalidatePreparedGraph();
              throwIfLaunchBlocked();
              startTimeout();
              throwIfAborted();
              const preparationBranch = await storage.createAuxiliaryStreams(
                PCK_COMBINED_PREPARATION_NAMESPACE,
              );
              pckInspectionSinks.push(preparationBranch.sink);
              const preparationPlan = await pckPatch.preparationPlan();
              const preparationRun = await this.processRunner.run({
                executable: runtime.executable,
                argv: [...preparationPlan.argv],
                cwd: preparationPlan.cwd,
                env: profile.env,
                streamPaths: {
                  stdoutBin: preparationBranch.stdoutBin,
                  stdoutText: preparationBranch.stdoutText,
                  stderrBin: preparationBranch.stderrBin,
                  stderrText: preparationBranch.stderrText,
                },
                signal: activeController.signal,
                statusPath: joinPath(preparationBranch.directory, "ownership.json"),
                ownershipFactory: this.ownershipFactory,
                helperScriptPath: this.helperScriptPath,
                sink: preparationBranch.sink,
              });
              // This launch precedes mutation; the direct patch launch below
              // replaces its primary process/stream evidence.
              recordProcessObservation(preparationRun);
              const preparationProcessFailed = applyProcessTerminal(
                preparationRun,
                "running",
              );
              if (preparationProcessFailed) {
                let classifiedRejection = false;
                if (naturalRejectionEligible(preparationRun)) {
                  const assessment = await pckPatch.acceptPreparation(
                    observeProcess(preparationRun),
                  );
                  if (
                    !assessment.accepted &&
                    assessment.code === "semantic_failed" &&
                    assessment.evaluation !== null
                  ) {
                    result = {
                      ...result,
                      semantic: {
                        ...assessment.evaluation,
                        evidence: [...assessment.evaluation.evidence],
                      },
                    };
                    finalState = "failed";
                    finalError = errorValue(
                      "semantic_failed",
                      "running",
                      assessment.evaluation.summary,
                      redactText,
                    );
                    classifiedRejection = true;
                  }
                }
                if (
                  !classifiedRejection &&
                  preparationRun.storageError === null &&
                  preparationRun.trigger !== "storage"
                ) {
                  const evaluation = await pckPatch.assessStopped(
                    observeProcess(preparationRun),
                    "combined-preparation",
                  );
                  result = {
                    ...result,
                    semantic: {
                      ...evaluation,
                      evidence: [...evaluation.evidence],
                    },
                  };
                }
                prePatchFailed = true;
              } else {
                const assessment = await pckPatch.acceptPreparation(
                  observeProcess(preparationRun),
                );
                if (!assessment.accepted) {
                  if (assessment.evaluation !== null) {
                    result = {
                      ...result,
                      semantic: {
                        ...assessment.evaluation,
                        evidence: [...assessment.evaluation.evidence],
                      },
                    };
                  }
                  finalState = "failed";
                  finalError = errorValue(
                    assessment.code ?? "semantic_unknown",
                    "running",
                    assessment.evaluation?.summary ??
                      "The combined translation preparation could not be accepted.",
                    redactText,
                  );
                  prePatchFailed = true;
                }
              }
            }

            if (!prePatchFailed) {
              if (pckPatch !== undefined) {
                // Revalidate host identities and the still-absent destination
                // at the mutation launch seam.
                await revalidatePreparedGraph();
                throwIfAborted();
              }
              throwIfLaunchBlocked();
              startTimeout();
              throwIfAborted();
              mainRun = await this.processRunner.run({
                executable: runtime.executable,
                argv: [...plan!.argv],
                cwd: plan!.cwd,
                env: profile.env,
                streamPaths: {
                  stdoutBin: storage.paths.stdoutBin,
                  stdoutText: storage.paths.stdoutText,
                  stderrBin: storage.paths.stderrBin,
                  stderrText: storage.paths.stderrText,
                },
                signal: activeController.signal,
                statusPath: joinPath(storage.paths.operation, "ownership.json"),
                ownershipFactory: this.ownershipFactory,
                helperScriptPath: this.helperScriptPath,
                sink,
                redactSecrets: knownKey === undefined ? undefined : [knownKey],
              });
              recordProcessObservation(mainRun);
              const processFailed = applyProcessTerminal(mainRun, "running");
              await closeStreams();
              if (
                processFailed &&
                pckPatch !== undefined &&
                mainRun.storageError === null &&
                mainRun.trigger !== "storage"
              ) {
                // Bounded stopped assessment only: retain available output/.tmp
                // observations without parsing reports, re-fingerprinting
                // inputs, hashing or inventorying. The process/cleanup/timeout/
                // cancellation terminal stays authoritative.
                const evaluation = await pckPatch.assessStopped(
                  observeProcess(mainRun),
                  "patch",
                );
                result = {
                  ...result,
                  semantic: {
                    ...evaluation,
                    evidence: [...evaluation.evidence],
                  },
                };
              }
              if (!processFailed && !applyCancellation("finalizing")) {
                if (isPatch) {
                  // Exit 0 only means the fixed script delivered a report.
                  // Classify missing/malformed/contradictory/ok:false evidence
                  // before any inventory so a known native failure never triggers
                  // a scan/hash of its residual output tree. Only a valid success
                  // report proceeds to the existing inventory.
                  const observation = observeProcess(mainRun);
                  const precheck = await translationPatch!.precheck(observation);
                  if (precheck.proceed) {
                    finalState = "succeeded";
                    artifactObservation = observation;
                  } else {
                    const evaluation = precheck.evaluation;
                    finalState = "failed";
                    finalError = errorValue(
                      evaluation?.status === "unknown"
                        ? "semantic_unknown"
                        : "semantic_failed",
                      "finalizing",
                      evaluation?.summary ??
                        "The native translation patch report could not be classified.",
                      redactText,
                    );
                    if (evaluation !== null) {
                      result = {
                        ...result,
                        semantic: {
                          ...evaluation,
                          evidence: [...evaluation.evidence],
                        },
                      };
                    }
                  }
                } else if (pckPatch !== undefined) {
                  // Classify the direct patch before any success inventory. Only
                  // a natural exit, complete streams, the exact output marker,
                  // no patch-error evidence and a regular output file proceed
                  // to read-only output inspection.
                  const patchObservation = observeProcess(mainRun);
                  const precheck = await pckPatch.classifyPatch(patchObservation);
                  if (!precheck.proceed) {
                    const evaluation = precheck.evaluation;
                    finalState = "failed";
                    finalError = errorValue(
                      evaluation?.status === "unknown"
                        ? "semantic_unknown"
                        : "semantic_failed",
                      "finalizing",
                      evaluation?.summary ??
                        "The direct package-patch evidence could not be classified.",
                      redactText,
                    );
                    if (evaluation !== null) {
                      result = {
                        ...result,
                        semantic: {
                          ...evaluation,
                          evidence: [...evaluation.evidence],
                        },
                      };
                    }
                  } else {
                    throwIfLaunchBlocked();
                    startTimeout();
                    throwIfAborted();
                    const outputBranch = await storage.createAuxiliaryStreams(
                      PCK_PATCH_OUTPUT_INSPECTION_NAMESPACE,
                    );
                    pckInspectionSinks.push(outputBranch.sink);
                    const outputPlan = pckPatch.outputInspectionPlan();
                    const outputRun = await this.processRunner.run({
                      executable: runtime.executable,
                      argv: [...outputPlan.argv],
                      cwd: outputPlan.cwd,
                      env: profile.env,
                      streamPaths: {
                        stdoutBin: outputBranch.stdoutBin,
                        stdoutText: outputBranch.stdoutText,
                        stderrBin: outputBranch.stderrBin,
                        stderrText: outputBranch.stderrText,
                      },
                      signal: activeController.signal,
                      statusPath: joinPath(outputBranch.directory, "ownership.json"),
                      ownershipFactory: this.ownershipFactory,
                      helperScriptPath: this.helperScriptPath,
                      sink: outputBranch.sink,
                    });
                    recordAuxiliaryCleanup(outputRun);
                    const outputProcessFailed = applyProcessTerminal(
                      outputRun,
                      "running",
                    );
                    if (outputProcessFailed) {
                      // A stopped or failed output inspection never parses its
                      // report and never re-fingerprints inputs. Retain only the
                      // bounded available output/.tmp observations; the terminal
                      // classification above keeps priority.
                      const evaluation = await pckPatch.assessStopped(
                        observeProcess(outputRun),
                        "output-inspection",
                      );
                      result = {
                        ...result,
                        semantic: {
                          ...evaluation,
                          evidence: [...evaluation.evidence],
                        },
                      };
                    } else if (pckPatch.hasTranslations) {
                      // Byte/member/metadata gate first; only its acceptance
                      // permits the independent getter verification launch.
                      const content = await pckPatch.assessCombinedContent(
                        observeProcess(outputRun),
                      );
                      if (!content.proceed) {
                        const evaluation = content.evaluation!;
                        result = {
                          ...result,
                          semantic: {
                            ...evaluation,
                            evidence: [...evaluation.evidence],
                          },
                        };
                        applyPackagePatchEvaluation(evaluation);
                      } else {
                        throwIfLaunchBlocked();
                        startTimeout();
                        throwIfAborted();
                        const verificationBranch =
                          await storage.createAuxiliaryStreams(
                            PCK_COMBINED_VERIFICATION_NAMESPACE,
                          );
                        pckInspectionSinks.push(verificationBranch.sink);
                        const verificationPlan =
                          await pckPatch.verificationPlan();
                        const verificationRun = await this.processRunner.run({
                          executable: runtime.executable,
                          argv: [...verificationPlan.argv],
                          cwd: verificationPlan.cwd,
                          env: profile.env,
                          streamPaths: {
                            stdoutBin: verificationBranch.stdoutBin,
                            stdoutText: verificationBranch.stdoutText,
                            stderrBin: verificationBranch.stderrBin,
                            stderrText: verificationBranch.stderrText,
                          },
                          signal: activeController.signal,
                          statusPath: joinPath(
                            verificationBranch.directory,
                            "ownership.json",
                          ),
                          ownershipFactory: this.ownershipFactory,
                          helperScriptPath: this.helperScriptPath,
                          sink: verificationBranch.sink,
                        });
                        // Post-patch evidence must never replace the direct
                        // patch's primary process/stream/marker evidence.
                        recordAuxiliaryCleanup(verificationRun);
                        const verificationProcessFailed =
                          applyProcessTerminal(verificationRun, "running");
                        if (verificationProcessFailed) {
                          let classifiedRejection = false;
                          if (naturalRejectionEligible(verificationRun)) {
                            const evaluation =
                              await pckPatch.acceptVerification(
                                observeProcess(verificationRun),
                              );
                            result = {
                              ...result,
                              semantic: {
                                ...evaluation,
                                evidence: [...evaluation.evidence],
                              },
                            };
                            if (evaluation.status !== "succeeded") {
                              finalState = "failed";
                              finalError = errorValue(
                                evaluation.status === "unknown"
                                  ? "semantic_unknown"
                                  : "semantic_failed",
                                "finalizing",
                                evaluation.summary,
                                redactText,
                              );
                              classifiedRejection = true;
                            }
                          }
                          if (!classifiedRejection) {
                            const evaluation = await pckPatch.assessStopped(
                              observeProcess(verificationRun),
                              "verification",
                            );
                            result = {
                              ...result,
                              semantic: {
                                ...evaluation,
                                evidence: [...evaluation.evidence],
                              },
                            };
                          }
                        } else {
                          const evaluation =
                            await pckPatch.acceptVerification(
                              observeProcess(verificationRun),
                            );
                          result = {
                            ...result,
                            semantic: {
                              ...evaluation,
                              evidence: [...evaluation.evidence],
                            },
                          };
                          applyPackagePatchEvaluation(evaluation);
                        }
                      }
                    } else {
                      const evaluation = await pckPatch.evaluate(
                        patchObservation,
                        observeProcess(outputRun),
                      );
                      result = {
                        ...result,
                        semantic: {
                          ...evaluation,
                          evidence: [...evaluation.evidence],
                        },
                      };
                      applyPackagePatchEvaluation(evaluation);
                    }
                  }
                } else {
                  const evaluation = await descriptor.evaluate(observeProcess(mainRun));
                  result = {
                    ...result,
                    semantic: { ...evaluation, evidence: [...evaluation.evidence] },
                  };
                  if (activeController.signal.aborted) {
                    const abortKind = mapAbortReason(activeController.signal.reason);
                    const mapped = terminalForAbort(abortKind);
                    finalError = errorValue(mapped.code, "finalizing", `The operation was ${abortKind} during semantic evaluation.`);
                    finalState = mapped.status;
                  } else if (evaluation.status === "unknown") {
                    finalError = errorValue("semantic_unknown", "finalizing", evaluation.summary, redactText);
                    finalState = "failed";
                  } else if (evaluation.status !== "succeeded") {
                    finalError = errorValue("semantic_failed", "finalizing", evaluation.summary, redactText);
                    finalState = "failed";

                  } else {
                    finalState = "succeeded";
                  }
                }
              }
            }
          }
          await closeStreams();
        }
        }
      } catch (error) {
        const abortKind = activeController.signal.aborted ? mapAbortReason(activeController.signal.reason) : null;
        if (error instanceof PreLaunchError) {
          finalState = error.status;
          finalError = errorValue(error.code, currentPhase, error.message, redactText);
        } else if (error instanceof PathPreparationError) {
          finalState = "failed";
          finalError = errorValue("path_unsupported", currentPhase, error.message, redactText);
        } else if (error instanceof StorageError || (error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "storage_failed")) {
          applyStorageFailure(boundedSecret(error, "operation storage failed", redactText));
        } else if (abortKind !== null) {
          const mapped = terminalForAbort(abortKind);
          finalState = mapped.status;
          finalError = errorValue(mapped.code, currentPhase, `The operation was ${abortKind}.`, redactText);
        } else if (error instanceof PckPatchOperationError) {
          finalState = "failed";
          finalError = errorValue(error.code, currentPhase, error.message, redactText);
        } else {
          finalState = "failed";
          finalError = errorValue("process_failed", currentPhase, boundedSecret(error, "GDRE operation failed", redactText));
        }
      }

      emit("finalizing");
      if (storage !== undefined) {
        try {
          await closeStreams();
        } catch (error) {
          applyStorageFailure(boundedSecret(error, "stream finalization failed", redactText));
        }
        const inventoryRoots: ArtifactRoot[] = [];
        if (isInventoryProducing) {
          const operation = extraction ?? exportResources;
          inventoryRoots.push(
            ...(isPckPatch
              ? (pckPatch?.inventoryRoots() ?? [])
              : isPatch
                ? (translationPatch?.inventoryRoots(storage.paths.output) ?? [
                    { path: storage.paths.output, role: "output" },
                  ])
                : (operation?.inventoryRoots(storage.paths.output) ?? [
                    { path: storage.paths.output, role: "output" },
                  ])),
          );
        } else {
          inventoryRoots.push({ path: storage.paths.output, role: "output" });
          for (const write of plan?.effects.writes ?? []) {
            const insideOperation = pathContains(storage.paths.operation, write);
            const insideOutput = pathContains(storage.paths.output, write);
            if (insideOperation && !insideOutput) continue;
            if (!inventoryRoots.some((root) => root.path === write)) inventoryRoots.push({ path: write, role: "declared-output" });
          }
        }
        if (!applyCancellation("finalizing") && finalState === "succeeded" && finalError === null && storageError === null) {
          try {
            inventory = await inventoryArtifacts(inventoryRoots, { signal: activeController.signal });
          } catch (error) {
            const message = boundedSecret(error, "artifact inventory failed", redactText);
            inventory = {
              entries: [],
              errors: [message],
              complete: false,
              stopReason: null,
            };
          }
        } else {
          effectLimitations = [...effectLimitations, "Output inventory was not collected after failure or stop; existing destination files may remain."];
        }
        applyCancellation("finalizing");

        if (extraction !== undefined) {
          inventory = extraction.interpretInventory(inventory);
        } else if (exportResources !== undefined) {
          inventory = exportResources.interpretInventory(inventory);
        } else if (translationPatch !== undefined) {
          inventory = translationPatch.interpretInventory(inventory);
        }

        if (finalState === "succeeded" && storageError === null) {
          if (inventory.stopReason === "cancelled") {
            const abortKind = mapAbortReason(activeController.signal.reason);
            const mapped = terminalForAbort(abortKind);
            finalState = mapped.status;
            finalError = errorValue(mapped.code, "finalizing", `The operation was ${abortKind} during artifact inventory.`);
          } else if (!inventory.complete && !isPatch) {
            // A patch run still evaluates its structured native report with the
            // acquired inventory; a missing destination is report evidence,
            // not an automatic process failure.
            finalState = "failed";
            finalError = errorValue("process_failed", "finalizing", `Artifact inventory was incomplete: ${inventory.errors[0] ?? "one or more artifact entries could not be verified"}`, redactText);
          }
        }

        if (inventory.errors.length > 0) {
          effectLimitations = [
            ...effectLimitations,
            ...inventory.errors.map((error) => `artifact inventory: ${error}`),
          ];
        }
        if (inventory.stopReason !== null) {
          effectLimitations = [...effectLimitations, `artifact inventory stopped: ${inventory.stopReason}`];
        }

        // Package-patch content success is published only when the retained
        // output inventory is accepted. A storage-only persistence failure
        // keeps the fully verified content semantics; an incomplete/read-failed
        // or cancelled inventory downgrades completeness while retaining the
        // acquired inspection references and content observations.
        const inventoryAccepted =
          inventory.complete &&
          inventory.stopReason === null &&
          inventory.errors.length === 0;
        if (
          isPckPatch &&
          storageError === null &&
          !inventoryAccepted &&
          result.semantic.status === "succeeded" &&
          result.semantic.data !== null &&
          "samples" in result.semantic.data &&
          "replacements" in result.semantic.data.samples
        ) {
          const packageData = result.semantic.data;
          const diagnostics = [
            ...packageData.diagnostics,
            `Output package inventory was not accepted: ${inventory.errors[0] ?? inventory.stopReason ?? "completeness was not established"}.`,
          ]
            .slice(0, 16)
            .map((entry) => bounded(entry, "package-patch diagnostic"));
          result = {
            ...result,
            semantic: {
              ...result.semantic,
              status: "unknown",
              summary:
                "Package-patch content was verified, but the retained output inventory was not accepted.",
              data: {
                ...packageData,
                completeness: "unknown",
                diagnostics,
              },
            },
          };
        }

        const artifactItems = inventory.entries.slice(0, 32).map((entry) => ({
          path: entry.path,
          role: entry.role,
          bytes: entry.bytes,
          sha256: entry.sha256,
        }));
        result = {
          ...result,
          artifacts: {
            count: inventory.entries.length,
            items: artifactItems,
            truncated: inventory.entries.length > artifactItems.length,
            complete: inventory.complete,
          },
        };

        if (isInventoryProducing && artifactObservation !== null && finalState === "succeeded" && finalError === null && !applyCancellation("finalizing")) {
          // Artifact-dependent evaluation runs only after the actual inventory
          // exists; the process observation is preserved until this point.
          // Its awaited report/detail persistence is bounded here so one
          // storage or cancellation fault still yields a structured terminal
          // record with the acquired inventory, never a rejected execute().
          try {
            const evaluation = isPatch
              ? await translationPatch!.evaluate(artifactObservation, inventory)
              : isExport
                ? await exportResources!.evaluate(artifactObservation, inventory)
                : await descriptor.evaluate(
                    extraction!.evaluationObservation(artifactObservation, inventory),
                  );
            result = {
              ...result,
              semantic: { ...evaluation, evidence: [...evaluation.evidence] },
            };
            if (activeController.signal.aborted) {
              const abortKind = mapAbortReason(activeController.signal.reason);
              const mapped = terminalForAbort(abortKind);
              finalState = mapped.status;
              finalError = errorValue(mapped.code, "finalizing", `The operation was ${abortKind} during semantic evaluation.`);
            } else if (evaluation.status === "unknown") {
              finalState = "failed";
              finalError = errorValue("semantic_unknown", "finalizing", evaluation.summary, redactText);
            } else if (evaluation.status !== "succeeded") {
              finalState = "failed";
              finalError = errorValue("semantic_failed", "finalizing", evaluation.summary, redactText);
            } else if (artifactObservation.stdoutEvidence?.complete !== true || artifactObservation.stderrEvidence?.complete !== true) {
              finalState = "failed";
              finalError = errorValue("process_failed", "finalizing", "Process stream capture was incomplete; semantic success cannot be claimed.");
            } else if (isPatch && !inventory.complete) {
              finalState = "failed";
              finalError = errorValue("process_failed", "finalizing", `Artifact inventory was incomplete: ${inventory.errors[0] ?? "one or more artifact entries could not be verified"}`, redactText);
            } else {
              finalState = "succeeded";
            }
          } catch (error) {
            // Cleanup failure and an already-recorded storage failure keep
            // their established priority; cancellation cannot hide a storage
            // fault that prevented evidence from being retained.
            if (
              error instanceof StorageError ||
              (error &&
                typeof error === "object" &&
                "code" in error &&
                (error as { readonly code?: unknown }).code === "storage_failed")
            ) {
              applyStorageFailure(
                boundedSecret(
                  error,
                  "artifact-dependent evaluation evidence could not be persisted",
                  redactText,
                ),
              );
              applyCancellation("finalizing");
            } else if (activeController.signal.aborted) {
              applyCancellation("finalizing");
            } else {
              finalState = "failed";
              finalError = errorValue(
                "process_failed",
                "finalizing",
                boundedSecret(error, "artifact-dependent evaluation failed", redactText),
                redactText,
              );
            }
          }
        }

        const unexpected = inventory.entries.filter((entry) => entry.path.length > 0);
        if (!isInventoryProducing && unexpected.length > 0) {
          const paths = unexpected.slice(0, 32).map((entry) => entry.path);
          effectLimitations = [
            ...effectLimitations,
            `unexpected output artifacts observed: ${paths.join(", ")}`,
          ];
          if (finalState === "succeeded" && storageError === null && inventory.stopReason === null) {
            finalState = "failed";
            finalError = errorValue("semantic_failed", "finalizing", `${operationLabel} produced unexpected output artifacts; inspect the retained artifact inventory.`);
            result = {
              ...result,
              semantic: {
                ...result.semantic,
                status: "failed",
                summary: `${operationLabel} produced unexpected output artifacts.`,
                evidence: [...result.semantic.evidence, bounded(`Unexpected output artifacts: ${paths.join(", ")}`, "unexpected output artifacts")].slice(0, 32),
                data: null,
              },
            };
          }
        }

        try {
          await storage.writeArtifacts({
            schemaVersion: 1,
            complete: inventory.complete,
            entries: inventory.entries,
            errors: inventory.errors,
          });
        } catch (error) {
          applyStorageFailure(boundedSecret(error, "artifact inventory write failed", redactText));
        }
      }

      applyCancellation("finalizing");
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      // Prepare terminal timing once, before the single awaited record write.
      const terminalPreparedMono = monotonic();
      const terminalTiming = {
        ...result.timing,
        finishedAt: now(),
        totalMs: Math.max(0, Math.round(terminalPreparedMono - requestMono)),
        // There is no queue phase: a call's own work starts at request receipt.
        queueMs: 0,
      };
      result = {
        ...result,
        success: finalState === "succeeded" && storageError === null,
        status: finalState,
        error: finalError,
        timing: terminalTiming,
        persistence: { state: storageError === null ? "complete" : "incomplete", error: storageError },
      };

      if (storage !== undefined) {
        try {
          await persist(finalState, result);
        } catch (error) {
          applyStorageFailure(boundedSecret(error, "terminal manifest write failed", redactText));
          result = {
            ...result,
            success: false,
            status: finalState,
            error: finalError,
            persistence: { state: "incomplete", error: storageError },
          };
          process.stderr.write(`GDRE MCP terminal manifest write failed for operation ${id}: ${storageError}\n`);
        }
      }
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      await closeStreams().catch(() => {
        // Persistence state already reflects any close failure observed above.
      });
      await Promise.allSettled(
        pckInspectionSinks.map((sink) => sink.close()),
      );
    }

    const resultForSchema = invocation.commandId === "list-files" && redactText
      ? redactParameters(result, redactText) as OperationResult
      : result;
    const parsed = operationResultSchema.safeParse(resultForSchema);
    if (parsed.success) return parsed.data as OperationResultOutput;
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    process.stderr.write(`GDRE MCP result normalization failed for operation ${id}: ${issues}\n`);
    return operationResultSchema.parse(recoverResult(resultForSchema, id)) as OperationResultOutput;
  }

  private finishPrelaunch(
    result: OperationResult,
    status: TerminalStatus,
    code: ErrorCode,
    message: string,
    evidence: readonly string[] = [],
    stage: Phase = "validating",
    requestMono?: number,
  ): OperationResult {
    return {
      ...result,
      success: false,
      status,
      error: errorValue(code, stage, message),
      semantic: { ...result.semantic, evidence: [...evidence] },
      timing: {
        ...result.timing,
        finishedAt: now(),
        totalMs: requestMono === undefined ? 0 : Math.max(0, Math.round(monotonic() - requestMono)),
      },
      persistence: { state: "unavailable", error: null },
    };
  }

  public async close(reason: "shutdown" | "disconnect"): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const active = [...this.active.values()];
      for (const operation of active) operation.controller.abort({ kind: reason });
      await Promise.all(active.map((operation) => operation.completion));
    })();
    return this.closePromise;
  }
}

export async function openExecution(
  installationRoot: string,
  options: ExecutionOpenOptions = {},
): Promise<Execution> {
  const config = await loadConfig(installationRoot, options.environment);
  // Validate the configured workspace once; unsupported identity properties
  // prevent serving instead of being discovered by the first call.
  try {
    await resolveWorkspacePath(config.workspaceRoot);
  } catch (error) {
    const detail = bounded(error, "workspace validation failed");
    if (config.sources.workspace === "builtin") {
      throw new ConfigError(
        `The automatic temporary workspace ${bounded(config.workspaceRoot, "workspace path")} is unusable: ${detail}. Set GDRE_MCP_WORKSPACE or workspaceRoot to an explicit absolute local path.`,
        { cause: error },
      );
    }
    throw new ConfigError(`configured workspace is unsupported: ${detail}`, { cause: error });
  }
  const helperScriptPath = joinPath(config.installationRoot, "native", "gdre-job-object.ps1");
  await prepareNativeOwnershipHelper(helperScriptPath);
  const runtimeOptions: RuntimeHealthOptions = {
    ...options.runtime,
    processRunner: options.processRunner ?? options.runtime?.processRunner,
    ownershipFactory: options.ownershipFactory ?? options.runtime?.ownershipFactory,
    helperScriptPath,
  };
  const runtime = await RuntimeManager.create(config, runtimeOptions);
  const execution = new ExecutionImpl(config, runtime, options);
  return execution;
}

export { ExecutionImpl };
