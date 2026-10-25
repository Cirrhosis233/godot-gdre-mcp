import type { ZodType } from "zod";
import type { ArtifactInventory } from "./artifacts.js";
import {
  errorCodeSchema,
  exportResourcesInputSchema,
  exportResourcesSelectionSchema,
  exportSemanticDataSchema,
  extractInputSchema,
  extractSemanticDataSchema,
  listFilesInputSchema,
  listFilesSemanticDataSchema,
  operationResultSchema,
  operationStatusSchema,
  patchTranslationsInputSchema,
  patchTranslationsSemanticDataSchema,
  pckPatchInputSchema,
  pckPatchSemanticDataSchema,
  phaseSchema,
  runtimeStateSchema,
  semanticStatusSchema,
  versionInputSchema,
  versionSemanticDataSchema,
} from "./schemas.js";

export type CommandId =
  | "version"
  | "list-files"
  | "extract"
  | "export-resources"
  | "patch-translations"
  | "pck-patch";
export type ToolName =
  | "gdre_version"
  | "gdre_list_files"
  | "gdre_extract"
  | "gdre_export_resources"
  | "gdre_patch_translations"
  | "gdre_pck_patch";
export type Phase = (typeof phaseSchema)["_output"];
export type ErrorCode = (typeof errorCodeSchema)["_output"];
export type OperationStatus = (typeof operationStatusSchema)["_output"];
export type SemanticStatus = (typeof semanticStatusSchema)["_output"];
export type RuntimeState = (typeof runtimeStateSchema)["_output"];
export type VersionInput = (typeof versionInputSchema)["_output"];
export type ListFilesInput = (typeof listFilesInputSchema)["_output"];
export type ListFilesInputItem = ListFilesInput["inputs"][number];
export type ListFilesSessionAction = NonNullable<ListFilesInput["session"]>[number];
export type VersionSemanticData = (typeof versionSemanticDataSchema)["_output"];
export type ListFilesSemanticData = (typeof listFilesSemanticDataSchema)["_output"];
export type ExtractSemanticData = (typeof extractSemanticDataSchema)["_output"];
export type SemanticData =
  | VersionSemanticData
  | ListFilesSemanticData
  | ExtractSemanticData
  | ExportSemanticData
  | PatchTranslationsSemanticData
  | PckPatchSemanticData;
export type ExtractInput = (typeof extractInputSchema)["_output"];
export type ExtractInputItem = ExtractInput["inputs"][number];
export type ExtractSessionAction = NonNullable<ExtractInput["session"]>[number];
export type ExportResourcesInput = (typeof exportResourcesInputSchema)["_output"];
export type ExportResourcesInputItem = ExportResourcesInput["inputs"][number];
export type ExportSelection = (typeof exportResourcesSelectionSchema)["_output"];
export type ExportSessionAction = NonNullable<ExportResourcesInput["session"]>[number];
export type ExportSemanticData = (typeof exportSemanticDataSchema)["_output"];
export type PatchTranslationsInput = (typeof patchTranslationsInputSchema)["_output"];
export type PatchTranslationMapping = PatchTranslationsInput["translations"][number];
export type PatchTranslationsSessionAction = NonNullable<
  PatchTranslationsInput["session"]
>[number];
export type PatchTranslationsSemanticData = (typeof patchTranslationsSemanticDataSchema)["_output"];
export type PckPatchInput = (typeof pckPatchInputSchema)["_output"];
export type PckPatchMapping = PckPatchInput["patches"][number];
export type PckPatchTranslationMapping = NonNullable<
  PckPatchInput["translations"]
>[number];
export type PckPatchSessionAction = NonNullable<PckPatchInput["session"]>[number];
export type PckPatchSemanticData = (typeof pckPatchSemanticDataSchema)["_output"];
export type CommandInput =
  | VersionInput
  | ListFilesInput
  | ExtractInput
  | ExportResourcesInput
  | PatchTranslationsInput
  | PckPatchInput;
export type CommandParameterName = (
  | keyof VersionInput
  | keyof ListFilesInput
  | keyof ExtractInput
  | keyof ExportResourcesInput
  | keyof PatchTranslationsInput
  | keyof PckPatchInput
) & string;
export type OperationResult = (typeof operationResultSchema)["_output"];

export type EvidenceStatus = "S" | "R+" | "R-" | "U";
export type ParameterType = "string" | "integer" | "array" | "object" | "boolean";
export type Cardinality = "scalar" | "ordered";
export type PathRole = "workspace" | "input" | "output" | "none";
export type Sensitivity = "public" | "secret";
export type Routing = "injected" | "application";

export interface EvidenceReference {
  readonly status: EvidenceStatus;
  readonly source: string;
  readonly detail: string;
}

/**
 * One caller-submitted host path and the issue location that identifies its
 * exact leaf field. Projections never normalize or resolve the submitted value.
 */
export interface HostPathProjection {
  readonly value: string;
  readonly path: readonly (string | number)[];
}

export type HostPathProjector<TInput = CommandInput> = (
  input: TInput,
) => readonly HostPathProjection[];

export interface ParameterDescriptorBase<TInput = CommandInput> {
  readonly name: keyof TInput & string;
  readonly type: ParameterType;
  readonly required: boolean;
  readonly defaultValue?: string | number;
  readonly cardinality: Cardinality;
  readonly applicableCommands: readonly [CommandId, ...CommandId[]];
  readonly sensitivity: Sensitivity;
  readonly encoding: string;
  readonly description: string;
  readonly effects: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}

export interface HostPathParameterDescriptor<TInput = CommandInput>
  extends ParameterDescriptorBase<TInput> {
  readonly pathRole: "input" | "output";
  readonly hostPaths: HostPathProjector<TInput>;
}

export interface OtherParameterDescriptor<TInput = CommandInput>
  extends ParameterDescriptorBase<TInput> {
  readonly pathRole: "workspace" | "none";
  readonly hostPaths?: never;
}

export type ParameterDescriptor<TInput = CommandInput> =
  | HostPathParameterDescriptor<TInput>
  | OtherParameterDescriptor<TInput>;

export interface QueryAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface CommandEffects {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly network: boolean;
  readonly codeExecution: boolean;
  readonly unknownScope: boolean;
}

export interface CoverageDescriptor {
  readonly fixtureIds: readonly string[];
  readonly constraints: readonly string[];
  readonly prerequisites: readonly string[];
}

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ValidationResult<TInput> =
  | { readonly ok: true; readonly value: TInput }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "validation_failed";
        readonly message: string;
        readonly issues: readonly ValidationIssue[];
      };
    };

/** Only resolved, execution-neutral planning inputs cross this seam. */
export interface PlanningContext {
  readonly workspace: string;
  readonly operationDirectory: string;
  /** Ordered absolute inputs resolved and admitted by the execution layer, including glob expansion. */
  readonly resolvedInputs?: readonly string[];
  /** Accepted absolute mutation destination, distinct from operation-owned output. */
  readonly effectiveOutput?: string;
  /** Ordered absolute translation-hint paths resolved by the execution layer. */
  readonly resolvedHints?: readonly string[];
  /** Ordered absolute original CSV files paired with their exact logical resources. */
  readonly resolvedTranslations?: readonly PatchTranslationMapping[];
  /** Adapter-owned fixed native translation-patch script; never caller-controlled. */
  readonly patchTranslationsScriptPath?: string;
  /** Resolved absolute source package for host-mediated package patching. */
  readonly resolvedPckSource?: string;
  /** Resolved absolute replacement host files paired with admitted logical members. */
  readonly resolvedPatches?: readonly PckPatchMapping[];
  /**
   * Resolved absolute original host CSV paths paired with exact logical import
   * sources for an admitted combined package patch. This is provenance and
   * identity context, never operation-owned prepared staging.
   */
  readonly resolvedPckTranslations?: readonly PckPatchTranslationMapping[];
  /**
   * Optional operation-owned BOM-stripped prepared CSV paths aligned with
   * `resolvedPckTranslations`. When supplied, planning uses these for CLI argv
   * and read effects. Pure planning does not certify ownership or staging;
   * combined preparation must supply these copies instead of host originals.
   */
  readonly preparedPckTranslations?: readonly PckPatchTranslationMapping[];
}

export interface InvocationPlan {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Optional caller-selected cancellation budget; omission has no execution deadline. */
  readonly timeoutMs?: number;
  readonly effects: CommandEffects;
}

/** Complete retained stream metadata used by evaluators that must bypass previews. */
export interface RetainedStreamEvidence {
  readonly rawPath: string | null;
  readonly textPath: string | null;
  readonly complete: boolean;
  readonly utf8Valid: boolean;
}

/** One loader path the preparation graph expects the fixed runtime to open. */
export interface ExpectedLoad {
  readonly path: string;
  readonly realPath?: string;
  readonly role?: "input" | "dependency";
  readonly kind?: "file" | "directory";
}

/** Native import metadata retained from the adapter-owned preflight inspector. */
export interface ExportImportMetadata {
  readonly path: string;
  readonly importMdPath: string;
  readonly sourceFile: string;
  readonly importer: string;
  readonly type: string;
  readonly destFiles: readonly string[];
}

/** Validated export expectation context supplied to artifact-dependent evaluation. */
export interface ExportEvaluationContext {
  readonly effectiveOutput: string;
  readonly effectiveOutputRealPath: string;
  readonly completeMembers: readonly string[];
  readonly selectedMembers: readonly string[];
  readonly imports: readonly ExportImportMetadata[];
  readonly nativeReportPath: string;
  readonly nativeLogPath: string;
  readonly resourceStringsPath: string | null;
  readonly nativePreflightPath: string;
  readonly expectationsPath: string;
  readonly dumpResourceStrings: boolean;
  readonly selection: {
    readonly kind: "members" | "group";
    readonly group: "scripts" | "translations" | null;
  };
}

/** Process evidence supplied by an execution adapter to a command evaluator. */
export interface ProcessObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated?: boolean;
  readonly stdoutEvidence?: RetainedStreamEvidence;
  readonly stderrEvidence?: RetainedStreamEvidence;
  /** Request cancellation observed while scanning persisted evidence. */
  readonly abortSignal?: AbortSignal;
  /** Monotonic deadline owned by the execution layer. */
  readonly deadlineMono?: number;
  /** Redacts caller-known secrets before any semantic preview/sample bounding. */
  readonly redactText?: (text: string) => string;
  /** Prepared loader paths that must be corroborated by complete stdout evidence. */
  readonly expectedLoads?: readonly ExpectedLoad[];
  /** Complete preflight member set, never the bounded public listing sample. */
  readonly expectedMembers?: readonly string[];
  /** Selected member subset derived from accepted selection semantics; absent means all members. */
  readonly expectedSelectedMembers?: readonly string[];
  readonly effectiveOutput?: string;
  /** Validated canonical inventory root corresponding to `effectiveOutput`. */
  readonly effectiveOutputRealPath?: string;
  /** Actual retained output inventory for artifact-producing evaluation. */
  readonly artifacts?: ArtifactInventory;
  /** Validated export expectations for artifact-dependent export evaluation. */
  readonly exportContext?: ExportEvaluationContext;
}

export interface EvaluationResult<TData> {
  readonly status: SemanticStatus;
  readonly rule: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly data: TData | null;
}

export type ValidationHook<TInput> = (input: unknown) => ValidationResult<TInput>;
export type PlanningHook<TInput> = (
  input: TInput,
  context: PlanningContext,
) => InvocationPlan;
type EvaluationReturn<TData, TAsync extends boolean> = TAsync extends true
  ? Promise<EvaluationResult<TData>>
  : TAsync extends false
    ? EvaluationResult<TData>
    : EvaluationResult<TData> | Promise<EvaluationResult<TData>>;

export type EvaluationHook<TData, TAsync extends boolean = boolean> = (
  observation: ProcessObservation,
) => EvaluationReturn<TData, TAsync>;

export interface CommandDescriptor<
  TInput = CommandInput,
  TData = SemanticData,
  TAsync extends boolean = boolean,
> {
  readonly id: CommandId;
  readonly toolName: ToolName;
  readonly category: "runtime" | "application";
  readonly title: string;
  readonly description: string;
  readonly cliSpellings: readonly string[];
  readonly aliases: readonly string[];
  readonly routing: Routing;
  readonly argv: readonly string[];
  readonly exactArgv: readonly string[];
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<OperationResult>;
  readonly parameterDescriptors: readonly ParameterDescriptor<TInput>[];
  readonly annotations: QueryAnnotations;
  readonly effects: CommandEffects;
  readonly evidence: readonly EvidenceReference[];
  readonly coverage: CoverageDescriptor;
  readonly validate: ValidationHook<TInput>;
  readonly plan: PlanningHook<TInput>;
  readonly evaluate: EvaluationHook<TData, TAsync>;
}

export type VersionCommandDescriptor = CommandDescriptor<
  VersionInput,
  VersionSemanticData,
  false
> & {
  readonly id: "version";
  readonly toolName: "gdre_version";
};
export type ListFilesCommandDescriptor = CommandDescriptor<
  ListFilesInput,
  ListFilesSemanticData,
  true
> & {
  readonly id: "list-files";
  readonly toolName: "gdre_list_files";
};
export type ExtractCommandDescriptor = CommandDescriptor<
  ExtractInput,
  ExtractSemanticData,
  true
> & {
  readonly id: "extract";
  readonly toolName: "gdre_extract";
};
export type ExportResourcesCommandDescriptor = CommandDescriptor<
  ExportResourcesInput,
  ExportSemanticData,
  true
> & {
  readonly id: "export-resources";
  readonly toolName: "gdre_export_resources";
};
export type PatchTranslationsCommandDescriptor = CommandDescriptor<
  PatchTranslationsInput,
  PatchTranslationsSemanticData,
  false
> & {
  readonly id: "patch-translations";
  readonly toolName: "gdre_patch_translations";
};
export type PckPatchCommandDescriptor = CommandDescriptor<
  PckPatchInput,
  PckPatchSemanticData,
  false
> & {
  readonly id: "pck-patch";
  readonly toolName: "gdre_pck_patch";
};
export type AnyCommandDescriptor =
  | VersionCommandDescriptor
  | ListFilesCommandDescriptor
  | ExtractCommandDescriptor
  | ExportResourcesCommandDescriptor
  | PatchTranslationsCommandDescriptor
  | PckPatchCommandDescriptor;
/** Renderer-only metadata; runtime descriptors retain the typed projector invariant. */
export type AnyParameterDescriptor = Omit<ParameterDescriptorBase, "name"> & {
  readonly name: CommandParameterName;
  readonly pathRole: PathRole;
};
export type CommandRegistry = readonly [
  VersionCommandDescriptor,
  ListFilesCommandDescriptor,
  ExtractCommandDescriptor,
  ExportResourcesCommandDescriptor,
  PatchTranslationsCommandDescriptor,
  PckPatchCommandDescriptor,
];
