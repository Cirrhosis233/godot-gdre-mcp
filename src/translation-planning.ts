import { isSupportedAbsolutePath, joinPath } from "./paths.js";
import type {
  InvocationPlan,
  PatchTranslationMapping,
  PatchTranslationsInput,
} from "./types.js";

/**
 * Standalone translation-patch contract and planning. The accepted route is one
 * fixed trusted native script launch, not the CLI map grammar and not a second
 * process runner. This module owns only execution-neutral argv/evidence planning;
 * native request writing, report interpretation and text verification belong to
 * the operation-local integration slice.
 */

export const PATCH_TRANSLATIONS_RULE = "gdre-patch-translations-v1";

/** Fixed launch prefix; the trusted script path is supplied by execution context. */
export const PATCH_TRANSLATIONS_ARGV_PREFIX = ["--headless", "--script"] as const;

/** Operation-local evidence namespace and fixed request/report names. */
export const PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE = "translation-patch";
export const PATCH_TRANSLATIONS_REQUEST_FILENAME = "request.json";
export const PATCH_TRANSLATIONS_REPORT_FILENAME = "report.json";

export const patchTranslationsRequestPath = (
  operationDirectory: string,
): string =>
  joinPath(
    operationDirectory,
    PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
    PATCH_TRANSLATIONS_REQUEST_FILENAME,
  );

export const patchTranslationsReportPath = (
  operationDirectory: string,
): string =>
  joinPath(
    operationDirectory,
    PATCH_TRANSLATIONS_EVIDENCE_NAMESPACE,
    PATCH_TRANSLATIONS_REPORT_FILENAME,
  );

export interface PatchTranslationsPlanOptions {
  readonly input: PatchTranslationsInput;
  readonly resolvedInputs: readonly string[];
  readonly resolvedTranslations: readonly PatchTranslationMapping[];
  readonly effectiveOutput: string;
  readonly operationDirectory: string;
  readonly patchTranslationsScriptPath: string;
}

/**
 * Plan the single fixed native launch:
 * `--headless --script FIXED -- REQUEST_JSON REPORT_JSON [--key=HEX]`.
 *
 * The request JSON never contains the key; when supplied, the key stays a
 * redactable argv token. Ordered session actions are preserved by the invocation
 * record and applied by the trusted script, so they are deliberately absent from
 * this argv. Resolved CSV/resource pairs must correspond one-to-one with the
 * admitted mappings; the planner never guesses, renames or reorders them.
 */
export const buildPatchTranslationsPlan = (
  options: PatchTranslationsPlanOptions,
): InvocationPlan => {
  const {
    input,
    resolvedInputs,
    resolvedTranslations,
    effectiveOutput,
    operationDirectory,
    patchTranslationsScriptPath,
  } = options;

  if (!isSupportedAbsolutePath(patchTranslationsScriptPath)) {
    throw new Error(
      "fixed patch translations script path must be an absolute supported local path",
    );
  }
  if (resolvedInputs.length === 0) {
    throw new Error(
      "resolved package/project inputs are required before patch planning",
    );
  }
  if (resolvedTranslations.length === 0) {
    throw new Error(
      "resolved translation mappings are required before patch planning",
    );
  }
  if (resolvedTranslations.length !== input.translations.length) {
    throw new Error(
      "patch planning requires one resolved CSV/resource mapping per translation",
    );
  }
  for (const [index, resolved] of resolvedTranslations.entries()) {
    const requested = input.translations[index];
    if (requested === undefined) {
      throw new Error(
        "patch planning requires one resolved CSV/resource mapping per translation",
      );
    }
    if (resolved.resource !== requested.resource) {
      throw new Error(
        `resolved logical resource does not match the admitted mapping at index ${String(index)}`,
      );
    }
    if (!isSupportedAbsolutePath(resolved.csv)) {
      throw new Error(
        `resolved CSV path must be an absolute supported local path: ${resolved.csv}`,
      );
    }
  }
  if (!isSupportedAbsolutePath(effectiveOutput)) {
    throw new Error(
      "effective translation output must be an absolute supported local path",
    );
  }

  const requestPath = patchTranslationsRequestPath(operationDirectory);
  const reportPath = patchTranslationsReportPath(operationDirectory);
  return {
    argv: [
      ...PATCH_TRANSLATIONS_ARGV_PREFIX,
      patchTranslationsScriptPath,
      "--",
      requestPath,
      reportPath,
      ...(input.key === undefined ? [] : [`--key=${input.key}`]),
    ],
    cwd: operationDirectory,
    timeoutMs: input.timeoutMs,
    effects: {
      reads: [
        patchTranslationsScriptPath,
        ...resolvedInputs,
        ...resolvedTranslations.map((mapping) => mapping.csv),
      ],
      writes: [effectiveOutput, requestPath, reportPath],
      network: false,
      codeExecution: false,
      unknownScope: false,
    },
  };
};
