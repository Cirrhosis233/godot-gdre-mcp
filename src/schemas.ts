import { z } from "zod";
import { validatePathSyntax } from "./paths.js";

/** Maximum caller-controlled cancellation budget. */
export const MAX_TIMEOUT_MS = 3_600_000;

const boundedText = z
  .string()
  .max(2_048)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 2_048, {
    message: "text must be at most 2048 UTF-8 bytes",
  });
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * The adapter accepts local Windows drive paths, not relative, UNC, device, or
 * drive-relative paths. Keeping this check in the wire schema prevents an
 * execution module from having to interpret an ambiguous workspace selector.
 */
export const isAbsoluteWorkspacePath = (value: string): boolean => {
  if (value.length === 0 || /[\0\r\n]/u.test(value)) {
    return false;
  }

  if (/^(?:\\\\|\\\.\\|\\\?\\)/u.test(value)) {
    return false;
  }

  return /^[A-Za-z]:[\\/]/u.test(value);
};

export const workspacePathSchema = z
  .string()
  .min(1)
  .refine(isAbsoluteWorkspacePath, {
    message: "workspace must be an absolute local Windows drive path",
  })
  .describe("Absolute local Windows internal workspace and relative host-path base when explicitly supplied.");

/** Strict input for the only command currently registered. */
export const versionInputSchema = z.strictObject({
  workspace: workspacePathSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
    .optional(),
});

export const MAX_INPUT_VALUE_BYTES = 2_048;
export const MAX_LIST_INPUTS = 256;
export const MAX_SESSION_ACTIONS = 64;
export const MAX_EXTRACT_SELECTION_PATTERNS = 256;
export const MAX_TRANSLATION_MAPPINGS = 256;
export const MAX_TRANSLATION_LOCALES = 256;
export const MAX_PCK_PATCH_MAPPINGS = 256;

const hasMatchingParserEdgeQuotePair = (value: string): boolean =>
  value.length >= 2 &&
  ((value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"')));

export const representableInputValue = z
  .string()
  .min(1)
  .max(MAX_INPUT_VALUE_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_VALUE_BYTES, {
    message: `input value must be at most ${MAX_INPUT_VALUE_BYTES} UTF-8 bytes`,
  })
  .refine(validatePathSyntax, {
    message: "input value must use a supported local path syntax",
  })
  .refine((value) => !/^\s|\s$/u.test(value), {
    message: "input value must not have leading or trailing whitespace",
  })
  .refine((value) => !hasMatchingParserEdgeQuotePair(value), {
    message: "input value must not use parser-significant edge quotes",
  })
  .refine((value) => !value.startsWith("~") && !/[%$][({A-Za-z_]/u.test(value), {
    message: "input value must not use shell or environment expansion",
  });

const literalInputSchema = z.strictObject({
  kind: z.literal("path"),
  path: representableInputValue.refine((value) => !/[?*]/u.test(value), {
    message: "literal paths must not contain wildcard characters; use kind=glob",
  }),
});

const globInputSchema = z.strictObject({
  kind: z.literal("glob"),
  pattern: representableInputValue
    .refine((value) => /[*?]/u.test(value), {
      message: "glob patterns must contain * or ?",
    })
    .refine((value) => !/[\[\]{}]/u.test(value), {
      message: "glob patterns support only * ? and ** wildcards",
    }),
});

export const listFilesInputItemSchema = z.discriminatedUnion("kind", [
  literalInputSchema,
  globInputSchema,
]);

export const listFilesSessionActionSchema = z.strictObject({
  kind: z.literal("multithreading"),
  disabled: z.boolean(),
});

/** Extraction destinations are literal paths; wildcard and expansion forms stay unsupported. */
export const extractionOutputPathSchema = representableInputValue
  .refine((value) => !/[?*]/u.test(value), {
    message: "output must be a literal path without wildcard characters",
  })
  .describe("Literal absolute extraction destination; relative values require an explicitly selected workspace.");

const hasSupportedGlobGrammar = (value: string): boolean =>
  value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => !segment.includes("**") || segment === "**");

const hasNoParentTraversal = (value: string): boolean =>
  value
    .replaceAll("\\", "/")
    .split("/")
    .every((segment) => segment !== "..");

/**
 * Admitted logical roots only: `res://`, a single leading `/` (root-relative),
 * or a relative pattern. Other URI schemes (`user://`, `other://`), Windows
 * drive spellings (`C:/`, `C:relative`), UNC (`//` or `\\`), and stray `:`
 * outside the `res://` prefix are rejected.
 */
const hasAdmittedLogicalRoot = (value: string): boolean => {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("//")) return false;
  if (normalized.startsWith("res://")) return !normalized.slice("res://".length).includes(":");
  if (/^[A-Za-z]:/u.test(normalized)) return false;
  return !normalized.includes(":");
};

/**
 * Include/exclude patterns are logical GDRE globs: `res://`-rooted, root-relative,
 * or relative, with `*`/`?` wildcards and whole-segment `**` recursion. Brackets,
 * braces, parser-significant edge quotes/whitespace, shell/environment expansion,
 * drive/UNC prefixes, and `..` traversal are rejected before any argv is built.
 */
export const extractionSelectionPatternSchema = z
  .string()
  .min(1)
  .max(MAX_INPUT_VALUE_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_VALUE_BYTES, {
    message: `selection patterns must be at most ${MAX_INPUT_VALUE_BYTES} UTF-8 bytes`,
  })
  .refine((value) => !/[\0\r\n]/u.test(value), {
    message: "selection patterns must not contain control characters",
  })
  .refine((value) => !/^\s|\s$/u.test(value), {
    message: "selection patterns must not have leading or trailing whitespace",
  })
  .refine((value) => !hasMatchingParserEdgeQuotePair(value), {
    message: "selection patterns must not use parser-significant edge quotes",
  })
  .refine((value) => !value.startsWith("~") && !/[%$][({A-Za-z_]/u.test(value), {
    message: "selection patterns must not use shell or environment expansion",
  })
  .refine((value) => !/[\[\]{}]/u.test(value), {
    message: "selection patterns support only * ? and whole-segment ** wildcards",
  })
  .refine(hasSupportedGlobGrammar, {
    message: "selection patterns support only * ? and whole-segment ** wildcards",
  })
  .refine(hasNoParentTraversal, {
    message: "selection patterns must not traverse parent segments",
  })
  .refine(hasAdmittedLogicalRoot, {
    message: "selection patterns must be res://, root-relative, or relative logical patterns",
  })
  .describe("Ordered GDRE include/exclude glob pattern.");

const extractionSelectionModeSchema = z
  .enum(["all", "scripts", "translations"])
  .describe("Member selection mode: all members (default), scripts only, or translations only.");

export const extractInputSchema = z.strictObject({
  inputs: z.array(listFilesInputItemSchema).min(1).max(MAX_LIST_INPUTS),
  output: extractionOutputPathSchema.optional(),
  include: z
    .array(extractionSelectionPatternSchema)
    .max(MAX_EXTRACT_SELECTION_PATTERNS)
    .optional(),
  exclude: z
    .array(extractionSelectionPatternSchema)
    .max(MAX_EXTRACT_SELECTION_PATTERNS)
    .optional(),
  selection: extractionSelectionModeSchema.optional(),
  session: z.array(listFilesSessionActionSchema).max(MAX_SESSION_ACTIONS).optional(),
  workspace: workspacePathSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
    .optional(),
}).superRefine((value, context) => {
  const hasFilters = (value.include?.length ?? 0) > 0 || (value.exclude?.length ?? 0) > 0;
  if ((value.selection ?? "all") !== "all" && hasFilters) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message:
        "selection=scripts or selection=translations cannot be combined with include or exclude patterns",
    });
  }
});

/** Export destinations are literal paths; wildcard and expansion forms stay unsupported. */
const exportOutputPathSchema = extractionOutputPathSchema.describe(
  "Literal absolute export destination; relative values require an explicitly selected workspace.",
);

const literalHostPathSchema = representableInputValue.refine(
  (value) => !/[?*]/u.test(value),
  { message: "literal host paths must not contain wildcard characters" },
);

const exportMemberSelectionSchema = z.strictObject({
  kind: z.literal("members"),
  include: z
    .array(extractionSelectionPatternSchema)
    .min(1)
    .max(MAX_EXTRACT_SELECTION_PATTERNS)
    .describe("Nonempty ordered logical member include patterns."),
  exclude: z
    .array(extractionSelectionPatternSchema)
    .max(MAX_EXTRACT_SELECTION_PATTERNS)
    .optional()
    .describe("Optional ordered logical member exclude patterns."),
});

const exportGroupSelectionSchema = z.strictObject({
  kind: z.literal("group"),
  group: z
    .enum(["scripts", "translations"])
    .describe("Native resource group: scripts or translations."),
});

/**
 * Export selection is explicit and discriminated. There is no all/default
 * member mode and no excludes-only form, so an omitted, invalid, or empty
 * selection can never be interpreted as a full recovery request.
 */
export const exportResourcesSelectionSchema = z.discriminatedUnion("kind", [
  exportMemberSelectionSchema,
  exportGroupSelectionSchema,
]);

export const exportResourcesInputSchema = z.strictObject({
  inputs: z.array(listFilesInputItemSchema).min(1).max(MAX_LIST_INPUTS),
  output: exportOutputPathSchema.optional(),
  selection: exportResourcesSelectionSchema,
  session: z.array(listFilesSessionActionSchema).max(MAX_SESSION_ACTIONS).optional(),
  translationHints: z
    .array(literalHostPathSchema)
    .max(MAX_LIST_INPUTS)
    .optional()
    .describe(
      "Optional literal host files loaded as protected translation-key hints; not recovery primary inputs.",
    ),
  collectResourceStrings: z
    .boolean()
    .optional()
    .describe("Collect project resource strings for translation-key recovery; default true."),
  dumpResourceStrings: z
    .boolean()
    .optional()
    .describe("Write the native resource-string dump during translation key recovery; default false."),
  workspace: workspacePathSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
    .optional(),
});

/**
 * A translation target is an exact logical import source, not a host path or a
 * pattern. Reject anything that would require normalization or host-style
 * interpretation before a native mapping is planned.
 */
export const isSafeTranslationResourceSource = (value: string): boolean => {
  if (!value.startsWith("res://")) return false;
  const relative = value.slice("res://".length);
  if (relative.length === 0) return false;
  if (/[\\\u0000-\u001F\u007F]/u.test(value) || relative.includes(":")) return false;
  if (/^\s|\s$/u.test(value)) return false;
  if (hasMatchingParserEdgeQuotePair(value)) return false;
  if (/[?*\[\]{}]/u.test(value)) return false;
  return relative
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

export const patchTranslationResourceSchema = z
  .string()
  .min("res://x".length)
  .max(MAX_INPUT_VALUE_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_VALUE_BYTES, {
    message: `logical resources must be at most ${MAX_INPUT_VALUE_BYTES} UTF-8 bytes`,
  })
  .refine(isSafeTranslationResourceSource, {
    message:
      "resource must be an exact res:// logical import source using forward slashes, nonempty non-dot segments, no .., drive, wildcard, control, or edge-whitespace characters",
  })
  .describe("Exact logical import source, not a host resource file.");

export const SAFE_TRANSLATION_LOCALE_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$/u;

export const isSafeTranslationLocale = (value: string): boolean =>
  SAFE_TRANSLATION_LOCALE_PATTERN.test(value);

const patchTranslationLocaleSchema = z
  .string()
  .min(1)
  .max(MAX_INPUT_VALUE_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_VALUE_BYTES, {
    message: `locale identifiers must be at most ${MAX_INPUT_VALUE_BYTES} UTF-8 bytes`,
  })
  .refine(isSafeTranslationLocale, {
    message:
      "locale identifiers must start with an ASCII letter and contain only ASCII letters, digits, and single _ or - separators",
  })
  .describe("Safe exact native locale identifier.");

const patchTranslationsOutputPathSchema = extractionOutputPathSchema.describe(
  "Literal absolute translation-patch destination; relative values require an explicitly selected workspace.",
);

export const patchTranslationMappingSchema = z.strictObject({
  csv: literalHostPathSchema.describe(
    "Edited translation CSV host file; relative values require and resolve against an explicitly selected workspace.",
  ),
  resource: patchTranslationResourceSchema,
});

/**
 * Standalone translation patching admits only literal package/project inputs and
 * exact ordered CSV-to-original-resource mappings. Ambiguous native map grammar
 * (repeated CSV spellings, case-folded duplicate logical targets) is rejected
 * before planning; real path aliases and CSV content semantics are later gates.
 */
export const patchTranslationsInputSchema = z
  .strictObject({
    inputs: z.array(literalInputSchema).min(1).max(MAX_LIST_INPUTS),
    translations: z
      .array(patchTranslationMappingSchema)
      .min(1)
      .max(MAX_TRANSLATION_MAPPINGS),
    output: patchTranslationsOutputPathSchema.optional(),
    locales: z
      .array(patchTranslationLocaleSchema)
      .min(1)
      .max(MAX_TRANSLATION_LOCALES)
      .optional(),
    key: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/u, "key must be exactly 64 hexadecimal characters")
      .transform((value) => value.toLowerCase())
      .optional(),
    session: z.array(listFilesSessionActionSchema).max(MAX_SESSION_ACTIONS).optional(),
    workspace: workspacePathSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
      .optional(),
  })
  .superRefine((value, context) => {
    const csvSpellings = new Set<string>();
    const logicalTargets = new Set<string>();
    for (const [index, mapping] of value.translations.entries()) {
      if (csvSpellings.has(mapping.csv)) {
        context.addIssue({
          code: "custom",
          path: ["translations", index, "csv"],
          message:
            "translations must not repeat an exact CSV spelling; resolve intended aliases explicitly",
        });
      }
      csvSpellings.add(mapping.csv);
      const logicalTarget = mapping.resource.toLowerCase();
      if (logicalTargets.has(logicalTarget)) {
        context.addIssue({
          code: "custom",
          path: ["translations", index, "resource"],
          message:
            "translations must not repeat a logical resource target under case folding",
        });
      }
      logicalTargets.add(logicalTarget);
    }
    if (value.locales !== undefined) {
      const seen = new Set<string>();
      for (const [index, locale] of value.locales.entries()) {
        if (seen.has(locale)) {
          context.addIssue({
            code: "custom",
            path: ["locales", index],
            message: "locales must not contain duplicate identifiers",
          });
        }
        seen.add(locale);
      }
    }
  });

const pckPatchHostSourceSchema = literalHostPathSchema
  .refine((value) => !value.includes("="), {
    message:
      "host sources must not contain =; the native --patch-file mapping grammar cannot represent it",
  })
  .refine((value) => !/['"]/u.test(value), {
    message:
      "host sources must not contain single or double quotes under the documented CLI-map representability policy",
  })
  .describe("Literal host file whose bytes replace the logical member.");

const pckPatchLogicalMemberSchema = patchTranslationResourceSchema
  .refine((value) => !value.includes("="), {
    message:
      "logical members must not contain =; the native --patch-file mapping grammar cannot represent it",
  })
  .refine((value) => !/['"]/u.test(value), {
    message:
      "logical members must not contain single or double quotes under the documented CLI-map representability policy",
  })
  .describe("Exact existing logical package member replaced by the host source.");

const pckPatchOutputPathSchema = extractionOutputPathSchema.describe(
  "Literal absolute package-patch output file; relative values require an explicitly selected workspace.",
);

const rejectCliMappingComponent = (value: string): boolean =>
  !value.includes("=") && !/['"]/u.test(value);

/**
 * Combined translation mappings use the direct native CLI map grammar, which
 * requires exactly one `=` separator and cannot represent quotes. The standalone
 * translation schema keeps its wider map grammar; only this combined shape is
 * narrowed.
 */
export const pckPatchTranslationMappingSchema = z.strictObject({
  csv: literalHostPathSchema
    .refine(rejectCliMappingComponent, {
      message:
        "combined translation CSV sources cannot contain = or quotes under the documented CLI-map representability policy",
    })
    .describe(
      "Edited translation CSV host file; relative values require and resolve against an explicitly selected workspace.",
    ),
  resource: patchTranslationResourceSchema
    .refine(rejectCliMappingComponent, {
      message:
        "combined translation logical resources cannot contain = or quotes under the documented CLI-map representability policy",
    })
    .describe("Exact logical import source, not a host resource file."),
});

export const pckPatchMappingSchema = z.strictObject({
  hostSource: pckPatchHostSourceSchema,
  logicalMember: pckPatchLogicalMemberSchema,
});

/**
 * Package-patch admission is one literal source package plus at least one map
 * family: nonempty ordered ordinary host-file-to-logical-member replacements
 * and/or exactly one typed CSV-to-logical-import-source translation mapping.
 * Ambiguous native map grammar (repeated raw host sources, case-folded
 * destination collisions within or across families) is rejected before
 * planning; file existence, aliases, existing-member identity, native-resolved
 * generated destinations and project-config registration are later preparation
 * checks, not schema claims.
 */
export const pckPatchInputSchema = z
  .strictObject({
    source: literalHostPathSchema.describe(
      "One literal host source package file; not a glob or input list.",
    ),
    patches: z
      .array(pckPatchMappingSchema)
      .max(MAX_PCK_PATCH_MAPPINGS)
      .default([])
      .describe(
        "Ordered host-file-to-existing-logical-member replacement mappings; empty for translation-only requests.",
      ),
    translations: z
      .array(pckPatchTranslationMappingSchema)
      .min(1)
      .max(1)
      .optional()
      .describe(
        "At most one typed CSV-to-exact-logical-import-source translation mapping; standalone cardinality is unchanged.",
      ),
    locales: z
      .array(patchTranslationLocaleSchema)
      .min(1)
      .max(MAX_TRANSLATION_LOCALES)
      .optional()
      .describe(
        "Optional exact locale identifiers; valid only with a translation mapping. Omission selects new locales only.",
      ),
    output: pckPatchOutputPathSchema.optional(),
    session: z.array(listFilesSessionActionSchema).max(MAX_SESSION_ACTIONS).optional(),
    workspace: workspacePathSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
      .optional(),
  })
  .superRefine((value, context) => {
    const rawSources = new Set<string>();
    const logicalTargets = new Set<string>();
    for (const [index, mapping] of value.patches.entries()) {
      if (rawSources.has(mapping.hostSource)) {
        context.addIssue({
          code: "custom",
          path: ["patches", index, "hostSource"],
          message:
            "patches must not repeat an exact hostSource spelling; the native map is keyed by host source and would lose an entry",
        });
      }
      rawSources.add(mapping.hostSource);
      const logicalTarget = mapping.logicalMember.toLowerCase();
      if (logicalTargets.has(logicalTarget)) {
        context.addIssue({
          code: "custom",
          path: ["patches", index, "logicalMember"],
          message:
            "patches must not repeat a logical member target under case folding",
        });
      }
      logicalTargets.add(logicalTarget);
    }
    if (value.patches.length === 0 && value.translations === undefined) {
      context.addIssue({
        code: "custom",
        path: ["patches"],
        message:
          "pck-patch requires at least one ordinary replacement or one translation mapping",
      });
    }
    if (value.locales !== undefined && value.translations === undefined) {
      context.addIssue({
        code: "custom",
        path: ["locales"],
        message: "locales require an admitted translation mapping",
      });
    }
    for (const [index, mapping] of (value.translations ?? []).entries()) {
      const logicalTarget = mapping.resource.toLowerCase();
      if (logicalTargets.has(logicalTarget)) {
        context.addIssue({
          code: "custom",
          path: ["translations", index, "resource"],
          message:
            "translations must not repeat an ordinary logical member target under case folding",
        });
      }
      logicalTargets.add(logicalTarget);
    }
    if (value.locales !== undefined) {
      const seen = new Set<string>();
      for (const [index, locale] of value.locales.entries()) {
        if (seen.has(locale)) {
          context.addIssue({
            code: "custom",
            path: ["locales", index],
            message: "locales must not contain duplicate identifiers",
          });
        }
        seen.add(locale);
      }
    }
  });

export const listFilesInputSchema = z.strictObject({
  inputs: z.array(listFilesInputItemSchema).min(1).max(MAX_LIST_INPUTS),
  key: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u, "key must be exactly 64 hexadecimal characters")
    .transform((value) => value.toLowerCase())
    .optional(),
  session: z.array(listFilesSessionActionSchema).max(MAX_SESSION_ACTIONS).optional(),
  workspace: workspacePathSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .describe(`Optional cancellation budget in milliseconds, at most ${MAX_TIMEOUT_MS}; no implicit operation timeout.`)
    .optional(),
});

export const versionSemanticDataSchema = z.strictObject({
  version: z.string().min(1).max(256).describe("Version reported by GDRE."),
});

const boundedSemanticName = z
  .string()
  .min(1)
  .max(MAX_INPUT_VALUE_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_INPUT_VALUE_BYTES, {
    message: `file names must be at most ${MAX_INPUT_VALUE_BYTES} UTF-8 bytes`,
  });

/** Extraction data is a minimal bounded summary; member truth comes from later evaluator evidence. */
export const extractChecksumCoverageSchema = z.strictObject({
  scope: z
    .enum(["all-members", "not-applicable"])
    .describe("Whether the default checksum pass covered every preflight member or was source-backed inapplicable."),
  verifiedFiles: nonNegativeInteger.nullable(),
  skippedFiles: nonNegativeInteger.nullable(),
});

export const extractSemanticDataSchema = z.strictObject({
  totalFiles: nonNegativeInteger.describe("Complete preflight member count."),
  selectedFiles: nonNegativeInteger.describe("Selected member count derived from accepted selection semantics."),
  extractedFiles: nonNegativeInteger.describe("Observed extracted member count."),
  outputPath: boundedText
    .min(1)
    .describe("Accepted effective extraction destination."),
  checksum: z
    .literal("default")
    .describe("Default checksum verification policy; no override was requested."),
  checksumCoverage: extractChecksumCoverageSchema,
});

export const exportCompletenessSchema = z.enum([
  "complete",
  "partial",
  "unsupported",
  "failed",
  "unknown",
]);

/**
 * Export data is a bounded summary. Complete member/import expectations and the
 * adapter detail report live in operation-local evidence referenced here.
 */
export const exportSemanticDataSchema = z.strictObject({
  completeness: exportCompletenessSchema.describe("Requested-export completeness, not process exit status."),
  outputPath: boundedText.min(1).describe("Accepted effective export destination."),
  selection: z.strictObject({
    kind: z.enum(["members", "group"]),
    group: z.enum(["scripts", "translations"]).nullable(),
  }),
  counts: z.strictObject({
    completeMembers: nonNegativeInteger.describe("Complete native preflight member count."),
    selectedMembers: nonNegativeInteger.describe("Derived selected member count."),
    nativeImports: nonNegativeInteger.describe("Selected reportable import count; one import may cover many members."),
    exportSuccess: nonNegativeInteger.describe("Selected imports with a native success entry."),
    exportFailed: nonNegativeInteger.describe("Selected imports with a native failure entry."),
    exportUnsupported: nonNegativeInteger.describe("Selected imports reported as not converted."),
    unverifiedSuccess: nonNegativeInteger.describe("Native successes without verified editable artifact evidence."),
    unaccountedImports: nonNegativeInteger.describe("Selected imports with no trustworthy report entry."),
    unmappedMembers: nonNegativeInteger.describe("Selected members with no reportable import destination."),
    missingKeys: nonNegativeInteger.nullable().describe("Known missing translation keys; null when unavailable."),
    totalKeys: nonNegativeInteger.nullable().describe("Known translation key total; null when unavailable."),
  }),
  artifactRoles: z.strictObject({
    editableExports: nonNegativeInteger.describe("Verified editable artifacts under the accepted output."),
    unverifiedExports: nonNegativeInteger.describe("Success entries without verified primary artifact evidence."),
    rawOrUnmappedMembers: nonNegativeInteger.describe("Selected members without an exporter entry."),
    accompanying: nonNegativeInteger.describe("Project metadata and recovery scaffolding under the output."),
    administrative: nonNegativeInteger.describe("Administrative logs, reports, and requested dumps."),
  }),
  reports: z.strictObject({
    native: boundedText.min(1).nullable(),
    nativeLog: boundedText.min(1).nullable(),
    adapter: boundedText.min(1).nullable(),
  }),
  sideEffects: z.array(boundedText).max(16),
  diagnostics: z.array(boundedText).max(16),
  previews: z.strictObject({
    editableExports: z.array(boundedText).max(8),
    failed: z.array(boundedText).max(8),
    unsupported: z.array(boundedText).max(8),
  }),
});

/** Listing data is a bounded sample plus a reference to complete stdout evidence. */
export const listFilesSemanticDataSchema = z.strictObject({
  totalFiles: nonNegativeInteger,
  files: z.array(boundedSemanticName).max(32),
  truncated: z.boolean(),
  stdoutPath: boundedText,
});

export const patchTranslationsCompletenessSchema = z.enum([
  "complete",
  "partial",
  "failed",
  "unknown",
]);

/**
 * Standalone translation-patch data is a bounded summary. The fixed native
 * report, request record, prepared CSV copies and complete mapping evidence stay
 * operation-local and are referenced here rather than embedded.
 */
export const patchTranslationsSemanticDataSchema = z.strictObject({
  completeness: patchTranslationsCompletenessSchema.describe(
    "Standalone translation-patch completeness, not process exit status.",
  ),
  outputPath: boundedText
    .min(1)
    .describe("Accepted effective translation output destination."),
  localeSelection: z.strictObject({
    mode: z
      .enum(["explicit", "new-locales-only"])
      .describe("Explicit locale columns or native new-locales-only omission."),
    locales: z.array(boundedSemanticName).max(MAX_TRANSLATION_LOCALES),
  }),
  counts: z.strictObject({
    mappings: nonNegativeInteger.describe("Admitted CSV-to-original-resource mappings."),
    outputs: nonNegativeInteger.describe("Observed generated translation outputs."),
    verifiedResources: nonNegativeInteger.describe(
      "Generated resources with verified requested content.",
    ),
    verifiedTexts: nonNegativeInteger.describe(
      "Individually verified key/text expectations.",
    ),
    unverifiedFiles: nonNegativeInteger.describe(
      "Native-reported written files not verified or inventory-audited; may include accompanying project configuration.",
    ),
    preparedCsvs: nonNegativeInteger.describe(
      "Operation-owned prepared CSV copies.",
    ),
  }),
  reports: z.strictObject({
    request: boundedText.min(1).nullable(),
    native: boundedText.min(1).nullable(),
  }),
  preparedCsvs: z.strictObject({
    items: z
      .array(
        z.strictObject({
          original: boundedText.min(1),
          prepared: boundedText.min(1),
          bomNormalized: z.boolean(),
        }),
      )
      .max(8),
    truncated: z.boolean(),
  }),
  samples: z.strictObject({
    mappings: z.array(boundedText).max(8),
    outputs: z.array(boundedText).max(8),
    unverifiedFiles: z.array(boundedText).max(8),
    truncated: z.boolean(),
  }),
  diagnostics: z.array(boundedText).max(16),
});

export const pckPatchCompletenessSchema = z.enum([
  "complete",
  "partial",
  "failed",
  "unknown",
]);

/**
 * Package-patch data is a bounded summary of adapter-verified package content.
 * Complete inspection/verification evidence stays operation-local and is
 * referenced here rather than embedded. Combined calls add a separately bounded
 * translation preparation and getter-verification summary.
 */
export const pckPatchSemanticDataSchema = z.strictObject({
  completeness: pckPatchCompletenessSchema.describe(
    "Package-patch completeness, not process exit status.",
  ),
  outputPath: boundedText
    .min(1)
    .describe("Accepted effective output package file."),
  counts: z.strictObject({
    mappings: nonNegativeInteger.describe("Admitted replacement mappings."),
    verifiedReplacements: nonNegativeInteger.describe(
      "Logical members verified as replaced by the intended host payload.",
    ),
    verifiedRetainedMembers: nonNegativeInteger.describe(
      "Non-target logical members verified as retained with their original payload.",
    ),
    unverifiedFiles: nonNegativeInteger.describe(
      "Available package or temporary files not verified by content evidence.",
    ),
  }),
  reports: z.strictObject({
    sourceInspection: boundedText.min(1).nullable(),
    outputInspection: boundedText.min(1).nullable(),
    verification: boundedText.min(1).nullable(),
  }),
  samples: z.strictObject({
    replacements: z.array(boundedText).max(8),
    retainedMembers: z.array(boundedText).max(8),
    unverifiedFiles: z.array(boundedText).max(8),
    truncated: z.boolean(),
  }),
  translations: z
    .strictObject({
      localeSelection: z.strictObject({
        mode: z.enum(["explicit", "new-locales-only"]),
        locales: z.array(boundedText).max(MAX_TRANSLATION_LOCALES),
      }),
      counts: z.strictObject({
        mappings: nonNegativeInteger,
        outputs: nonNegativeInteger,
        verifiedResources: nonNegativeInteger,
        verifiedTexts: nonNegativeInteger,
        retainedLocales: nonNegativeInteger,
        permittedAdditions: nonNegativeInteger,
      }),
      preparedCsvs: z.strictObject({
        items: z
          .array(
            z.strictObject({
              original: boundedText.min(1),
              prepared: boundedText.min(1),
              bomNormalized: z.boolean(),
            }),
          )
          .max(8),
        truncated: z.boolean(),
      }),
      reports: z.strictObject({
        preparation: boundedText.min(1).nullable(),
        verification: boundedText.min(1).nullable(),
      }),
      samples: z.strictObject({
        outputs: z.array(boundedText).max(8),
        permittedAdditions: z.array(boundedText).max(8),
        retainedLocales: z.array(boundedText).max(8),
        truncated: z.boolean(),
      }),
      diagnostics: z.array(boundedText).max(16),
    })
    .optional()
    .describe(
      "Combined translation preparation and getter-verification summary; present only for combined calls.",
    ),
  diagnostics: z.array(boundedText).max(16),
});

export const phaseSchema = z.enum([
  "validating",
  "queued",
  "preparing",
  "running",
  "finalizing",
]);

export const errorCodeSchema = z.enum([
  "validation_failed",
  "unsupported_capability",
  "runtime_unavailable",
  "spawn_failed",
  "process_failed",
  "semantic_failed",
  "semantic_unknown",
  "destination_conflict",
  "path_unsupported",
  "queue_timeout",
  "execution_timeout",
  "cancelled",
  "disconnected",
  "shutdown",
  "storage_failed",
  "cleanup_failed",
  "interrupted",
]);

export const operationStatusSchema = z.enum([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export const semanticStatusSchema = z.enum([
  "succeeded",
  "failed",
  "unknown",
  "not_evaluated",
]);

export const runtimeHealthSchema = z.enum(["ready", "unavailable"]);
export const runtimeComparisonSchema = z.enum([
  "match",
  "mismatch",
  "unavailable",
]);

export const streamSummarySchema = z.strictObject({
  bytes: nonNegativeInteger.describe("Raw byte count."),
  text: z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") <= 8_192, {
      message: "text must be at most 8192 UTF-8 bytes",
    })
    .describe("Bounded UTF-8 display preview."),
  truncated: z.boolean(),
  utf8Valid: z.boolean(),
  rawPath: z.string().min(1).nullable(),
  textPath: z.string().min(1).nullable(),
  complete: z.boolean(),
});

export const artifactSummarySchema = z.strictObject({
  path: z.string().min(1),
  role: z.string().min(1).max(256),
  bytes: nonNegativeInteger.nullable(),
  sha256: z.string().min(1).nullable(),
});

const processProbeSchema = z.strictObject({
  exitCode: nonNegativeInteger.nullable(),
  signal: z.string().min(1).nullable(),
  stdout: streamSummarySchema,
  stderr: streamSummarySchema,
  error: boundedText.nullable(),
});

export const runtimeStateSchema = z.strictObject({
  health: runtimeHealthSchema,
  registryVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  actualVersion: z.string().min(1).nullable(),
  comparison: runtimeComparisonSchema,
  executable: z.string().min(1),
  companions: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        present: z.boolean(),
        sha256: z.string().min(1).nullable(),
      }),
    )
    .length(3),
  exeSha256: z.string().min(1).nullable(),
  baselineHashesMatch: z.boolean().nullable(),
  checkedAt: z.string().min(1),
  evidencePath: z.string().min(1).nullable(),
  probe: processProbeSchema,
  warnings: z.array(boundedText).max(32),
});

export const operationErrorSchema = z.strictObject({
  code: errorCodeSchema,
  stage: phaseSchema,
  message: boundedText,
});

export const timingSchema = z.strictObject({
  requestedAt: z.string().min(1),
  queuedAt: z.string().min(1).nullable(),
  startedAt: z.string().min(1).nullable(),
  processExitedAt: z.string().min(1).nullable(),
  finishedAt: z.string().min(1),
  queueMs: nonNegativeInteger,
  processMs: nonNegativeInteger.nullable(),
  totalMs: nonNegativeInteger,
});

export const processEvidenceSchema = z.strictObject({
  pid: positiveInteger.nullable(),
  exitCode: nonNegativeInteger.nullable(),
  signal: z.string().min(1).nullable(),
  spawnError: z
    .strictObject({
      code: z.string().min(1).max(256),
      message: boundedText,
    })
    .nullable(),
});

export const semanticResultSchema = z.strictObject({
  status: semanticStatusSchema,
  rule: z.string().min(1).max(256),
  summary: boundedText,
  evidence: z.array(boundedText).max(32),
  data: z
    .union([
      versionSemanticDataSchema,
      listFilesSemanticDataSchema,
      extractSemanticDataSchema,
      exportSemanticDataSchema,
      patchTranslationsSemanticDataSchema,
      pckPatchSemanticDataSchema,
    ])
    .nullable(),
});

export const pathsSchema = z.strictObject({
  workspace: z.string().min(1).nullable(),
  operation: z.string().min(1).nullable(),
  output: z.string().min(1).nullable(),
  effectiveDestination: z.string().min(1).nullable(),
  manifest: z.string().min(1).nullable(),
  artifactInventory: z.string().min(1).nullable(),
});

export const artifactsSchema = z.strictObject({
  count: nonNegativeInteger,
  items: z.array(artifactSummarySchema).max(32),
  truncated: z.boolean(),
  complete: z.boolean(),
});

export const cleanupSchema = z.strictObject({
  state: z.enum(["not_needed", "confirmed", "unconfirmed"]),
  trigger: z
    .enum(["cancel", "timeout", "disconnect", "shutdown", "storage"])
    .nullable(),
  actions: z.array(boundedText).max(32),
  error: boundedText.nullable(),
});

export const persistenceSchema = z.strictObject({
  state: z.enum(["complete", "unavailable", "incomplete"]),
  error: boundedText.nullable(),
});

/** Shared normalized result envelope with a registry-defined semantic data union. */
export const operationResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    commandId: z.enum([
      "version",
      "list-files",
      "extract",
      "export-resources",
      "patch-translations",
      "pck-patch",
    ]),
    success: z.boolean(),
    status: operationStatusSchema,
    error: operationErrorSchema.nullable(),
    runtime: runtimeStateSchema,
    timing: timingSchema,
    process: processEvidenceSchema,
    semantic: semanticResultSchema,
    paths: pathsSchema,
    stdout: streamSummarySchema,
    stderr: streamSummarySchema,
    artifacts: artifactsSchema,
    cleanup: cleanupSchema,
    persistence: persistenceSchema,
    warnings: z.array(boundedText).max(32),
  })
  .superRefine((value, context) => {
    const data = value.semantic.data;
    if (data === null) return;
    const matchesCommand =
      value.commandId === "version"
        ? "version" in data
        : value.commandId === "list-files"
          ? "files" in data
          : value.commandId === "extract"
            ? "extractedFiles" in data
            : value.commandId === "export-resources"
              ? "completeness" in data && "selection" in data
              : value.commandId === "patch-translations"
                ? "completeness" in data &&
                  "localeSelection" in data &&
                  "preparedCsvs" in data
                : value.commandId === "pck-patch"
                  ? "completeness" in data &&
                    "samples" in data &&
                    "replacements" in data.samples
                  : false;
    if (!matchesCommand) {
      context.addIssue({
        code: "custom",
        path: ["semantic", "data"],
        message: "semantic data does not match commandId",
      });
    }
  });

// Descriptive aliases make the schema's role at the MCP seam explicit.
export const resultEnvelopeSchema = operationResultSchema;
export const versionOutputSchema = operationResultSchema;

export type VersionInput = z.infer<typeof versionInputSchema>;
export type ListFilesInput = z.infer<typeof listFilesInputSchema>;
export type ListFilesInputItem = z.infer<typeof listFilesInputItemSchema>;
export type ListFilesSessionAction = z.infer<typeof listFilesSessionActionSchema>;
export type ExtractInput = z.infer<typeof extractInputSchema>;
export type ExportResourcesInput = z.infer<typeof exportResourcesInputSchema>;
export type ExportResourcesSelection = z.infer<typeof exportResourcesSelectionSchema>;
export type ExportCompleteness = z.infer<typeof exportCompletenessSchema>;
export type ExportSemanticData = z.infer<typeof exportSemanticDataSchema>;
export type PatchTranslationsInput = z.infer<typeof patchTranslationsInputSchema>;
export type PatchTranslationMapping = z.infer<typeof patchTranslationMappingSchema>;
export type PatchTranslationsCompleteness = z.infer<
  typeof patchTranslationsCompletenessSchema
>;
export type PatchTranslationsSemanticData = z.infer<
  typeof patchTranslationsSemanticDataSchema
>;
export type PckPatchInput = z.infer<typeof pckPatchInputSchema>;
export type PckPatchMapping = z.infer<typeof pckPatchMappingSchema>;
export type PckPatchCompleteness = z.infer<typeof pckPatchCompletenessSchema>;
export type PckPatchSemanticData = z.infer<typeof pckPatchSemanticDataSchema>;
export type VersionSemanticData = z.infer<typeof versionSemanticDataSchema>;
export type ListFilesSemanticData = z.infer<typeof listFilesSemanticDataSchema>;
export type ExtractSemanticData = z.infer<typeof extractSemanticDataSchema>;
export type OperationResultOutput = z.infer<typeof operationResultSchema>;
