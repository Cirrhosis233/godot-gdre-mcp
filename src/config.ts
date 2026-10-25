import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_TIMEOUT_MS,
  MAX_SESSION_ACTIONS,
  listFilesSessionActionSchema,
} from "./schemas.js";
import { isSupportedAbsolutePath, resolveDisplayPath, validatePathSyntax } from "./paths.js";

export const REGISTRY_VERSION = "2.8.0-beta.2";
export const DEFAULT_TARGET_VERSION = "2.8.0-beta.2";

export interface TimeoutConfig {
  readonly maxMs: number;
}

export interface TypedSetting {
  readonly key: string;
  readonly type: "boolean" | "integer" | "string" | "string-array";
  readonly value: boolean | number | string | readonly string[];
}

export interface ConfigSources {
  readonly workspace: "builtin" | "config" | "environment";
  readonly runtimeDirectory: "builtin" | "config" | "environment";
  readonly targetVersion: "builtin" | "config";
  readonly timeouts: "builtin" | "config";
  readonly defaults: "builtin" | "config";
  readonly settings: "builtin" | "config";
}

export interface LoadedConfig {
  readonly installationRoot: string;
  readonly configFile: string | null;
  readonly workspaceRoot: string;
  readonly runtimeDirectory: string;
  readonly targetVersion: string;
  readonly timeouts: TimeoutConfig;
  readonly defaults: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly settings: readonly TypedSetting[];
  readonly sources: ConfigSources;
}

export class ConfigError extends Error {
  public readonly code = "configuration_invalid";
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

const CONFIG_FIELDS = new Set([
  "workspaceRoot",
  "runtimeDirectory",
  "targetVersion",
  "timeouts",
  "defaults",
  "settings",
]);
const TIMEOUT_FIELDS = new Set(["maxMs"]);
const SETTING_TYPES = new Set(["boolean", "integer", "string", "string-array"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rejectUnknown = (value: Record<string, unknown>, allowed: Set<string>, label: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ConfigError(`${label} contains unknown field ${JSON.stringify(key)}.`);
  }
};

const nonemptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\0\r\n]/u.test(value)) {
    throw new ConfigError(`${label} must be a nonempty bounded string.`);
  }
  return value;
};

const positiveBudget = (value: unknown, label: string, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConfigError(`${label} must be a positive integer no greater than ${String(max)}.`);
  }
  return value;
};

const parseTimeouts = (value: unknown, fallback: TimeoutConfig): TimeoutConfig => {
  if (value === undefined) return fallback;
  if (!isRecord(value)) throw new ConfigError("timeouts must be an object.");
  for (const field of ["defaultMs", "queueMs"]) {
    if (Object.hasOwn(value, field)) {
      throw new ConfigError(`timeouts.${field} is retired. Remove it; configure defaults.<command>.timeoutMs or pass timeoutMs explicitly when a cancellation limit is wanted.`);
    }
  }
  rejectUnknown(value, TIMEOUT_FIELDS, "timeouts");
  const maxMs = value.maxMs === undefined ? fallback.maxMs : positiveBudget(value.maxMs, "timeouts.maxMs", MAX_TIMEOUT_MS);
  return { maxMs };
};

const normalizeSettingKey = (key: string): string => {
  const normalized = key.includes("/") ? key : `General/${key}`;
  if (!/^[^/\0\r\n]+\/[^/\0\r\n]+$/u.test(normalized)) throw new ConfigError(`setting key ${JSON.stringify(key)} is invalid.`);
  return normalized;
};

const parseSettings = (value: unknown): readonly TypedSetting[] => {
  // The example config uses an empty object. Preserve that ergonomic empty form,
  // while requiring all nonempty settings to use the typed entry representation.
  if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) return [];
  if (!Array.isArray(value)) throw new ConfigError("settings must be an array of typed entries.");
  const entries: TypedSetting[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) throw new ConfigError(`settings[${String(index)}] must be an object.`);
    rejectUnknown(raw, new Set(["key", "type", "value"]), `settings[${String(index)}]`);
    const key = normalizeSettingKey(nonemptyString(raw.key, `settings[${String(index)}].key`));
    if (keys.has(key.toLowerCase())) throw new ConfigError(`settings contains duplicate key ${JSON.stringify(key)}.`);
    keys.add(key.toLowerCase());
    if (typeof raw.type !== "string" || !SETTING_TYPES.has(raw.type)) throw new ConfigError(`settings[${String(index)}].type is unsupported.`);
    const type = raw.type as TypedSetting["type"];
    let settingValue: TypedSetting["value"];
    if (type === "boolean") {
      if (typeof raw.value !== "boolean") throw new ConfigError(`settings[${String(index)}].value must be boolean.`);
      settingValue = raw.value;
    } else if (type === "integer") {
      if (typeof raw.value !== "number" || !Number.isSafeInteger(raw.value)) throw new ConfigError(`settings[${String(index)}].value must be a safe integer.`);
      settingValue = raw.value;
    } else if (type === "string") {
      settingValue = nonemptyString(raw.value, `settings[${String(index)}].value`);
    } else {
      if (!Array.isArray(raw.value) || raw.value.some((item) => typeof item !== "string")) throw new ConfigError(`settings[${String(index)}].value must be a string array.`);
      settingValue = Object.freeze([...raw.value] as string[]);
    }
    entries.push(Object.freeze({ key, type, value: settingValue }));
  }
  return Object.freeze(entries);
};

const parseDefaults = (
  value: unknown,
  maxMs: number,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> => {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new ConfigError("defaults must be an object keyed by canonical command id.");
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [commandId, raw] of Object.entries(value)) {
    if (
      commandId !== "version" &&
      commandId !== "list-files" &&
      commandId !== "extract" &&
      commandId !== "export-resources" &&
      commandId !== "patch-translations" &&
      commandId !== "pck-patch"
    ) {
      throw new ConfigError(`defaults contains unknown command ${JSON.stringify(commandId)}.`);
    }
    if (!isRecord(raw)) throw new ConfigError(`defaults.${commandId} must be an object.`);
    const allowed = commandId === "version" ? new Set(["timeoutMs"]) : new Set(["timeoutMs", "session"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new ConfigError(`defaults.${commandId} contains unsupported field ${JSON.stringify(key)}.`);
    }
    if (raw.timeoutMs !== undefined) positiveBudget(raw.timeoutMs, `defaults.${commandId}.timeoutMs`, maxMs);
    if (
      (commandId === "list-files" ||
        commandId === "extract" ||
        commandId === "export-resources" ||
        commandId === "patch-translations" ||
        commandId === "pck-patch") &&
      raw.session !== undefined
    ) {
      if (!Array.isArray(raw.session) || raw.session.length > MAX_SESSION_ACTIONS || raw.session.some((action) => !listFilesSessionActionSchema.safeParse(action).success)) {
        throw new ConfigError(`defaults.${commandId}.session contains an unsupported action.`);
      }
    }
    result[commandId] = Object.freeze({ ...raw });
  }
  return Object.freeze(result);
};

const readJson = async (file: string, explicit: boolean): Promise<{ readonly value: unknown; readonly exists: boolean }> => {
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !explicit) return { value: undefined, exists: false };
    throw new ConfigError(`Cannot read configuration file ${file}: ${code ?? "unknown error"}.`, { cause: error });
  }
  try {
    return { value: JSON.parse(source) as unknown, exists: true };
  } catch (error) {
    throw new ConfigError(`Configuration file ${file} is not valid JSON.`, { cause: error });
  }
};

const configPathFor = (installationRoot: string, env: NodeJS.ProcessEnv): { readonly file: string; readonly explicit: boolean } => {
  const selected = env.GDRE_MCP_CONFIG;
  if (selected !== undefined) {
    if (selected.length === 0 || !isSupportedAbsolutePath(selected)) throw new ConfigError("GDRE_MCP_CONFIG must be an absolute local path.");
    return { file: selected, explicit: true };
  }
  return { file: path.join(installationRoot, "gdre-mcp.config.json"), explicit: false };
};

const resolveConfigPath = (value: string, base: string, label: string): string => {
  if (value.length === 0 || value.startsWith("~") || !validatePathSyntax(value)) throw new ConfigError(`${label} is not a safe path.`);
  try {
    return resolveDisplayPath(base, value, true);
  } catch (error) {
    throw new ConfigError(`${label} is not a safe path.`, { cause: error });
  }
};

export async function loadConfig(installationRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  if (!isSupportedAbsolutePath(installationRoot)) throw new ConfigError("installationRoot must be an absolute local path.");
  const installation = path.normalize(installationRoot);
  const selected = configPathFor(installation, environment);
  const loaded = await readJson(selected.file, selected.explicit);
  const raw = loaded.value === undefined ? {} : loaded.value;
  if (!isRecord(raw)) throw new ConfigError("configuration root must be an object.");
  rejectUnknown(raw, CONFIG_FIELDS, "configuration");
  const configDirectory = path.dirname(selected.file);

  const workspaceEnv = environment.GDRE_MCP_WORKSPACE;
  const runtimeEnv = environment.GDRE_MCP_RUNTIME_DIR;
  const configWorkspace = raw.workspaceRoot;
  let workspaceRoot: string;
  let workspaceSource: ConfigSources["workspace"];
  if (workspaceEnv !== undefined) {
    if (workspaceEnv.length === 0 || !isSupportedAbsolutePath(workspaceEnv)) throw new ConfigError("GDRE_MCP_WORKSPACE must be an absolute local path.");
    workspaceRoot = resolveConfigPath(workspaceEnv, installation, "GDRE_MCP_WORKSPACE");
    workspaceSource = "environment";
  } else if (configWorkspace !== undefined) {
    if (typeof configWorkspace !== "string") throw new ConfigError("workspaceRoot must be a path string.");
    workspaceRoot = resolveConfigPath(configWorkspace, configDirectory, "workspaceRoot");
    workspaceSource = "config";
  } else {
    const automaticWorkspace = path.join(os.tmpdir(), "GodotGdreMcp");
    try {
      if (!isSupportedAbsolutePath(automaticWorkspace)) {
        throw new Error("the system temporary directory did not produce a supported absolute local path");
      }
      workspaceRoot = resolveDisplayPath(automaticWorkspace, automaticWorkspace, false);
    } catch (error) {
      throw new ConfigError(
        `The automatic temporary workspace ${JSON.stringify(automaticWorkspace)} is unusable: ${error instanceof Error ? error.message : String(error)}. Set GDRE_MCP_WORKSPACE or workspaceRoot to an explicit absolute local path.`,
        { cause: error },
      );
    }
    workspaceSource = "builtin";
  }

  let runtimeDirectory: string;
  let runtimeSource: ConfigSources["runtimeDirectory"];
  if (runtimeEnv !== undefined) {
    if (runtimeEnv.length === 0 || !isSupportedAbsolutePath(runtimeEnv)) throw new ConfigError("GDRE_MCP_RUNTIME_DIR must be an absolute local path.");
    runtimeDirectory = resolveConfigPath(runtimeEnv, installation, "GDRE_MCP_RUNTIME_DIR");
    runtimeSource = "environment";
  } else if (raw.runtimeDirectory !== undefined) {
    if (typeof raw.runtimeDirectory !== "string") throw new ConfigError("runtimeDirectory must be a path string.");
    runtimeDirectory = resolveConfigPath(raw.runtimeDirectory, installation, "runtimeDirectory");
    runtimeSource = "config";
  } else {
    runtimeDirectory = resolveConfigPath("vendor/GDRE_tools", installation, "runtimeDirectory");
    runtimeSource = "builtin";
  }

  const targetVersion = raw.targetVersion === undefined ? DEFAULT_TARGET_VERSION : nonemptyString(raw.targetVersion, "targetVersion");
  const builtinTimeouts: TimeoutConfig = { maxMs: MAX_TIMEOUT_MS };
  const timeouts = parseTimeouts(raw.timeouts, builtinTimeouts);
  const settings = parseSettings(raw.settings);
  const defaults = parseDefaults(raw.defaults, timeouts.maxMs);
  return Object.freeze({
    installationRoot: installation,
    configFile: loaded.exists ? selected.file : null,
    workspaceRoot,
    runtimeDirectory,
    targetVersion,
    timeouts,
    defaults,
    settings,
    sources: {
      workspace: workspaceSource,
      runtimeDirectory: runtimeSource,
      targetVersion: raw.targetVersion === undefined ? "builtin" : "config",
      timeouts: raw.timeouts === undefined ? "builtin" : "config",
      defaults: raw.defaults === undefined ? "builtin" : "config",
      settings: raw.settings === undefined ? "builtin" : "config",
    } satisfies ConfigSources,
  });
}

export const loadConfiguration = loadConfig;
