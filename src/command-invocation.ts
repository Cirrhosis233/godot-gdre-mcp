import type { LoadedConfig } from "./config.js";
import type {
  AnyCommandDescriptor,
  CommandId,
  CommandInput,
  ExportResourcesInput,
  ExtractInput,
  InvocationPlan,
  ListFilesInput,
  ListFilesSessionAction,
  PatchTranslationMapping,
  PatchTranslationsInput,
  PckPatchInput,
  PckPatchMapping,
  PckPatchTranslationMapping,
  PlanningContext,
  VersionInput,
} from "./types.js";

/**
 * Command-specific invocation policy that is independent of the execution
 * lifecycle: default replacement, effective values/provenance, known secrets,
 * routing labels and the typed planner dispatch.
 *
 * The constructor accepts an input already admitted by the descriptor's strict
 * validator; this module does not re-validate the public wire schema.
 */

const OPERATION_LABELS: Readonly<Record<CommandId, string>> = {
  version: "GDRE version",
  "list-files": "GDRE list-files",
  extract: "GDRE extract",
  "export-resources": "GDRE export resources",
  "patch-translations": "GDRE patch translations",
  "pck-patch": "GDRE patch package members",
};

const configuredTimeout = (
  config: LoadedConfig,
  commandId: CommandId,
): number | undefined => {
  const value = config.defaults[commandId]?.timeoutMs;
  return typeof value === "number" ? value : undefined;
};

const configuredSession = (
  config: LoadedConfig,
  commandId:
    | "list-files"
    | "extract"
    | "export-resources"
    | "patch-translations"
    | "pck-patch",
): readonly ListFilesSessionAction[] | undefined => {
  const value = config.defaults[commandId]?.session;
  return Array.isArray(value) ? (value as ListFilesSessionAction[]) : undefined;
};

const redactTextForKey = (
  key: string | undefined,
): ((text: string) => string) | undefined => {
  if (key === undefined) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(escaped, "giu");
  return (text: string): string => text.replace(expression, "<redacted>");
};

export interface EffectiveInvocationContext {
  readonly workspace: string;
  /** Ordered absolute inputs resolved and admitted by the execution layer. */
  readonly resolvedInputs?: readonly string[];
  /** Accepted absolute mutation destination. */
  readonly effectiveOutput?: string;
  /** Ordered absolute translation-hint paths resolved by the execution layer. */
  readonly resolvedHints?: readonly string[];
  /** Ordered absolute original CSV files paired with their exact logical resources. */
  readonly resolvedTranslations?: readonly PatchTranslationMapping[];
  /** Resolved absolute source package for host-mediated package patching. */
  readonly resolvedPckSource?: string;
  /** Resolved absolute replacement host files paired with admitted logical members. */
  readonly resolvedPatches?: readonly PckPatchMapping[];
  /** Resolved absolute ORIGINAL host CSV paths paired with admitted translation logical resources. */
  readonly resolvedPckTranslations?: readonly PckPatchTranslationMapping[];
}

export class CommandInvocation {
  public readonly commandId: CommandId;
  /** Caller-admitted values, before any configured default replacement. */
  public readonly requested: CommandInput;
  /** Values actually planned and executed, including configured defaults. */
  public readonly input: CommandInput;
  /** Effective ordered session actions; empty for non-application commands. */
  public readonly session: readonly ListFilesSessionAction[];
  public readonly knownKey: string | undefined;
  public readonly redactText: ((text: string) => string) | undefined;
  public readonly isApplication: boolean;
  public readonly operationLabel: string;
  public readonly settingsRejection: string | null;
  public readonly parameterSources: Readonly<Record<string, string>>;

  public constructor(
    private readonly descriptor: AnyCommandDescriptor,
    requested: CommandInput,
    config: LoadedConfig,
  ) {
    this.commandId = descriptor.id;
    this.requested = requested;
    this.isApplication = descriptor.routing === "application";
    this.operationLabel = OPERATION_LABELS[descriptor.id];
    this.knownKey =
      descriptor.id === "list-files"
        ? (requested as ListFilesInput).key
        : descriptor.id === "patch-translations"
          ? (requested as PatchTranslationsInput).key
          : undefined;
    this.redactText = redactTextForKey(this.knownKey);
    this.session = this.effectiveSession(requested, config);
    this.input = this.withDefaults(requested, config);
    this.settingsRejection =
      this.isApplication && config.settings.length > 0
        ? `${descriptor.toolName} does not support nonempty configured settings in this slice.`
        : null;
    this.parameterSources = this.provenance(requested, config);
  }

  private effectiveSession(
    requested: CommandInput,
    config: LoadedConfig,
  ): readonly ListFilesSessionAction[] {
    if (
      this.commandId !== "list-files" &&
      this.commandId !== "extract" &&
      this.commandId !== "export-resources" &&
      this.commandId !== "patch-translations" &&
      this.commandId !== "pck-patch"
    ) {
      return [];
    }
    const input = requested as
      | ListFilesInput
      | ExtractInput
      | ExportResourcesInput
      | PatchTranslationsInput
      | PckPatchInput;
    return (
      input.session ?? configuredSession(config, this.commandId) ?? []
    );
  }

  private withDefaults(
    requested: CommandInput,
    config: LoadedConfig,
  ): CommandInput {
    let value = requested;
    const fallbackTimeout = configuredTimeout(config, this.commandId);
    if (value.timeoutMs === undefined && fallbackTimeout !== undefined) {
      value = { ...value, timeoutMs: fallbackTimeout } as CommandInput;
    }
    if (this.isApplication) {
      value = { ...value, session: [...this.session] } as CommandInput;
    }
    return value;
  }

  private provenance(
    requested: CommandInput,
    config: LoadedConfig,
  ): Record<string, string> {
    const sources: Record<string, string> = {
      workspace: requested.workspace === undefined ? config.sources.workspace : "call",
    };
    if (requested.timeoutMs !== undefined) {
      sources.timeoutMs = "call";
    } else if (configuredTimeout(config, this.commandId) !== undefined) {
      sources.timeoutMs = "config";
    }
    if (this.commandId === "list-files") {
      const list = requested as ListFilesInput;
      sources.inputs = "call";
      if (list.key !== undefined) sources.key = "call";
      sources.session =
        list.session !== undefined
          ? "call"
          : configuredSession(config, "list-files") !== undefined
            ? "config"
            : "builtin";
    } else if (this.commandId === "extract") {
      const extract = requested as ExtractInput;
      sources.inputs = "call";
      sources.session =
        extract.session !== undefined
          ? "call"
          : configuredSession(config, "extract") !== undefined
            ? "config"
            : "builtin";
      sources.output = extract.output === undefined ? "builtin" : "call";
      sources.include = extract.include === undefined ? "builtin" : "call";
      sources.exclude = extract.exclude === undefined ? "builtin" : "call";
      sources.selection = extract.selection === undefined ? "builtin" : "call";
    } else if (this.commandId === "export-resources") {
      const exportInput = requested as ExportResourcesInput;
      sources.inputs = "call";
      sources.session =
        exportInput.session !== undefined
          ? "call"
          : configuredSession(config, "export-resources") !== undefined
            ? "config"
            : "builtin";
      sources.output =
        exportInput.output === undefined ? "builtin" : "call";
      sources.selection = "call";
      sources.translationHints =
        exportInput.translationHints === undefined ? "builtin" : "call";
      sources.collectResourceStrings =
        exportInput.collectResourceStrings === undefined ? "builtin" : "call";
      sources.dumpResourceStrings =
        exportInput.dumpResourceStrings === undefined ? "builtin" : "call";
    } else if (this.commandId === "patch-translations") {
      const patch = requested as PatchTranslationsInput;
      sources.inputs = "call";
      sources.translations = "call";
      sources.session =
        patch.session !== undefined
          ? "call"
          : configuredSession(config, "patch-translations") !== undefined
            ? "config"
            : "builtin";
      sources.output = patch.output === undefined ? "builtin" : "call";
      sources.locales = patch.locales === undefined ? "builtin" : "call";
      if (patch.key !== undefined) sources.key = "call";
    } else if (this.commandId === "pck-patch") {
      const patch = requested as PckPatchInput;
      sources.source = "call";
      sources.patches = patch.patches.length > 0 ? "call" : "builtin";
      sources.session =
        patch.session !== undefined
          ? "call"
          : configuredSession(config, "pck-patch") !== undefined
            ? "config"
            : "builtin";
      sources.output = patch.output === undefined ? "builtin" : "call";
      if (patch.translations !== undefined) {
        sources.translations = "call";
        sources.locales = patch.locales === undefined ? "builtin" : "call";
      }
    }
    return sources;
  }

  /** Apply the descriptor's own typed planner with the admitted, defaulted input. */
  public plan(context: PlanningContext): InvocationPlan {
    switch (this.descriptor.id) {
      case "version":
        return this.descriptor.plan(this.input as VersionInput, context);
      case "list-files":
        return this.descriptor.plan(this.input as ListFilesInput, context);
      case "extract":
        return this.descriptor.plan(this.input as ExtractInput, context);
      case "export-resources":
        return this.descriptor.plan(
          this.input as ExportResourcesInput,
          context,
        );
      case "patch-translations":
        return this.descriptor.plan(
          this.input as PatchTranslationsInput,
          context,
        );
      case "pck-patch":
        return this.descriptor.plan(this.input as PckPatchInput, context);
    }
  }

  /**
   * Effective parameter record persisted in the invocation manifest. Values
   * that were never prepared keep the same explicit unresolved markers as the
   * execution lifecycle records before preparation.
   */
  public effectiveParameters(
    context: EffectiveInvocationContext,
    plannedTimeoutMs?: number,
  ): Record<string, unknown> {
    const effective: Record<string, unknown> = { workspace: context.workspace };
    if (this.isApplication) effective.session = [...this.session];
    if (
      this.commandId === "list-files" ||
      this.commandId === "extract" ||
      this.commandId === "export-resources" ||
      this.commandId === "patch-translations"
    ) {
      effective.inputs =
        context.resolvedInputs === undefined
          ? { status: "unresolved" }
          : context.resolvedInputs.map((value) => ({ kind: "path", path: value }));
    }
    if (
      this.commandId === "extract" ||
      this.commandId === "export-resources" ||
      this.commandId === "patch-translations"
    ) {
      effective.output = context.effectiveOutput ?? { status: "unresolved" };
    }
    if (plannedTimeoutMs !== undefined) effective.timeoutMs = plannedTimeoutMs;
    if (this.commandId === "list-files" && context.resolvedInputs !== undefined) {
      effective.key =
        (this.input as ListFilesInput).key === undefined
          ? undefined
          : { redacted: true };
    } else if (this.commandId === "extract") {
      const extract = this.input as ExtractInput;
      effective.include = extract.include ?? [];
      effective.exclude = extract.exclude ?? [];
      effective.selection = extract.selection ?? "all";
    } else if (this.commandId === "export-resources") {
      const exportInput = this.input as ExportResourcesInput;
      effective.translationHints =
        context.resolvedHints === undefined
          ? { status: "unresolved" }
          : context.resolvedHints.map((value) => ({
              kind: "path" as const,
              path: value,
            }));
      effective.selection = exportInput.selection;
      effective.collectResourceStrings =
        exportInput.collectResourceStrings ?? true;
      effective.dumpResourceStrings =
        exportInput.dumpResourceStrings ?? false;
    } else if (this.commandId === "patch-translations") {
      const patch = this.input as PatchTranslationsInput;
      effective.translations =
        context.resolvedTranslations === undefined
          ? { status: "unresolved" }
          : context.resolvedTranslations.map((mapping) => ({
              csv: mapping.csv,
              resource: mapping.resource,
            }));
      effective.locales = patch.locales === undefined ? [] : [...patch.locales];
      effective.localeSelection =
        patch.locales === undefined ? "new-locales-only" : "explicit";
      if (patch.key !== undefined) effective.key = { redacted: true };
    } else if (this.commandId === "pck-patch") {
      const patch = this.input as PckPatchInput;
      effective.source = context.resolvedPckSource ?? { status: "unresolved" };
      effective.patches =
        context.resolvedPatches === undefined
          ? { status: "unresolved" }
          : context.resolvedPatches.map((mapping) => ({
              hostSource: mapping.hostSource,
              logicalMember: mapping.logicalMember,
            }));
      if (patch.translations !== undefined) {
        effective.translations =
          context.resolvedPckTranslations === undefined
            ? { status: "unresolved" }
            : context.resolvedPckTranslations.map((mapping) => ({
                csv: mapping.csv,
                resource: mapping.resource,
              }));
        effective.locales =
          patch.locales === undefined ? [] : [...patch.locales];
        effective.localeSelection =
          patch.locales === undefined ? "new-locales-only" : "explicit";
      }
      effective.output = context.effectiveOutput ?? { status: "unresolved" };
    }
    return effective;
  }
}
