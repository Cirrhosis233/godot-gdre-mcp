import { isSupportedAbsolutePath, pathIdentity } from "./paths.js";
import { isSafeTranslationLocale } from "./schemas.js";
import type {
  InvocationPlan,
  PckPatchInput,
  PckPatchMapping,
  PckPatchTranslationMapping,
} from "./types.js";

/**
 * Package-patch contract and planning. The accepted route is the fixed runtime's
 * existing `--pck-patch` CLI with caller-owned host files and one selected
 * absolute output path (explicit or proposed by command preparation), not a
 * bridge or a new codec. This module owns only execution-neutral argv and
 * effect planning; host preparation, native execution and content verification
 * belong to the operation-local integration slice.
 */

export const PCK_PATCH_RULE = "gdre-pck-patch-v1";

export const PCK_PATCH_ARGV_PREFIX = ["--headless", "--no-header", "--"] as const;

export interface PckPatchPlanOptions {
  readonly input: PckPatchInput;
  readonly resolvedPckSource: string;
  readonly resolvedPatches: readonly PckPatchMapping[];
  /**
   * Resolved absolute ORIGINAL host CSV paths paired with exact logical import
   * sources. These are provenance/identity context and are compared with any
   * admitted absolute CSV spellings.
   */
  readonly resolvedPckTranslations?: readonly PckPatchTranslationMapping[];
  /**
   * Optional operation-owned BOM-stripped prepared copies aligned with
   * `resolvedPckTranslations`. When supplied, these paths drive CLI argv and
   * read effects. The planner does not certify ownership or staging; combined
   * preparation must supply these copies instead of host originals.
   */
  readonly preparedPckTranslations?: readonly PckPatchTranslationMapping[];
  readonly effectiveOutput: string;
  readonly operationDirectory: string;
}

const sessionTokens = (input: PckPatchInput): readonly string[] =>
  (input.session ?? []).map(
    (action) => `--disable-multithreading=${action.disabled ? "true" : "false"}`,
  );

const hasMatchingParserEdgeQuotePair = (value: string): boolean =>
  value.length >= 2 &&
  ((value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"')));

/**
 * Resolved values must survive the native option parser unchanged: absolute
 * supported local paths with no edge whitespace or parser-significant edge
 * quotes. This is parser safety, not filesystem identity certification.
 */
const isParserLosslessAbsolute = (value: string): boolean =>
  isSupportedAbsolutePath(value) &&
  !/^\s|\s$/u.test(value) &&
  !hasMatchingParserEdgeQuotePair(value);

const isParserLosslessMappingHost = (value: string): boolean =>
  isParserLosslessAbsolute(value) && !value.includes("=") && !/['"]/u.test(value);

const isParserLosslessMappingDestination = (value: string): boolean =>
  value.length > 0 &&
  !/^\s|\s$/u.test(value) &&
  !value.includes("=") &&
  !/['"]/u.test(value);

/**
 * Plan the fixed package-patch launch:
 * `--headless --no-header -- [session...] --pck-patch=SOURCE --output=OUTPUT
 *  --patch-file=HOST=res://MEMBER ... --patch-translations=CSV=res://IMPORT
 *  --locales=EXACT,LIST`.
 *
 * Ordered ordinary mappings are emitted in admitted order, followed by the one
 * admitted translation mapping when present and then the optional exact locale
 * list. Source and output are single option values and may contain `=`; mapping
 * components cannot contain `=` or single/double quotes. No shell quoting is
 * applied. Already-absolute admitted source/host/CSV/output spellings must agree
 * with resolved display spellings by lexical path identity; relative admitted
 * values trust host workspace resolution. Translation CLI CSV is the prepared
 * copy when supplied, otherwise the resolved original; neither is a generated
 * destination or a guessed suffix. The planner does not read or certify
 * filesystem identities or prepared-copy ownership, prepare staging, resolve
 * native destinations, or imply that combined execution is available.
 */
export const buildPckPatchPlan = (
  options: PckPatchPlanOptions,
): InvocationPlan => {
  const {
    input,
    resolvedPckSource,
    resolvedPatches,
    effectiveOutput,
    operationDirectory,
  } = options;
  const admittedTranslations = input.translations ?? [];
  const resolvedPckTranslations = options.resolvedPckTranslations ?? [];
  const cliTranslations =
    options.preparedPckTranslations ?? resolvedPckTranslations;

  if (!isParserLosslessAbsolute(resolvedPckSource)) {
    throw new Error(
      "resolved package source must be an absolute parser-lossless local path",
    );
  }
  if (
    isSupportedAbsolutePath(input.source) &&
    pathIdentity(input.source) !== pathIdentity(resolvedPckSource)
  ) {
    throw new Error(
      "resolved package source must identify the admitted absolute source path",
    );
  }
  if (input.patches.length === 0 && admittedTranslations.length === 0) {
    throw new Error(
      "pck-patch planning requires at least one admitted mapping family",
    );
  }
  if (resolvedPatches.length !== input.patches.length) {
    throw new Error(
      "pck-patch planning requires one resolved host-source mapping per admitted patch",
    );
  }
  const resolvedHosts = new Set<string>();
  for (const [index, resolved] of resolvedPatches.entries()) {
    const requested = input.patches[index];
    if (requested === undefined) {
      throw new Error(
        "pck-patch planning requires one resolved host-source mapping per admitted patch",
      );
    }
    if (resolved.logicalMember !== requested.logicalMember) {
      throw new Error(
        `resolved logical member does not match the admitted mapping at index ${String(index)}`,
      );
    }
    if (!isParserLosslessAbsolute(resolved.hostSource)) {
      throw new Error(
        `resolved patch host source must be an absolute parser-lossless local path: ${resolved.hostSource}`,
      );
    }
    if (!isParserLosslessMappingHost(resolved.hostSource)) {
      throw new Error(
        "resolved patch host source cannot contain = or quotes under the documented CLI-map representability policy",
      );
    }
    if (
      isSupportedAbsolutePath(requested.hostSource) &&
      pathIdentity(requested.hostSource) !== pathIdentity(resolved.hostSource)
    ) {
      throw new Error(
        `resolved patch host source must identify the admitted absolute host source at index ${String(index)}`,
      );
    }
    if (resolvedHosts.has(resolved.hostSource)) {
      throw new Error(
        "resolved patch host sources must not repeat a spelling",
      );
    }
    resolvedHosts.add(resolved.hostSource);
  }
  if (
    admittedTranslations.length > 0 &&
    options.resolvedPckTranslations === undefined
  ) {
    throw new Error(
      "resolved package translation mappings are required before pck-patch planning",
    );
  }
  if (resolvedPckTranslations.length !== admittedTranslations.length) {
    throw new Error(
      "pck-patch planning requires one resolved CSV/resource mapping per admitted translation",
    );
  }
  for (const [index, resolved] of resolvedPckTranslations.entries()) {
    const requested = admittedTranslations[index];
    if (requested === undefined) {
      throw new Error(
        "pck-patch planning requires one resolved CSV/resource mapping per admitted translation",
      );
    }
    if (resolved.resource !== requested.resource) {
      throw new Error(
        `resolved logical translation resource does not match the admitted mapping at index ${String(index)}`,
      );
    }
    if (!isParserLosslessAbsolute(resolved.csv)) {
      throw new Error(
        `resolved translation CSV must be an absolute parser-lossless local path: ${resolved.csv}`,
      );
    }
    if (!isParserLosslessMappingHost(resolved.csv)) {
      throw new Error(
        "resolved translation CSV cannot contain = or quotes under the documented CLI-map representability policy",
      );
    }
    if (!isParserLosslessMappingDestination(resolved.resource)) {
      throw new Error(
        "resolved translation logical resource cannot contain = or quotes under the documented CLI-map representability policy",
      );
    }
    if (
      isSupportedAbsolutePath(requested.csv) &&
      pathIdentity(requested.csv) !== pathIdentity(resolved.csv)
    ) {
      throw new Error(
        `resolved translation CSV must identify the admitted absolute CSV source at index ${String(index)}`,
      );
    }
  }
  const preparedPckTranslations = options.preparedPckTranslations;
  if (preparedPckTranslations !== undefined) {
    if (preparedPckTranslations.length !== admittedTranslations.length) {
      throw new Error(
        "pck-patch planning requires one prepared CSV/resource mapping per admitted translation",
      );
    }
    for (const [index, prepared] of preparedPckTranslations.entries()) {
      const requested = admittedTranslations[index];
      if (requested === undefined) {
        throw new Error(
          "pck-patch planning requires one prepared CSV/resource mapping per admitted translation",
        );
      }
      if (prepared.resource !== requested.resource) {
        throw new Error(
          `prepared logical translation resource does not match the admitted mapping at index ${String(index)}`,
        );
      }
      if (!isParserLosslessAbsolute(prepared.csv)) {
        throw new Error(
          `prepared translation CSV must be an absolute parser-lossless local path: ${prepared.csv}`,
        );
      }
      if (!isParserLosslessMappingHost(prepared.csv)) {
        throw new Error(
          "prepared translation CSV cannot contain = or quotes under the documented CLI-map representability policy",
        );
      }
    }
  }
  if (input.locales !== undefined) {
    if (admittedTranslations.length === 0) {
      throw new Error(
        "admitted locales require an admitted translation mapping before pck-patch planning",
      );
    }
    if (
      input.locales.length === 0 ||
      !input.locales.every(isSafeTranslationLocale)
    ) {
      throw new Error(
        "admitted locales must be exact safe identifiers before pck-patch planning",
      );
    }
  }
  if (!isParserLosslessAbsolute(effectiveOutput)) {
    throw new Error(
      "effective pck-patch output must be an absolute parser-lossless local path",
    );
  }
  if (
    input.output !== undefined &&
    isSupportedAbsolutePath(input.output) &&
    pathIdentity(input.output) !== pathIdentity(effectiveOutput)
  ) {
    throw new Error(
      "effective pck-patch output must identify the admitted absolute output path",
    );
  }

  return {
    argv: [
      ...PCK_PATCH_ARGV_PREFIX,
      ...sessionTokens(input),
      `--pck-patch=${resolvedPckSource}`,
      `--output=${effectiveOutput}`,
      ...resolvedPatches.map(
        (mapping) => `--patch-file=${mapping.hostSource}=${mapping.logicalMember}`,
      ),
      ...cliTranslations.map(
        (mapping) =>
          `--patch-translations=${mapping.csv}=${mapping.resource}`,
      ),
      ...(input.locales === undefined
        ? []
        : [`--locales=${input.locales.join(",")}`]),
    ],
    cwd: operationDirectory,
    timeoutMs: input.timeoutMs,
    effects: {
      reads: [
        resolvedPckSource,
        ...resolvedPatches.map((mapping) => mapping.hostSource),
        ...cliTranslations.map((mapping) => mapping.csv),
      ],
      writes: [effectiveOutput],
      network: false,
      codeExecution: false,
      unknownScope: false,
    },
  };
};
