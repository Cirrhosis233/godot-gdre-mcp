import {
  MAX_EXTRACT_SELECTION_PATTERNS,
  MAX_INPUT_VALUE_BYTES,
  MAX_LIST_INPUTS,
  MAX_SESSION_ACTIONS,
  MAX_PCK_PATCH_MAPPINGS,
  MAX_TRANSLATION_LOCALES,
  MAX_TRANSLATION_MAPPINGS,
  exportResourcesInputSchema,
  extractInputSchema,
  listFilesInputSchema,
  operationResultSchema,
  patchTranslationsInputSchema,
  pckPatchInputSchema,
  versionInputSchema,
} from "./schemas.js";
import { evaluateExport } from "./export-evaluation.js";
import {
  EXPORT_ARGV_PREFIX,
  buildExportRecoveryPlan,
} from "./export-planning.js";
import {
  PATCH_TRANSLATIONS_ARGV_PREFIX,
  PATCH_TRANSLATIONS_RULE,
  buildPatchTranslationsPlan,
} from "./translation-planning.js";
import {
  PCK_PATCH_ARGV_PREFIX,
  PCK_PATCH_RULE,
  buildPckPatchPlan,
} from "./pck-patch-planning.js";
import { evaluateExtract } from "./extraction.js";
import { evaluateListFiles } from "./listing.js";
import type {
  CommandRegistry,
  EvaluationResult,
  EvidenceReference,
  ExportResourcesCommandDescriptor,
  ExportResourcesInput,
  ExportSemanticData,
  ExtractCommandDescriptor,
  ExtractInput,
  HostPathProjection,
  InvocationPlan,
  ListFilesCommandDescriptor,
  ListFilesInput,
  ListFilesSemanticData,
  PatchTranslationsCommandDescriptor,
  PatchTranslationsInput,
  PatchTranslationsSemanticData,
  PckPatchCommandDescriptor,
  PckPatchInput,
  PckPatchSemanticData,
  PlanningContext,
  ProcessObservation,
  ValidationResult,
  VersionCommandDescriptor,
  VersionInput,
  VersionSemanticData,
} from "./types.js";

const VERSION_ARGV = ["--headless", "--gdre-version"] as const;

/**
 * Reusable typed projections of caller host paths. Descriptor `pathRole`
 * remains the field-role declaration; these functions project only the host
 * leaves inside a parameter value and attach the exact validation location.
 * Logical member/resource identities are intentionally absent.
 */
type HostInputItem =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "glob"; readonly pattern: string };

const projectInputs = (input: {
  readonly inputs: readonly HostInputItem[];
}): readonly HostPathProjection[] =>
  input.inputs.map((item, index) =>
    item.kind === "path"
      ? { value: item.path, path: ["inputs", index, "path"] as const }
      : { value: item.pattern, path: ["inputs", index, "pattern"] as const },
  );

const projectOutput = (input: {
  readonly output?: string;
}): readonly HostPathProjection[] =>
  input.output === undefined ? [] : [{ value: input.output, path: ["output"] }];

const projectTranslationHints = (input: {
  readonly translationHints?: readonly string[];
}): readonly HostPathProjection[] =>
  input.translationHints?.map((value, index) => ({
    value,
    path: ["translationHints", index] as const,
  })) ?? [];

const projectTranslationCsvs = (input: {
  readonly translations?: readonly {
    readonly csv: string;
    readonly resource: string;
  }[];
}): readonly HostPathProjection[] =>
  input.translations?.map((mapping, index) => ({
    value: mapping.csv,
    path: ["translations", index, "csv"] as const,
  })) ?? [];

const projectPackageSource = (input: {
  readonly source: string;
}): readonly HostPathProjection[] => [{ value: input.source, path: ["source"] }];

const projectPackageHostSources = (input: {
  readonly patches?: readonly { readonly hostSource: string }[];
}): readonly HostPathProjection[] =>
  input.patches?.map((mapping, index) => ({
    value: mapping.hostSource,
    path: ["patches", index, "hostSource"] as const,
  })) ?? [];

const versionEffects = {
  reads: ["the configured GDRE runtime executable and companion files"],
  writes: ["operation logs, manifest, and artifact inventory"],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

const versionEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: "docs/operation-contract.md §2.2 and §10.1",
    detail: "The version query emits the injected --gdre-version spelling.",
  },
  {
    status: "R+",
    source: "test/stdio.test.ts — real stdio version acceptance",
    detail: "The fixed packaged runtime printed `Godot RE Tools v2.8.0-beta.2` and naturally exited 1; both were accepted.",
  },
];

const versionParameterDescriptors = [
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["version"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description:
      "Optional absolute workspace selector. Relative, UNC, device, and drive-relative paths are rejected.",
    effects: ["selects the persistent workspace used by the execution module"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail: "Workspace selectors are absolute paths resolved by the execution module.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["version"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description:
      "Optional caller-selected cancellation budget, at most 3600000 ms. There is no implicit operation timeout.",
    effects: ["requests cancellation of the operation when the explicit budget expires"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail: "Public calls have no implicit deadline; explicit timeout policies request cancellation through the operation stop path.",
      },
    ],
  },
] as const;

const validateVersion = (input: unknown): ValidationResult<VersionInput> => {
  const parsed = versionInputSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_version accepts only optional absolute workspace and bounded positive timeoutMs fields.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planVersion = (
  input: VersionInput,
  context: { readonly workspace: string; readonly operationDirectory: string },
): InvocationPlan => ({
  argv: [...VERSION_ARGV],
  cwd: context.operationDirectory,
  timeoutMs: input.timeoutMs,
  effects: {
    reads: [],
    writes: [context.operationDirectory],
    network: versionEffects.network,
    codeExecution: versionEffects.codeExecution,
    unknownScope: versionEffects.unknownScope,
  },
});

const failedEvaluation = (
  summary: string,
  evidence: readonly string[],
): EvaluationResult<VersionSemanticData> => ({
  status: "failed",
  rule: "gdre-version-line-v1",
  summary,
  evidence,
  data: null,
});

const evaluateVersion = (
  observation: ProcessObservation,
): EvaluationResult<VersionSemanticData> => {
  if (observation.signal !== null) {
    return failedEvaluation(
      "GDRE did not report a version because the process ended by signal.",
      [`Observed signal ${observation.signal}.`],
    );
  }

  if (observation.exitCode !== 0 && observation.exitCode !== 1) {
    return failedEvaluation(
      "GDRE did not report a version with an accepted natural exit code.",
      [`Observed exit code ${String(observation.exitCode)}; expected 0 or 1.`],
    );
  }

  if (observation.stdoutTruncated !== false) {
    return failedEvaluation(
      "GDRE version output was truncated or its completeness was not explicitly established; the complete version line cannot be confirmed from the bounded observation.",
      ["Inspect the complete retained stdout evidence before treating the version probe as successful."],
    );
  }

  const normalized = observation.stdout
    .replace(/^﻿/u, "")
    .replace(/\r\n?/gu, "\n");
  const withoutOneTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;

  if (withoutOneTrailingNewline.includes("\n")) {
    return failedEvaluation(
      "GDRE version output contained more than one line.",
      ["Expected exactly one GDRE version line after newline normalization."],
    );
  }

  const match = /^Godot RE Tools v(.+)$/u.exec(withoutOneTrailingNewline);
  if (match === null || match[1] === undefined || match[1].length === 0) {
    return failedEvaluation(
      "GDRE version output did not contain the expected version line.",
      ["Expected a line matching `Godot RE Tools v<VERSION>`."],
    );
  }

  const evidence = [
    `Recognized GDRE version line for ${match[1]}.`,
    `Natural exit code ${String(observation.exitCode)} is accepted for the fixed runtime.`,
  ];
  if (observation.stderr.length > 0) {
    evidence.push("Stderr was retained as process evidence alongside the recognized version line.");
  }

  return {
    status: "succeeded",
    rule: "gdre-version-line-v1",
    summary: "GDRE version reported successfully.",
    evidence,
    data: { version: match[1] },
  };
};

const listFilesEffects = {
  reads: ["the admitted listing input paths"],
  writes: ["operation logs, retained stdout/stderr evidence, manifest, and artifact inventory"],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

export const APPLICATION_ARGV_PREFIX = ["--headless", "--no-header", "--"] as const;
export const LIST_FILES_ARGV_PREFIX = APPLICATION_ARGV_PREFIX;
export const EXTRACT_ARGV_PREFIX = APPLICATION_ARGV_PREFIX;

const listFilesEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: "docs/operation-contract.md §2.2, §2.3, and §8.2",
    detail: "Application listing emits ordered session arguments followed by repeated --list-files paths and requires complete semantic evidence.",
  },
  {
    status: "R+",
    source: "test/listing-stdio.test.ts — real stdio listing acceptance",
    detail: "Independently authored fixture calls cover PCK formats 0–4, ZIP/APK, marked directories, controlled bundle layouts, sidecar selection, XAPK listing, and one encrypted listing with explicit negative cases.",
  },
];

const validateListFiles = (input: unknown): ValidationResult<ListFilesInput> => {
  const parsed = listFilesInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_list_files requires a nonempty ordered path/glob input array and accepts only the bounded key, session, workspace, and timeoutMs fields.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number => typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planListFiles = (
  input: ListFilesInput,
  context: { readonly workspace: string; readonly operationDirectory: string; readonly resolvedInputs?: readonly string[] },
): InvocationPlan => {
  const resolvedInputs = context.resolvedInputs;
  if (resolvedInputs === undefined || resolvedInputs.length === 0) {
    throw new Error("resolved listing inputs are required before planning");
  }
  const session = (input.session ?? []).map((action) =>
    `--disable-multithreading=${action.disabled ? "true" : "false"}`,
  );
  const primary = resolvedInputs.map((value) => `--list-files=${value}`);
  const key = input.key === undefined ? [] : [`--key=${input.key}`];
  return {
    argv: [...LIST_FILES_ARGV_PREFIX, ...session, ...primary, ...key],
    cwd: context.operationDirectory,
    timeoutMs: input.timeoutMs,
    effects: {
      reads: [...resolvedInputs],
      writes: [context.operationDirectory],
      network: listFilesEffects.network,
      codeExecution: listFilesEffects.codeExecution,
      unknownScope: listFilesEffects.unknownScope,
    },
  };
};

const listFilesParameterDescriptors = [
  {
    name: "inputs",
    type: "array",
    required: true,
    cardinality: "ordered",
    applicableCommands: ["list-files"],
    pathRole: "input",
    hostPaths: projectInputs,
    sensitivity: "public",
    encoding: "ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline =",
    description: "Nonempty ordered input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly.",
    effects: ["reads each admitted input without claiming package-member filesystem artifacts"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §3.2",
        detail: "Inputs are ordered and resolved by the execution layer before shell-free launch.",
      },
    ],
  },
  {
    name: "key",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["list-files"],
    pathRole: "none",
    sensitivity: "secret",
    encoding: "exactly 64 hexadecimal characters; normalized lowercase and redacted by execution",
    description: "Optional 64-hex decryption key. Presence does not imply generalized encryption support.",
    effects: ["supplies the application key without changing input identity"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.3",
        detail: "Keys have a fixed hexadecimal shape and must not be logged or hashed as a substitute for redaction.",
      },
    ],
  },
  {
    name: "session",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["list-files"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "ordered multithreading actions only; each emits a dedicated boolean token",
    description: "Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice.",
    effects: ["controls the listing process without admitting generic settings, cache, or loader actions"],
    evidence: [
      {
        status: "R+",
        source: "test/listing-stdio.test.ts — multithreading session acceptance",
        detail: "Both --disable-multithreading=true and false were accepted by the fixed runtime in controlled listing calls.",
      },
    ],
  },
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["list-files"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description: "Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths.",
    effects: ["selects administrative operation roots; it is not an input path"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail: "Workspace selectors are absolute local paths and have no current-working-directory fallback.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["list-files"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description: "Optional caller-selected cancellation budget. There is no implicit listing timeout.",
    effects: ["requests cancellation of process work and necessary checks"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail: "Listing has no implicit deadline; an explicit timeout uses the operation cancellation path.",
      },
    ],
  },
] as const;

export const listFilesCommand: ListFilesCommandDescriptor = {
  id: "list-files",
  toolName: "gdre_list_files",
  category: "application",
  title: "GDRE list files",
  description:
    "List package/project members from admitted inputs using complete retained GDRE evidence; package members are not filesystem artifacts and this operation is not a security sandbox.",
  cliSpellings: ["--list-files"],
  aliases: [],
  routing: "application",
  argv: LIST_FILES_ARGV_PREFIX,
  exactArgv: LIST_FILES_ARGV_PREFIX,
  inputSchema: listFilesInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: listFilesParameterDescriptors,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  effects: listFilesEffects,
  evidence: listFilesEvidence,
  coverage: {
    fixtureIds: ["list-files-v1", "list-files-complete-evidence-v1"],
    constraints: [
      "strict input object rejects output/include/exclude, generic settings, cache, loader, and unknown fields",
      "inputs are nonempty ordered path/glob discriminated values; wildcard literals are rejected",
      `inputs are capped at ${String(MAX_LIST_INPUTS)} groups, session is capped at ${String(MAX_SESSION_ACTIONS)} actions, and each input value is capped at ${String(MAX_INPUT_VALUE_BYTES)} UTF-8 bytes`,
      "key is exactly 64 hexadecimal characters and normalized lowercase",
      "only ordered multithreading session actions are admitted",
      "argv is --headless --no-header -- followed by session, repeated resolved --list-files paths, then key",
      "semantic success requires one complete valid listing section, matching count, natural exit 0, and no load errors",
      "semantic data contains only a bounded member sample and complete stdout evidence reference",
    ],
    prerequisites: ["tracked listing fixture helper, fixed runtime, and real stdio acceptance tests"],
  },
  validate: validateListFiles,
  plan: planListFiles,
  evaluate: evaluateListFiles,
};

const extractEffects = {
  reads: ["the admitted extraction input paths"],
  writes: [
    "the exact accepted extraction destination and operation logs, manifest, and artifact inventory",
  ],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

const extractEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: "docs/operation-contract.md §2.2, §2.3, §3.1, §3.3, and §8.2",
    detail:
      "Extraction emits the application prefix, ordered session actions, repeated absolute --extract inputs, then --output; default checksum verification emits no override flag.",
  },
  {
    status: "R+",
    source: "test/extraction-stdio.test.ts — real stdio extraction tracer",
    detail:
      "One independently authored unencrypted PCK was extracted through the production stdio tool; exact member bytes/SHA-256, destination, separately inventoried administrative log, complete inventory, retained preflight evidence, and generated safety configuration were verified.",
  },
  {
    status: "R+",
    source: "test/extraction-inputs-stdio.test.ts — real stdio extraction input matrix",
    detail:
      "Command-specific extraction verifies independently expected bytes for PCK formats 0–4, stored ZIP, assets-only APK, XAPK, marked directories, controlled .app layouts, and executable sidecars, with explicit destinations, ordered/disjoint multi-inputs, globs, session replacement, and complete bounded artifact evidence.",
  },
  {
    status: "R+",
    source: "test/extraction-selection-stdio.test.ts — real stdio selected extraction",
    detail:
      "Independently authored fixtures verify exact filtered and script/translation outputs, ordered overlapping includes with excludes, full versus selected expectation records, full-pack checksum coverage when selecting one of three members, excluded invalid-MD5 failure, no-match safety, directory-filter limits, and bounded responses with complete selected inventories.",
  },
];

const validateExtract = (input: unknown): ValidationResult<ExtractInput> => {
  const parsed = extractInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_extract requires a nonempty ordered path/glob input array and accepts only optional output, ordered include/exclude patterns, all/scripts/translations selection, session, workspace, and timeoutMs fields; key and checksum remain deferred and rejected.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planExtract = (
  input: ExtractInput,
  context: PlanningContext,
): InvocationPlan => {
  const resolvedInputs = context.resolvedInputs;
  if (resolvedInputs === undefined || resolvedInputs.length === 0) {
    throw new Error("resolved extraction inputs are required before planning");
  }
  const effectiveOutput = context.effectiveOutput;
  if (effectiveOutput === undefined || effectiveOutput.length === 0) {
    throw new Error("effective extraction output is required before planning");
  }
  const session = (input.session ?? []).map((action) =>
    `--disable-multithreading=${action.disabled ? "true" : "false"}`,
  );
  const primary = resolvedInputs.map((value) => `--extract=${value}`);
  const include = (input.include ?? []).map((pattern) => `--include=${pattern}`);
  const exclude = (input.exclude ?? []).map((pattern) => `--exclude=${pattern}`);
  const modeFlag =
    input.selection === "scripts"
      ? ["--scripts-only"]
      : input.selection === "translations"
        ? ["--translation-only"]
        : [];
  return {
    argv: [
      ...EXTRACT_ARGV_PREFIX,
      ...session,
      ...primary,
      `--output=${effectiveOutput}`,
      ...include,
      ...exclude,
      ...modeFlag,
    ],
    cwd: context.operationDirectory,
    timeoutMs: input.timeoutMs,
    effects: {
      reads: [...resolvedInputs],
      writes: [effectiveOutput, context.operationDirectory],
      network: extractEffects.network,
      codeExecution: extractEffects.codeExecution,
      unknownScope: extractEffects.unknownScope,
    },
  };
};

const extractParameterDescriptors = [
  {
    name: "inputs",
    type: "array",
    required: true,
    cardinality: "ordered",
    applicableCommands: ["extract"],
    pathRole: "input",
    hostPaths: projectInputs,
    sensitivity: "public",
    encoding:
      "ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline =",
    description:
      "Nonempty ordered input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly.",
    effects: ["reads each admitted input path"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §3.2",
        detail:
          "Inputs are ordered and resolved by the execution layer before shell-free launch.",
      },
    ],
  },
  {
    name: "output",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["extract"],
    pathRole: "output",
    hostPaths: projectOutput,
    sensitivity: "public",
    encoding:
      "literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion",
    description:
      "Optional exact extraction destination. Omission uses a unique extracted sibling directory beside same-parent primary inputs; different input parents require output.",
    effects: ["selects the exact accepted mutation destination without redirecting other side effects"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §3.3",
        detail:
          "Relative operation paths require an explicitly selected workspace; explicit output is honored exactly after absolute resolution.",
      },
    ],
  },
  {
    name: "include",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["extract"],
    pathRole: "none",
    sensitivity: "public",
    encoding: `ordered res://, root-relative, or relative logical glob patterns capped at ${String(MAX_EXTRACT_SELECTION_PATTERNS)} entries; * and ? wildcards and whole-segment ** only`,
    description:
      "Optional ordered include patterns. Filesystem-style matching: * and ? do not cross '/', and ** matches zero or more path segments. A bare *.ext pattern (a * with no separator and no **) matches the whole tree.",
    effects: ["selects a subset of package members without changing input identity"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §8.2 (selection and checksum evidence)",
        detail:
          "Selection uses verified runtime semantics; the expected selected set is derived from accepted selection semantics and the complete preflight member set, not from observed output.",
      },
    ],
  },
  {
    name: "exclude",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["extract"],
    pathRole: "none",
    sensitivity: "public",
    encoding: `ordered logical glob patterns capped at ${String(MAX_EXTRACT_SELECTION_PATTERNS)} entries; anchored regex semantics where * crosses '/'`,
    description:
      "Optional ordered exclude patterns applied to the include/all result. The fixed runtime matches excludes as an anchored regex where * crosses '/', so exclude matching is intentionally not the complement of include matching.",
    effects: ["removes selected package members without changing input identity"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §8.2 (selection and checksum evidence)",
        detail:
          "The include/exclude matcher asymmetry is a measured fixed-runtime behavior retained deliberately rather than normalized.",
      },
    ],
  },
  {
    name: "selection",
    type: "string",
    required: false,
    defaultValue: "all",
    cardinality: "scalar",
    applicableCommands: ["extract"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "one of all, scripts, translations; scripts emits --scripts-only and translations emits --translation-only",
    description:
      "Optional member selection mode. Defaults to all. scripts selects gd/gdc/gde and translations selects translation/xl by case-insensitive extension; a non-all mode cannot be combined with include or exclude.",
    effects: ["restricts extraction to a verified extension class without changing input identity"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §8.2 (selection and checksum evidence)",
        detail:
          "Extension-mode selection uses verified runtime semantics; an empty selected set is reported as no-match rather than inheriting the runtime's extract-everything fallback.",
      },
    ],
  },
  {
    name: "session",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["extract"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "ordered multithreading actions only; each emits a dedicated boolean token",
    description:
      "Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice.",
    effects: ["controls the extraction process without admitting generic settings, cache, or loader actions"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.3",
        detail:
          "Dedicated multithreading actions use --disable-multithreading=true|false in supplied order.",
      },
    ],
  },
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["extract"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description:
      "Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths.",
    effects: ["selects administrative operation roots; it is not an input path"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail:
          "Workspace selectors are absolute local paths and have no current-working-directory fallback.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["extract"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description:
      "Optional caller-selected cancellation budget. There is no implicit extraction timeout.",
    effects: ["requests cancellation of process work and necessary checks before terminal publication"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail:
          "Extraction has no implicit deadline; explicit policies span preflight, extraction, and necessary checks, not terminal publication.",
      },
    ],
  },
] as const;

export const extractCommand: ExtractCommandDescriptor = {
  id: "extract",
  toolName: "gdre_extract",
  category: "application",
  title: "GDRE extract",
  description:
    "Extract package contents to an exact accepted destination using ordered include/exclude patterns or all/scripts/translations selection with default checksum verification. Supplied-key and checksum-override fields remain deferred and rejected until their own slices are accepted.",
  cliSpellings: ["--extract"],
  aliases: [],
  routing: "application",
  argv: EXTRACT_ARGV_PREFIX,
  exactArgv: EXTRACT_ARGV_PREFIX,
  inputSchema: extractInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: extractParameterDescriptors,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  effects: extractEffects,
  evidence: extractEvidence,
  coverage: {
    fixtureIds: ["extract-tracer-v1", "extract-input-matrix-v1", "extract-selection-v1"],
    constraints: [
      "strict input object admits only inputs, output, ordered include/exclude patterns, all/scripts/translations selection, workspace, timeoutMs, and ordered multithreading session actions",
      "key and checksum are deferred planned options and are rejected rather than accepted and ignored",
      `include/exclude patterns are logical res://, root-relative, or relative forms using only * ? and whole-segment **, capped at ${String(MAX_EXTRACT_SELECTION_PATTERNS)} entries each; brackets, braces, drive/UNC prefixes, parser-significant edge quotes/whitespace, shell/environment expansion, and .. traversal are rejected`,
      "selection=scripts|translations cannot be combined with nonempty include or exclude patterns; extension matching is case-insensitive",
      "directory-source filters admit only bare-star patterns without a separator or **; unsupported filters retain an incomplete selected expectation rather than claiming a complete empty set",
      `inputs are nonempty ordered path/glob discriminated values capped at ${String(MAX_LIST_INPUTS)} groups, session is capped at ${String(MAX_SESSION_ACTIONS)} actions, and each input value is capped at ${String(MAX_INPUT_VALUE_BYTES)} UTF-8 bytes`,
      "output is a literal path without wildcards, parser-significant edge quotes, or shell/environment expansion; omission uses a unique input-adjacent sibling directory and requires same-parent primary inputs",
      "checksum verification remains the default and emits no key or checksum override flags; no universal PCK MD5 coverage is claimed",
      "argv is --headless --no-header -- followed by ordered session actions, repeated resolved --extract paths, --output=effectiveOutput, repeated --include/--exclude in caller order, then the optional --scripts-only/--translation-only mode flag",
      "expected selected members are derived from the complete res:// member set with filesystem-style includes and anchored-regex excludes; an empty selected set is a no-match classification rather than the runtime's extract-everything fallback",
      "an internal --list-files preflight retains the complete member set and is evaluated against the prepared input graph before any extraction write",
      "semantic success requires corroborated extractor loads, exact expected member paths, exact regular-file/ancestor-directory inventory, present hashes, natural exit 0, honest default checksum verification/skip evidence, and an anchored extraction completion marker",
      "destinations must be absent or empty; per-invocation path checks and pre-launch revalidation reject input/output overlap, metadata recursion, unsafe Windows members, and runtime-log collisions; conflicting file use between calls is caller responsibility, not a shared-target reservation guarantee",
      "complete inventory includes the administrative gdre_export.log with a separate role; response projections contain at most 32 entries and failed/cancelled operations retain available partial output",
      "accepted non-encrypted fixtures cover PCK formats 0–4, stored ZIP, assets-only APK, XAPK, marked directories, controlled single-pack .app layouts, and executable sidecar selection",
      "embedded executables, IPA, valid empty packs, multi-pack .app layouts, overlay precedence, supplied keys, uncertain/reparse subtrees, UNC/case-sensitive paths, and cross-process coordination remain gated",
    ],
    prerequisites: [
      "fixed local Windows runtime and command-specific fixture evidence; extraction does not imply imported-resource recovery or safe execution of extracted material",
    ],
  },
  validate: validateExtract,
  plan: planExtract,
  evaluate: evaluateExtract,
};

export const exportEffects = {
  reads: [
    "the admitted package/project input paths, protected translation-hint files, and the fixed native preflight inspector",
  ],
  writes: [
    "the accepted export destination, retained export-preflight evidence, adapter expectations and detail reports, and operation logs, manifest, and artifact inventory",
  ],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

const exportEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: "docs/operation-contract.md §2.2, §3.1, and §8.2",
    detail:
      "The export operation emits the shared application prefix, ordered session actions, repeated absolute --recover inputs, an explicit --output destination, typed selection flags, optional protected hints, and internal JSON report writing.",
  },
  {
    status: "S",
    source: "native/gdre-export-preflight.gd and src/export-operation.ts",
    detail:
      "A fixed native inspector loads the admitted inputs with existing native getters and retains complete logical member/import metadata before any recovery; selection, expectations and report interpretation remain operation-local.",
  },
  {
    status: "R+",
    source: "test/export-stdio.test.ts — selected editable-resource export acceptance",
    detail:
      "The production MCP/stdio tool exported exact authored translation CSV and decompiled script content from controlled packages and project directories, with explicit/group selection, no-match protection, protected hints/string controls, complete/partial/unsupported/failed outcomes, original preservation and bounded samples backed by complete reports.",
  },
];

const validateExportResources = (
  input: unknown,
): ValidationResult<ExportResourcesInput> => {
  const parsed = exportResourcesInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_export_resources requires a nonempty ordered path/glob input array and an explicit member or scripts/translations group selection; it accepts only output, session, translationHints, collectResourceStrings, dumpResourceStrings, workspace, and timeoutMs, and rejects key and checksum overrides.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planExportResources = (
  input: ExportResourcesInput,
  context: PlanningContext,
): InvocationPlan => {
  const resolvedInputs = context.resolvedInputs;
  if (resolvedInputs === undefined || resolvedInputs.length === 0) {
    throw new Error("resolved export inputs are required before planning");
  }
  const effectiveOutput = context.effectiveOutput;
  if (effectiveOutput === undefined || effectiveOutput.length === 0) {
    throw new Error("effective export output is required before planning");
  }
  const requestedHints = (input.translationHints ?? []).length > 0;
  if (requestedHints && context.resolvedHints === undefined) {
    throw new Error(
      "resolved export hint paths are required before planning a hinted export",
    );
  }
  return buildExportRecoveryPlan({
    input,
    resolvedInputs,
    hintPaths: context.resolvedHints ?? [],
    effectiveOutput,
    session: input.session ?? [],
    operationDirectory: context.operationDirectory,
  });
};

const evaluateExportResources = async (
  observation: ProcessObservation,
): Promise<EvaluationResult<ExportSemanticData>> =>
  (await evaluateExport({ observation })).evaluation;

const exportParameterDescriptors = [
  {
    name: "inputs",
    type: "array",
    required: true,
    cardinality: "ordered",
    applicableCommands: ["export-resources"],
    pathRole: "input",
    hostPaths: projectInputs,
    sensitivity: "public",
    encoding:
      "ordered discriminated path/glob values; literals may contain spaces, Unicode, and inline =",
    description:
      "Nonempty ordered package/project input groups. Literal paths and adapter-expanded glob patterns are distinguished explicitly.",
    effects: ["reads each admitted input as an export primary"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §3.2",
        detail:
          "Inputs are ordered and resolved by the execution layer before shell-free launch.",
      },
    ],
  },
  {
    name: "output",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "output",
    hostPaths: projectOutput,
    sensitivity: "public",
    encoding:
      "literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion",
    description:
      "Optional exact export destination. Omission uses a unique exported sibling directory beside same-parent primary inputs; hints do not choose the parent. Different input parents require output.",
    effects: [
      "selects the exact accepted mutation destination without redirecting administrative evidence",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §3.3",
        detail:
          "Relative operation paths require an explicitly selected workspace; explicit output is honored exactly after absolute resolution and must be absent or empty.",
      },
    ],
  },
  {
    name: "selection",
    type: "object",
    required: true,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "none",
    sensitivity: "public",
    encoding:
      "discriminated object: {kind:members, include: nonempty ordered logical globs, exclude?: ordered globs} or {kind:group, group: scripts|translations}",
    description:
      "Required explicit member-pattern or native group selection. There is no all/default mode and no excludes-only form, so omitted, invalid, empty, or no-match selections never request full recovery.",
    effects: [
      "selects package/project members with native include/exclude or group semantics without changing input identity",
    ],
    evidence: [
      {
        status: "S",
        source: "src/export-planning.ts and test/export-planning.test.ts",
        detail:
          "Selection is derived from the complete native preflight member set; an empty result is an explicit no-match rejection before any recovery launch.",
      },
    ],
  },
  {
    name: "session",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["export-resources"],
    pathRole: "none",
    sensitivity: "public",
    encoding:
      "ordered multithreading actions only; each emits a dedicated boolean token",
    description:
      "Optional ordered session controls. Only the fixture-verified multithreading action is admitted in this slice.",
    effects: [
      "controls the export process without admitting generic settings, cache, or loader actions",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.3",
        detail:
          "Dedicated multithreading actions use --disable-multithreading=true|false in supplied order.",
      },
    ],
  },
  {
    name: "translationHints",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["export-resources"],
    pathRole: "input",
    hostPaths: projectTranslationHints,
    sensitivity: "public",
    encoding:
      "ordered literal host-file paths without wildcards; resolved and fingerprinted separately from recovery primaries",
    description:
      "Optional literal host files loaded as protected translation-key hints. They are separate fingerprinted inputs, never recovery primaries, and are revalidated before launch.",
    effects: [
      "supplies native --translation-hint files without changing the admitted primary input graph",
    ],
    evidence: [
      {
        status: "S",
        source: "src/export-planning.ts and test/export-planning.test.ts",
        detail:
          "Hints must be regular files, are fingerprinted with the primary graph for overlap protection, and are revalidated before each owned launch.",
      },
    ],
  },
  {
    name: "collectResourceStrings",
    type: "boolean",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "none",
    sensitivity: "public",
    encoding:
      "boolean; omitted means true, and only an explicit false emits the native skip flag",
    description:
      "Collect project resource strings for translation-key recovery. The typed default preserves the native collect path rather than silently skipping string collection.",
    effects: [
      "controls native resource-string collection during translation recovery",
    ],
    evidence: [
      {
        status: "S",
        source: "src/export-planning.ts and test/export-planning.test.ts",
        detail:
          "An explicit false emits --skip-loading-resource-strings; omission leaves native collection enabled.",
      },
    ],
  },
  {
    name: "dumpResourceStrings",
    type: "boolean",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "boolean; omitted means false, and true emits the native dump flag",
    description:
      "Write the native resource-string dump during translation key recovery. The emitted dump is classified as administrative evidence.",
    effects: [
      "requests an additional native resource-string dump under the accepted destination",
    ],
    evidence: [
      {
        status: "S",
        source: "src/export-planning.ts and test/export-planning.test.ts",
        detail:
          "An explicit true emits --dump-resource-strings and predicts the .assets resource-string dump as administrative output.",
      },
    ],
  },
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description:
      "Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths.",
    effects: ["selects administrative operation roots; it is not an input path"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail:
          "Workspace selectors are absolute local paths and have no current-working-directory fallback.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["export-resources"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description:
      "Optional caller-selected cancellation budget. There is no implicit export timeout.",
    effects: [
      "requests cancellation of process work and necessary checks before terminal publication",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail:
          "Export has no implicit deadline; an explicit policy spans preflight, recovery, and necessary checks, not terminal publication.",
      },
    ],
  },
] as const;

export const exportResourcesCommand: ExportResourcesCommandDescriptor = {
  id: "export-resources",
  toolName: "gdre_export_resources",
  category: "application",
  title: "GDRE export resources",
  description:
    "Export an explicitly selected package/project member set or native scripts/translations group to an exact accepted destination as editable resources, with complete/partial/unsupported/failed completeness, retained native evidence and bounded diagnostics. This is not complete project recovery, raw extraction, inverse import, or a security sandbox.",
  cliSpellings: ["--recover"],
  aliases: [],
  routing: "application",
  argv: EXPORT_ARGV_PREFIX,
  exactArgv: EXPORT_ARGV_PREFIX,
  inputSchema: exportResourcesInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: exportParameterDescriptors,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  effects: exportEffects,
  evidence: exportEvidence,
  coverage: {
    fixtureIds: ["export-preflight-v1", "export-selection-v1", "export-stdio-v1"],
    constraints: [
      "selection is required and discriminated: nonempty ordered include patterns or a scripts/translations native group; there is no all/default or excludes-only mode, and empty or no-match selections fail before recovery",
      "inputs are nonempty ordered path/glob values; output is a literal path and an omitted output is operation-owned and explicitly supplied",
      "translationHints are separate protected regular-file inputs, not recovery primaries; collectResourceStrings defaults true and dumpResourceStrings defaults false",
      "key and checksum overrides are rejected and encrypted export is not claimed",
      "argv is --headless --no-header -- followed by ordered session actions, repeated resolved --recover paths, --output=effectiveOutput, selection flags, repeated --translation-hint paths, string controls, and --setting=write_json_report=true",
      "a fixed native preflight retains complete logical member/import metadata and derived expectations; unsafe metadata, directory-filter limits and administrative collisions are rejected before mutation",
      "semantic success requires a complete native report, a verified regular hashed native log and editable artifacts under the accepted destination, and no contradictory failures or missing keys; raw copies and scaffolding are not editable exports",
      "complete, partial, unsupported, failed and unknown requested-export completeness is reported with bounded diagnostics and references to complete native/adapter evidence",
      "destinations must be absent or empty; input/hint/destination overlap is rejected before launch; conflicting file use between calls remains caller responsibility, not a shared-target reservation guarantee",
    ],
    prerequisites: [
      "fixed local Windows GDRE runtime, the adapter-owned native inspector, and production MCP/stdio acceptance with authored translation/script content",
      "controlled authored fixtures with independently known content; no sample-game or third-party assets required",
    ],
  },
  validate: validateExportResources,
  plan: planExportResources,
  evaluate: evaluateExportResources,
};

export const patchTranslationsEffects = {
  reads: [
    "the admitted package/project input paths, resolved original translation CSV files, and the fixed native translation-patch script",
  ],
  writes: [
    "the accepted translation output destination, operation-local prepared CSV copies/request/report/detail evidence, and operation logs, manifest, and artifact inventory",
  ],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

const patchTranslationsEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: "docs/operation-contract.md §2.2, §2.3, and §8.2",
    detail:
      "The standalone translation identity admits literal package inputs, exact ordered CSV-to-original-resource mappings, optional output, explicit locales, a 64-hex key, multithreading session, workspace, and opt-in timeout. Omission keeps the native new-locales-only meaning.",
  },
  {
    status: "S",
    source: "src/schemas.ts and src/translation-planning.ts",
    detail:
      "Admission rejects glob inputs, non-res:// or unsafe logical targets, raw repeated CSV spellings, case-folded duplicate targets, duplicate locales, and recovery controls before planning. The planner emits one fixed trusted native script launch and refuses missing or contradictory resolved context.",
  },
  {
    status: "R+",
    source: "test/patch-translations-stdio.test.ts and test/support/translation-fixtures.ts",
    detail:
      "Production MCP/stdio with an encrypted format-2/engine-4.4 PCK verified the correct key patches and reads exact requested text, while a wrong key fails with actionable native load diagnostics. The key never appears in the request, report, manifest, preparation/detail evidence or ordinary results.",
  },
  {
    status: "R+",
    source: "test/patch-translations-stdio.test.ts and test/support/translation-fixtures.ts",
    detail:
      "Production MCP/stdio on controlled optimized-translation fixtures verified explicit/omitted locale semantics, retained default content, empty replacement text, pre-mutation all-mapping rejection, profile-local side effects, complete inventory/hash evidence, binary project config and report-derived alternate-suffix artifact roles.",
  },
];

const validatePatchTranslations = (
  input: unknown,
): ValidationResult<PatchTranslationsInput> => {
  const parsed = patchTranslationsInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_patch_translations requires nonempty literal package/project inputs and nonempty ordered CSV-to-exact-res://-original-resource mappings; it accepts only optional output, explicit unique locales, a 64-hex key, multithreading session, workspace, and timeoutMs, and rejects globs, recovery controls, checksum overrides, and unknown fields.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planPatchTranslations = (
  input: PatchTranslationsInput,
  context: PlanningContext,
): InvocationPlan => {
  const resolvedInputs = context.resolvedInputs;
  if (resolvedInputs === undefined || resolvedInputs.length === 0) {
    throw new Error(
      "resolved package/project inputs are required before patch planning",
    );
  }
  if (context.resolvedTranslations === undefined) {
    throw new Error(
      "resolved translation mappings are required before patch planning",
    );
  }
  const effectiveOutput = context.effectiveOutput;
  if (effectiveOutput === undefined || effectiveOutput.length === 0) {
    throw new Error(
      "effective translation output is required before patch planning",
    );
  }
  if (context.patchTranslationsScriptPath === undefined) {
    throw new Error(
      "fixed patch translations script path is required before patch planning",
    );
  }
  return buildPatchTranslationsPlan({
    input,
    resolvedInputs,
    resolvedTranslations: context.resolvedTranslations,
    effectiveOutput,
    operationDirectory: context.operationDirectory,
    patchTranslationsScriptPath: context.patchTranslationsScriptPath,
  });
};

/**
 * A descriptor-only evaluator never treats a bare process observation as
 * translation write-back evidence. Shared Execution calls the per-call
 * operation, which interprets the fixed native report against the inventory.
 */
const evaluatePatchTranslations = (
  _observation: ProcessObservation,
): EvaluationResult<PatchTranslationsSemanticData> => ({
  status: "unknown",
  rule: PATCH_TRANSLATIONS_RULE,
  summary:
    "A bare process observation is not standalone translation-patch evidence; the per-call operation must evaluate the fixed native report against the retained inventory.",
  evidence: [
    "Process exit status is report delivery only and is never translation write-back success.",
    "Per-call report and inventory evaluation is owned by the operation module through shared Execution.",
  ],
  data: null,
});

const patchTranslationsParameterDescriptors = [
  {
    name: "inputs",
    type: "array",
    required: true,
    cardinality: "ordered",
    applicableCommands: ["patch-translations"],
    pathRole: "input",
    hostPaths: projectInputs,
    sensitivity: "public",
    encoding:
      "ordered discriminated {kind:path,path} values only; literals may contain spaces, Unicode, and inline =; glob forms are not admitted",
    description:
      "Nonempty ordered literal package/project inputs loaded as one composed project graph. No glob expansion is admitted until separately verified for this operation.",
    effects: ["reads each admitted package/project input"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §3.2",
        detail:
          "Literal inputs resolve to absolute host paths before planning; wildcard spellings are not expanded for this operation.",
      },
    ],
  },
  {
    name: "translations",
    type: "array",
    required: true,
    cardinality: "ordered",
    applicableCommands: ["patch-translations"],
    pathRole: "input",
    hostPaths: projectTranslationCsvs,
    sensitivity: "public",
    encoding:
      "ordered {csv: protected host path, resource: exact res:// logical import source} objects; no normalization, globs, or host resource filenames",
    description:
      "Nonempty ordered edited-CSV to original translation-resource mappings. Externally ambiguous repeated CSV spellings and case-folded duplicate logical targets are rejected before planning.",
    effects: [
      "reads each edited CSV and targets its exact logical imported translation source without guessing a mapping",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §8.2",
        detail:
          "The native standalone route maps each host CSV to an exact case-sensitive logical ImportInfo.source_file and the CLI map grammar cannot represent ambiguity safely.",
      },
    ],
  },
  {
    name: "output",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["patch-translations"],
    pathRole: "output",
    hostPaths: projectOutput,
    sensitivity: "public",
    encoding:
      "literal absolute host path, or relative path with an explicitly selected workspace; no wildcards, parser-significant edge quotes, or shell/environment expansion",
    description:
      "Optional exact translation destination. Omission uses a unique translations sibling directory beside same-parent package/project inputs, not the CSV; different input parents require output.",
    effects: [
      "selects the accepted mutation destination without redirecting administrative evidence",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §3.3",
        detail:
          "Explicit output is honored exactly after absolute resolution and must not overwrite inputs or collide with translation inputs.",
      },
    ],
  },
  {
    name: "locales",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["patch-translations"],
    pathRole: "none",
    sensitivity: "public",
    encoding:
      "ordered nonempty exact locale identifiers without whitespace, commas, or duplicates",
    description:
      "Optional exact locale columns to patch. Omission preserves the native new-locales-only behavior; there is no invented all-locales expansion. Explicit locales must exist as CSV columns at the content gate.",
    effects: [
      "selects exact requested locale content without changing the mapping or input identity",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §8.2",
        detail:
          "Explicit locales select exact CSV columns, while omission selects only columns representing new locales rather than every existing locale.",
      },
    ],
  },
  {
    name: "key",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["patch-translations"],
    pathRole: "none",
    sensitivity: "secret",
    encoding:
      "exactly 64 hexadecimal characters; normalized lowercase, redacted by execution, and never stored in the request or report",
    description:
      "Optional 64-hex key for the command-specific encrypted standalone route. Presence does not widen encryption support to other commands.",
    effects: [
      "supplies the application key as a redactable argv token without storing it in evidence JSON",
    ],
    evidence: [
      {
        status: "R+",
        source: "test/patch-translations-stdio.test.ts and test/support/translation-fixtures.ts",
        detail:
          "Production MCP/stdio verified correct-key patching and wrong-key load failure with ordinary-result, manifest, request, report and preparation/detail redaction.",
      },
      {
        status: "S",
        source: "docs/operation-contract.md §2.3 and §4.3",
        detail:
          "The key keeps a fixed hexadecimal shape; manifests, results, and previews must redact it rather than hash it.",
      },
    ],
  },
  {
    name: "session",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["patch-translations"],
    pathRole: "none",
    sensitivity: "public",
    encoding:
      "ordered multithreading actions only; each applies the reserved native boolean setting through the prepared request, not a free argv field",
    description:
      "Optional ordered session controls. Only the fixture-verified multithreading action is admitted; the fixed script applies it through the safe native setting and the manifest preserves the ordered actions.",
    effects: [
      "controls the translation-patch process without admitting generic settings, cache, or loader actions",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.3",
        detail:
          "Other CLI-based tools emit dedicated --disable-multithreading=true|false tokens; the standalone composition applies the equivalent reserved native setting in the supplied order.",
      },
    ],
  },
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["patch-translations"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description:
      "Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths.",
    effects: ["selects administrative operation roots; it is not an input path"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail:
          "Workspace selectors are absolute local paths and have no current-working-directory fallback.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["patch-translations"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description:
      "Optional caller-selected cancellation budget. There is no implicit translation-patch timeout.",
    effects: [
      "requests cancellation of process work and necessary checks before terminal publication",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail:
          "The operation has no implicit deadline; an explicit timeout uses the shared cancellation and owned-process stop path.",
      },
    ],
  },
] as const;

export const patchTranslationsCommand: PatchTranslationsCommandDescriptor = {
  id: "patch-translations",
  toolName: "gdre_patch_translations",
  category: "application",
  title: "GDRE patch translations",
  description:
    "Patch standalone translations through one fixed trusted native script: map edited host CSVs to exact logical import sources, honor explicit locales or native new-locales-only omission, and report verified text/resource evidence. Production MCP/stdio evidence covers retained content, report-backed failures, binary project config, alternate safe resource suffixes and operation-local profile isolation.",
  cliSpellings: ["--script"],
  aliases: [],
  routing: "application",
  argv: PATCH_TRANSLATIONS_ARGV_PREFIX,
  exactArgv: PATCH_TRANSLATIONS_ARGV_PREFIX,
  inputSchema: patchTranslationsInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: patchTranslationsParameterDescriptors,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  effects: patchTranslationsEffects,
  evidence: patchTranslationsEvidence,
  coverage: {
    fixtureIds: ["translation-standalone-v1", "translation-encrypted-stdio-v1"],
    constraints: [
      "strict input object admits only nonempty literal path inputs, nonempty ordered translations, optional output, explicit unique locales, a 64-hex key, multithreading session, workspace, and timeoutMs; globs, hints, string controls, checksum, and unknown fields are rejected",
      "inputs are literal {kind:path,path} values only; wildcard/glob forms are not admitted before command-specific verification",
      `translations are capped at ${String(MAX_TRANSLATION_MAPPINGS)} ordered mappings; resources must be exact forward-slash res:// logical import sources with nonempty segments and no .., drive, wildcard, control, or edge-whitespace characters`,
      "raw repeated CSV spellings and case-folded duplicate logical targets are rejected; preparation also rejects canonical CSV aliases and malformed CSV content",
      `locales are capped at ${String(MAX_TRANSLATION_LOCALES)} nonempty identifiers without whitespace, commas, or duplicates; omission keeps native new-locales-only semantics and never expands to all locales`,
      "key is exactly 64 hexadecimal characters, normalized lowercase, redacted through invocation/records, and never written into request or report JSON",
      "argv is one fixed trusted launch: --headless --script FIXED -- REQUEST_JSON REPORT_JSON [--key=HEX]; ordered session actions are applied by the script rather than emitted as caller-controlled flags",
      "the planner requires resolved absolute package inputs, one resolved CSV/resource pair per admitted mapping, an effective absolute output, and the adapter-owned fixed script path; it fails rather than inventing defaults",
      "the host writes an operation-local key-free request, strips only an initial UTF-8 BOM into prepared copies, preserves original/package bytes and revalidates CSVs, prepared copies and the destination before launch",
      "success requires a complete strictly shaped native report that corresponds to the request, verified in-destination output hashes/inventory and no contradictory native diagnostics; exit 0 is report delivery only",
      "missing/malformed/contradictory/ok:false reports are classified before any output inventory; only a valid success-shaped report reaches the existing inventory/hash checks, and structured native failures project only native-acquired evidence",
      "explicit locales produce exactly the requested output locales; omission derives only new locales, fails when there is no new target, and never expands to all locales; empty replacement text is valid for a confirmed source key",
      "artifact roles use the native report's actual output identities, so safe destinations such as .godot/imported/*.res remain translation outputs rather than suffix-guessed accompanying files",
      "operation-local destination absence/collision checks apply, and prior export-operation output CSVs remain usable while the current operation administrative tree is rejected",
    ],
    prerequisites: [
      "tracked controlled optimized-translation fixtures, the fixed local Windows GDRE runtime and the adapter-owned native patch script provide production MCP/stdio evidence; no game assets are required",
      "encrypted format-2/engine-4.4 PCK evidence covers command-specific key support only; no encryption support is inferred for other commands",
    ],
  },
  validate: validatePatchTranslations,
  plan: planPatchTranslations,
  evaluate: evaluatePatchTranslations,
};

export const pckPatchEffects = {
  reads: [
    "ordinary-only execution reads the admitted source package, resolved replacement host files, fixed native package inspector, and output package for verification; combined execution additionally reads the original and operation-owned prepared translation CSVs plus the fixed combined preparation/verification scripts",
  ],
  writes: [
    "the accepted effective output package and native temporary sibling, operation-local source/output inspection and adapter verification reports, profiles, logs, manifest, and artifact inventory",
    "combined execution additionally writes an operation-owned BOM-stripped prepared CSV, fixed preparation/verification request and report files, and native-generated resources/config under the operation profile's .tmp_translations directory; temporary resources remain unverified loose files rather than verified package artifacts",
  ],
  network: false,
  codeExecution: false,
  unknownScope: false,
} as const;

const GDSDECOMP_PCK_PATCH_SOURCE =
  "https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1793-L1848";

const pckPatchEvidence: readonly EvidenceReference[] = [
  {
    status: "S",
    source: GDSDECOMP_PCK_PATCH_SOURCE,
    detail:
      "The pinned native patch path loads the source, replaces admitted logical members, retains non-target members, and constructs the output package; mapping components cannot contain =, and source/output option values are not split as mappings.",
  },
  {
    status: "R+",
    source: "docs/operation-contract.md §8.2 — controlled native CLI replacement fixture",
    detail:
      "One native create and one patch against the fixed runtime verified an unencrypted standalone format-2/engine-4.4 package: the target payload was replaced, non-target members were retained, and source/replacement inputs were unchanged. It does not establish adapter preparation or general format support.",
  },
  {
    status: "R+",
    source: "test/pck-patch-native.test.ts and test/pck-patch-runtime-stdio.test.ts",
    detail:
      "Authored unencrypted format-2/engine-4.4.0 packages and an independent reader verify exact replacement/retained bytes, inherited headers and preserved inputs through native transactions and real-runtime production MCP/stdio. Controlled host/stdio faults separately cover contradictory reports, partial files and owned stop; no encrypted or target-game support is inferred.",
  },
  {
    status: "R+",
    source:
      "test/pck-patch-combined-native.test.ts, test/pck-patch-combined-execution.test.ts and test/pck-patch-combined-runtime-stdio.test.ts",
    detail:
      "Authored unencrypted format-2/engine-4.4.0 fixtures verify translation-only, mixed binary replacements and permitted new locales through fixed native preparation, direct patching and output getters, including text/binary project configuration, retained newer/non-target content, unchanged inputs and operation-local profiles. Real production stdio covers repeated calls and live owned cancellation with an independent successful survivor; it does not establish mid-serialization interruption, arbitrary-format compatibility or game loading.",
  },
  {
    status: "S",
    source: "src/pck-patch-operation.ts and native/gdre-pck-inspect.gd",
    detail:
      "Fixed read-only payload inspections surround the direct native patch command. Host preparation protects input/output identities; complete reports, exact content comparisons and normal-success inventory establish success, while failure and stopped evidence remain distinct from verified output.",
  },
  {
    status: "S",
    source: "src/schemas.ts and src/pck-patch-planning.ts",
    detail:
      "Admission rejects empty mapping families, unsupported fields, unsafe logical members, repeated raw host sources and case-folded collisions among visible admitted logical identities within or across ordinary/translation families. Native-resolved generated destinations and project-config collisions remain preparation checks. Planning requires resolved absolute source/patches/CSVs and an explicit effective output, preserving order and exact identities without filesystem certification.",
  },
  {
    status: "S",
    source:
      "https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1344-L1375",
    detail:
      "The pinned native source patches project configuration inside the mapping loop and accumulates an import map, making repeated mappings unsafe. Admission therefore accepts exactly one mapping instead of serializing or dropping extras, and ordinary-only cardinality is unchanged. This source evidence is not product combined-execution acceptance.",
  },
  {
    status: "S",
    source:
      "https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/exporters/translation_exporter.cpp#L2733-L2737",
    detail:
      "Generated destination identities depend on native loaded/default resources and optional project configuration. Admission preserves exact explicit/new-locales-only semantics but does not derive or guess destinations; combined preparation owns that derivation and conflict rejection.",
  },
];

const validatePckPatch = (input: unknown): ValidationResult<PckPatchInput> => {
  const parsed = pckPatchInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message:
        "gdre_pck_patch requires one literal source package and at least one mapping family: ordered host-file-to-exact-res://-member replacements and/or one typed CSV-to-exact-logical-import-source translation mapping. It accepts optional exact locales only with a translation mapping, output, multithreading session, workspace, and timeoutMs; it rejects globs, filters, keys, caller scripts, embedding, and unknown fields.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    },
  };
};

const planPckPatch = (
  input: PckPatchInput,
  context: PlanningContext,
): InvocationPlan => {
  const resolvedPckSource = context.resolvedPckSource;
  if (resolvedPckSource === undefined || resolvedPckSource.length === 0) {
    throw new Error("resolved package source is required before pck-patch planning");
  }
  if (context.resolvedPatches === undefined) {
    throw new Error(
      "resolved package patch mappings are required before pck-patch planning",
    );
  }
  const effectiveOutput = context.effectiveOutput;
  if (effectiveOutput === undefined || effectiveOutput.length === 0) {
    throw new Error(
      "effective pck-patch output is required before planning",
    );
  }
  return buildPckPatchPlan({
    input,
    resolvedPckSource,
    resolvedPatches: context.resolvedPatches,
    resolvedPckTranslations: context.resolvedPckTranslations,
    preparedPckTranslations: context.preparedPckTranslations,
    effectiveOutput,
    operationDirectory: context.operationDirectory,
  });
};

/**
 * A descriptor-only evaluator never treats a bare process observation as
 * package-patch content evidence. The operation module owns preparation,
 * native inspection and content verification.
 */
const evaluatePckPatch = (
  _observation: ProcessObservation,
): EvaluationResult<PckPatchSemanticData> => ({
  status: "unknown",
  rule: PCK_PATCH_RULE,
  summary:
    "A bare process observation is not package-patch evidence; the per-call operation must evaluate prepared source/output inspection against replacement content.",
  evidence: [
    "Process exit status is not package-patch content success.",
    "Admission and planning do not read, write or certify package contents.",
  ],
  data: null,
});

const pckPatchParameterDescriptors = [
  {
    name: "source",
    type: "string",
    required: true,
    cardinality: "scalar",
    applicableCommands: ["pck-patch"],
    pathRole: "input",
    hostPaths: projectPackageSource,
    sensitivity: "public",
    encoding:
      "one literal host file path; may contain spaces, Unicode, and inline =; bounded to 2048 UTF-8 bytes and parser-lossless",
    description:
      "One source package file to rewrite. It is not a glob, input array, or extraction-style selection.",
    effects: [
      "reads the admitted source package without certifying its type, format, encryption, or member set",
    ],
    evidence: [
      {
        status: "S",
        source: "src/schemas.ts and src/pck-patch-planning.ts",
        detail:
          "The source is a single literal host option value, separate from ordered replacement mappings, and the native grammar does not split it as a mapping.",
      },
    ],
  },
  {
    name: "patches",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["pck-patch"],
    pathRole: "input",
    hostPaths: projectPackageHostSources,
    sensitivity: "public",
    encoding: `0-${String(MAX_PCK_PATCH_MAPPINGS)} ordered {hostSource, logicalMember} values; mapping components reject = and single/double quotes and are bounded to 2048 UTF-8 bytes`,
    description:
      "Ordered host-file-to-existing-logical-member replacement mappings. Omission normalizes to an empty array for translation-only requests. Host sources and logical destinations are distinct identities.",
    effects: [
      "reads each host source and pairs it with an exact canonical res:// member; existing-member and collision checks belong to host preparation",
    ],
    evidence: [
      {
        status: "S",
        source: GDSDECOMP_PCK_PATCH_SOURCE,
        detail:
          "The native map is keyed by host source and requires exactly two components per --patch-file token; adapter admission rejects repeated raw sources and case-folded destination collisions.",
      },
    ],
  },
  {
    name: "translations",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["pck-patch"],
    pathRole: "input",
    hostPaths: projectTranslationCsvs,
    sensitivity: "public",
    encoding:
      "omitted or exactly one ordered {csv, resource} value; an explicit empty translations array is rejected; CSV and logical components reject = and single/double quotes and are bounded to 2048 UTF-8 bytes",
    description:
      "Optional typed CSV-to-exact-logical-import-source translation mapping for a combined package patch. Omission keeps ordinary-only behavior; ordinary patches may also be empty. Combined execution stages an operation-owned BOM-stripped CSV, derives native destinations before mutation, and verifies output content through native getters. Standalone translation cardinality and map grammar are unchanged.",
    effects: [
      "reads and fingerprints the original host CSV paired with an exact logical import source, stages a distinct operation-owned initial-BOM-stripped copy for the native CLI, and derives actual native import/default-resource/generated destinations through fixed read-only preparation before mutation",
    ],
    evidence: [
      {
        status: "S",
        source:
          "https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/standalone/gdre_main.gd#L1344-L1375",
        detail:
          "The native combined route patches translations through the same package invocation; a second mapping contaminates project registration, so combined admission accepts exactly one mapping and rejects more.",
      },
    ],
  },
  {
    name: "locales",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["pck-patch"],
    pathRole: "none",
    sensitivity: "public",
    encoding: `1-${String(MAX_TRANSLATION_LOCALES)} exact safe locale identifiers; only with a translation mapping`,
    description:
      "Optional exact locale identifiers for the admitted translation mapping. Omitted locales select only new CSV locales, never all locales. Duplicate or malformed identifiers are rejected rather than expanded or guessed.",
    effects: [
      "selects exactly the requested output locales when provided; omission delegates new-locales-only selection to execution preparation",
    ],
    evidence: [
      {
        status: "S",
        source:
          "https://github.com/GDRETools/gdsdecomp/blob/e2780fcc73ab14083967d3945e513d1f6af1dbd0/exporters/translation_exporter.cpp#L2733-L2737",
        detail:
          "Existing-locale destinations are loaded translation resources; new-locale destinations derive from the native default resource identity, so exact locale semantics are preserved and native-resolved destinations are deferred to preparation.",
      },
    ],
  },
  {
    name: "output",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["pck-patch"],
    pathRole: "output",
    hostPaths: projectOutput,
    sensitivity: "public",
    encoding:
      "literal host output file path; may contain spaces, Unicode, and inline =; bounded to 2048 UTF-8 bytes and parser-lossless",
    description:
      "Optional exact output PCK file. Omission uses a unique source-named patched .pck beside the source, with the operation ID, independently of replacement/CSV locations.",
    effects: [
      "declares the intended distinct output package; existence and source/output alias checks belong to host preparation",
    ],
    evidence: [
      {
        status: "S",
        source: GDSDECOMP_PCK_PATCH_SOURCE,
        detail:
          "Native code does not protect originals from output aliasing, so the product must choose and revalidate an explicit output before launch.",
      },
    ],
  },
  {
    name: "session",
    type: "array",
    required: false,
    cardinality: "ordered",
    applicableCommands: ["pck-patch"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "ordered multithreading actions only; each emits --disable-multithreading=true|false",
    description:
      "Optional ordered session controls. Only the accepted multithreading action is admitted.",
    effects: [
      "changes native threading behavior without changing admitted mapping identities",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §2.2 and §3.2",
        detail:
          "Application session actions are emitted in caller order as dedicated boolean tokens.",
      },
    ],
  },
  {
    name: "workspace",
    type: "string",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["pck-patch"],
    pathRole: "workspace",
    sensitivity: "public",
    encoding: "absolute local Windows drive path",
    description:
      "Optional absolute internal workspace and relative host-path base. Omission uses configured workspace or automatic Temp; automatic Temp requires absolute host paths.",
    effects: ["selects the operation workspace without changing admitted source/member identities"],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1",
        detail:
          "Execution resolves relative host paths against an explicitly selected workspace before launch; automatic Temp requires absolute host paths.",
      },
    ],
  },
  {
    name: "timeoutMs",
    type: "integer",
    required: false,
    cardinality: "scalar",
    applicableCommands: ["pck-patch"],
    pathRole: "none",
    sensitivity: "public",
    encoding: "positive safe integer milliseconds, bounded at 3600000",
    description:
      "Optional caller-selected cancellation budget. There is no implicit package-patch timeout.",
    effects: [
      "requests cancellation of process work and necessary checks before terminal publication",
    ],
    evidence: [
      {
        status: "S",
        source: "docs/operation-contract.md §3.1 and §7.2",
        detail:
          "The operation has no implicit deadline; an explicit timeout uses the shared cancellation and owned-process stop path.",
      },
    ],
  },
] as const;

export const pckPatchCommand: PckPatchCommandDescriptor = {
  id: "pck-patch",
  toolName: "gdre_pck_patch",
  category: "application",
  title: "GDRE patch package members",
  description:
    "Execute ordinary existing-member replacements in one standalone unencrypted PCK through the native CLI, fixed read-only inspections and exact replacement/retained content verification, writing a separate output package. Combined requests add one typed CSV-to-exact-logical-import-source translation mapping with exact locale controls, alone or with ordinary replacements: the adapter stages an operation-owned BOM-stripped CSV, derives native import/default-locale/generated destinations and project registration with a fixed read-only preparation script before mutation, then requires an independent native getter verification of the output. Omitted output uses a unique patched PCK beside the source for both ordinary and combined calls. Keys, filters, embedding, new ordinary members and caller scripts are unsupported; exit zero or output existence alone is not success.",
  cliSpellings: ["--pck-patch"],
  aliases: [],
  routing: "application",
  argv: PCK_PATCH_ARGV_PREFIX,
  exactArgv: PCK_PATCH_ARGV_PREFIX,
  inputSchema: pckPatchInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: pckPatchParameterDescriptors,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  effects: pckPatchEffects,
  evidence: pckPatchEvidence,
  coverage: {
    fixtureIds: [
      "pck-patch-route-v1",
      "pck-patch-native",
      "pck-patch-runtime-stdio",
      "pck-patch-combined-native",
      "pck-patch-combined-execution",
      "pck-patch-combined-runtime-stdio",
    ],
    constraints: [
      `strict input admits one literal source package, 0-${String(MAX_PCK_PATCH_MAPPINGS)} ordered ordinary replacements and/or exactly one typed translation mapping, optional exact locales only with translations, optional literal output, ordered multithreading session, workspace, and timeoutMs; at least one mapping family is required, and globs, filters, keys, caller scripts, embedding, and unknown fields are rejected`,
      "logical members are exact canonical res:// identities with nonempty non-dot forward-slash segments and no control, colon in the relative part, backslash, wildcard, equals, quote, edge whitespace, or parser-lossy characters",
      "repeated raw hostSource spellings and case-folded logicalMember collisions are rejected instead of selecting a dictionary winner",
      "hostSource and logicalMember mapping components reject = and any single or double quote under the documented CLI-map representability policy; source and output option values are not mapping components and keep their ordinary grammar, including inline =",
      "combined translation CSV and logical-resource components also reject = and quotes under the CLI mapping grammar, while standalone translation admission keeps its wider map grammar and cardinality unchanged",
      "combined admission accepts translation-only (normalized empty ordinary patches) and mixed requests without a dummy replacement, but rejects no mapping family, more than one translation mapping, empty translations, and locales without translations",
      "translation resources, ordinary logical members and exact locale identifiers reuse standalone safety and exactness; cross-family case-folded conflicts among visible admitted logical identities, malformed identities, and duplicate or invalid locales are rejected before planning; native-resolved generated and project-config destination conflicts remain preparation checks",
      "planning preserves admitted order and requires exactly matching resolved source/patches/translation CSVs and an explicit effective output; already-absolute admitted source, host, CSV and output spellings must agree lexically with resolved display spellings, while relative admitted values trust host workspace resolution; missing, relative, parser-lossy or contradictory resolved context fails before launch",
      "combined argv is --headless --no-header -- followed by ordered session actions, --pck-patch=SOURCE, --output=OUTPUT, ordered --patch-file=HOST=res://MEMBER tokens, --patch-translations=ABS_CSV=res://IMPORT when admitted, and --locales=EXACT,LIST only for explicit locales",
      "resolvedPckTranslations carries original host-resolved CSV provenance and absolute-identity comparison; optional preparedPckTranslations carries the distinct operation-owned BOM-stripped copy used for CLI argv and read effects, and neither is a generated translation destination; pure planning does not certify prepared-copy ownership, so combined execution must supply prepared copies rather than host originals; omitted locales preserve new-locales-only semantics with no all-locales expansion or guessed keys",
      "combined execution validates CSV UTF-8/content/locales, fingerprints the original and operation-owned BOM-stripped prepared copies, rejects CSV/source/ordinary/output/admin aliases, and launches one fixed read-only preparation script that derives actual native import/default-locale/generated destinations and optional text/binary project registration before any mutation; an unrepresentable, conflicted or unreadable identity fails closed without a patch launch",
      "ordinary-only host preparation verifies standalone unencrypted PCK type and exact existing targets, fingerprints replacement files, rejects resolved aliases/hardlinks and unsafe/existing output or tmp collisions, supplies a unique source-adjacent patched PCK when omitted, and revalidates identities before mutation",
      "planning alone does not establish file existence, package type, encryption, existing-member identity, canonical host aliases, output absence, or source/output/CSV collisions; those are host preparation checks",
      "ordinary success requires natural exit zero and exact patch marker without patch-error evidence, complete fixed source/output inspection, exact replacement/retained hashes and inherited metadata, unchanged inputs and accepted normal-success inventory; combined success additionally requires the permitted member-set/byte gate, unchanged source/replacement/original CSV/prepared CSV identities, and accepted independent native getter verification of every selected and retained locale plus project configuration presence or registration; reports remain operation-local and the verified PCK has output-package artifact role",
      "known failure, cancellation and deadline preserve acquired reports/streams and bounded available unverified-file observations without exhaustive post-stop audit; there is no implicit patch timeout or cross-call target reservation",
    ],
    prerequisites: [
      "the fixed local Windows GDRE runtime and the pinned native route source",
      "the fixed read-only native/gdre-pck-inspect.gd inspector and safe distinct output; controlled format-2/engine-4.4.0 fixture evidence does not establish arbitrary-format compatibility, encrypted patching, importing or game loading",
      "combined admission consumes the frozen combined CLI contract and pinned native source; combined execution uses the fixed read-only preparation/verification scripts and operation-local prepared CSV staging, and controlled runtime evidence does not establish arbitrary-format, encrypted, importing or game-loading behavior",
    ],
  },
  validate: validatePckPatch,
  plan: planPckPatch,
  evaluate: evaluatePckPatch,
};

export const versionCommand: VersionCommandDescriptor = {
  id: "version",
  toolName: "gdre_version",
  category: "runtime",
  title: "GDRE version",
  description:
    "Report the fixed GDRE Tools runtime version without loading a project or accepting arbitrary CLI arguments.",
  cliSpellings: ["--gdre-version", "--version"],
  aliases: ["--version"],
  routing: "injected",
  argv: VERSION_ARGV,
  exactArgv: VERSION_ARGV,
  inputSchema: versionInputSchema,
  outputSchema: operationResultSchema,
  parameterDescriptors: versionParameterDescriptors,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  effects: versionEffects,
  evidence: versionEvidence,
  coverage: {
    fixtureIds: ["version-line-v1"],
    constraints: [
      "strict input object rejects unknown keys",
      "workspace is an absolute local Windows drive path when supplied",
      "timeoutMs is a positive integer no greater than 3600000",
      "argv is exactly --headless followed by --gdre-version",
      "natural exit code 0 or 1 with one recognized version line is semantic success",
    ],
    prerequisites: ["fixed GDRE runtime executable and companion files"],
  },
  validate: validateVersion,
  plan: planVersion,
  evaluate: evaluateVersion,
};

export const commandRegistry: CommandRegistry = [
  versionCommand,
  listFilesCommand,
  extractCommand,
  exportResourcesCommand,
  patchTranslationsCommand,
  pckPatchCommand,
];

/** Compatibility alias for callers that name the source-of-truth registry directly. */
export const registry = commandRegistry;

export function getCommandById(id: string): CommandRegistry[number] | undefined {
  return commandRegistry.find((command) => command.id === id);
}

export function getCommandByToolName(
  toolName: string,
): CommandRegistry[number] | undefined {
  return commandRegistry.find((command) => command.toolName === toolName);
}

export function assertRegistryIntegrity(): void {
  if (commandRegistry.length !== 6) {
    throw new Error(
      "The registry must contain exactly the accepted version, list-files, extract, export-resources, patch-translations, and pck-patch commands.",
    );
  }

  const [
    version,
    listing,
    extraction,
    exportResources,
    patchTranslations,
    pckPatch,
  ] = commandRegistry;
  if (
    version === undefined ||
    version.id !== "version" ||
    version.toolName !== "gdre_version" ||
    version.routing !== "injected" ||
    version.argv.join("\u0000") !== VERSION_ARGV.join("\u0000") ||
    listing === undefined ||
    listing.id !== "list-files" ||
    listing.toolName !== "gdre_list_files" ||
    listing.routing !== "application" ||
    listing.argv.join("\u0000") !== LIST_FILES_ARGV_PREFIX.join("\u0000") ||
    extraction === undefined ||
    extraction.id !== "extract" ||
    extraction.toolName !== "gdre_extract" ||
    extraction.routing !== "application" ||
    extraction.argv.join("\u0000") !== EXTRACT_ARGV_PREFIX.join("\u0000") ||
    exportResources === undefined ||
    exportResources.id !== "export-resources" ||
    exportResources.toolName !== "gdre_export_resources" ||
    exportResources.routing !== "application" ||
    exportResources.argv.join("\u0000") !== EXPORT_ARGV_PREFIX.join("\u0000") ||
    patchTranslations === undefined ||
    patchTranslations.id !== "patch-translations" ||
    patchTranslations.toolName !== "gdre_patch_translations" ||
    patchTranslations.routing !== "application" ||
    patchTranslations.argv.join("\u0000") !==
      PATCH_TRANSLATIONS_ARGV_PREFIX.join("\u0000") ||
    pckPatch === undefined ||
    pckPatch.id !== "pck-patch" ||
    pckPatch.toolName !== "gdre_pck_patch" ||
    pckPatch.routing !== "application" ||
    pckPatch.argv.join("\u0000") !== PCK_PATCH_ARGV_PREFIX.join("\u0000")
  ) {
    throw new Error("The registry command identity or argv is inconsistent.");
  }
}

assertRegistryIntegrity();

export { VERSION_ARGV };
