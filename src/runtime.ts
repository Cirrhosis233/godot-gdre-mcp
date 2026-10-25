import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { joinPath } from "./paths.js";
import type { LoadedConfig } from "./config.js";
import { REGISTRY_VERSION } from "./config.js";
import { createStartupStorage, AtomicJsonWriter, type StartupStorage, StorageError } from "./storage.js";
import {
  defaultProcessRunner,
  type ProcessRunResult,
  type ProcessRunner,
  type StreamSummaryValue,
  emptySummary,
} from "./process.js";
import type { OwnershipFactory } from "./process-tree.js";
import { versionCommand } from "./registry.js";
import { boundedUtf8 } from "./text.js";
import type { RuntimeState } from "./types.js";

export const RUNTIME_BASELINE = Object.freeze({
  "gdre_tools.exe": "598c75267729aca4b7aa7bcc06ddd428dbe76760cbed0d0fdcdb02a089d7983d",
  "gdre_tools.pck": "188f88b0e9bf581c445a2ac2280ed09d8987ff28311c971609e7c5cc6f3b5992",
  "GodotMonoDecompNativeAOT.dll": "9e23279a04ba98032398ec83454e4b9402393ea8a77d425ed4ef691ace8cd5a9",
} as const);
// Keep the literal hashes visible and typo-proof at runtime.

export interface RuntimePaths {
  readonly executable: string;
  readonly companions: readonly [string, string, string];
}

export interface RuntimeHealthOptions {
  readonly processRunner?: ProcessRunner;
  readonly ownershipFactory?: OwnershipFactory;
  readonly helperScriptPath?: string;
  readonly startupIdFactory?: () => string;
  readonly writer?: AtomicJsonWriter;
}

export class RuntimeStartupError extends Error {
  public readonly code = "runtime_startup_evidence_failed";
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeStartupError";
  }
}

const bounded = (value: unknown, fallback: string): string => boundedUtf8(value, fallback);

const emptyProbe = (): RuntimeState["probe"] => ({
  exitCode: null,
  signal: null,
  stdout: emptySummary(),
  stderr: emptySummary(),
  error: null,
});

const freezeDeep = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
};

export function runtimePaths(config: LoadedConfig): RuntimePaths {
  return {
    executable: joinPath(config.runtimeDirectory, "gdre_tools.exe"),
    companions: [
      joinPath(config.runtimeDirectory, "gdre_tools.exe"),
      joinPath(config.runtimeDirectory, "gdre_tools.pck"),
      joinPath(config.runtimeDirectory, "GodotMonoDecompNativeAOT.dll"),
    ],
  };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.readableWebStream() as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

const safeHash = async (file: string): Promise<string | null> => {
  try {
    return await sha256(file);
  } catch {
    return null;
  }
};

const probeErrorDiagnostic = (stderr: string): boolean =>
  /(?:loader|failed\s+to\s+(?:load|start)|cannot\s+find|dll\s+(?:not\s+found|load)|fatal|exception)/iu.test(stderr);

const startupRecord = (state: RuntimeState, run: ProcessRunResult | null): Record<string, unknown> => ({
  schemaVersion: 1,
  checkedAt: state.checkedAt,
  runtime: state,
  probe: run
    ? {
        pid: run.pid,
        exitCode: run.exitCode,
        signal: run.signal,
        trigger: run.trigger,
        error: run.error,
        cleanup: run.cleanup,
      }
    : null,
});

const probeSummary = (run: ProcessRunResult | null): RuntimeState["probe"] => {
  if (run === null) return emptyProbe();
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    error: run.error ?? (run.cleanup.state === "confirmed" ? null : run.cleanup.error),
  };
};

const immutable = (state: RuntimeState): RuntimeState => freezeDeep(state);

export async function checkRuntime(config: LoadedConfig, options: RuntimeHealthOptions = {}): Promise<RuntimeState> {
  const paths = runtimePaths(config);
  let startup: StartupStorage;
  try {
    startup = await createStartupStorage(config.workspaceRoot, options.startupIdFactory);
  } catch (error) {
    throw new RuntimeStartupError(`cannot retain startup runtime evidence: ${bounded(error, "storage failure")}`, { cause: error });
  }

  const companions = [] as RuntimeState["companions"];
  const hashes: (string | null)[] = [];
  const warnings: string[] = [];
  for (const file of paths.companions) {
    let present = false;
    try {
      const stat = await fs.stat(file);
      present = stat.isFile();
    } catch {
      present = false;
    }
    const digest = present ? await safeHash(file) : null;
    hashes.push(digest);
    companions.push({ path: file, present, sha256: digest });
  }
  const allPresent = companions.every((companion) => companion.present && companion.sha256 !== null);
  const baseline = [
    RUNTIME_BASELINE["gdre_tools.exe"],
    RUNTIME_BASELINE["gdre_tools.pck"],
    RUNTIME_BASELINE["GodotMonoDecompNativeAOT.dll"],
  ];
  const baselineHashesMatch = allPresent ? hashes.every((hash, index) => hash === baseline[index]) : null;
  if (baselineHashesMatch === false) warnings.push("runtime companion SHA-256 does not match the fixed baseline; identity is unverified");
  if (!allPresent) warnings.push("one or more required GDRE runtime companions are missing or unreadable");

  let run: ProcessRunResult | null = null;
  let actualVersion: string | null = null;
  let semanticFailure: string | null = null;
  try {
    if (allPresent) {
      const runner = options.processRunner ?? defaultProcessRunner;
      const probePlan = versionCommand.plan({}, {
        workspace: config.workspaceRoot,
        operationDirectory: startup.directory,
      });
      try {
        run = await runner.run({
          executable: paths.executable,
          argv: [...probePlan.argv],
          cwd: probePlan.cwd,
          env: { ...process.env },
          timeoutMs: 10_000,
          streamPaths: {
            stdoutBin: startup.stdoutBin,
            stdoutText: startup.stdoutText,
            stderrBin: startup.stderrBin,
            stderrText: startup.stderrText,
          },
          statusPath: joinPath(startup.directory, "ownership.json"),
          ownershipFactory: options.ownershipFactory,
          helperScriptPath: options.helperScriptPath,
          sink: startup.sink,
        });
        const evaluation = versionCommand.evaluate({
          exitCode: run.exitCode,
          signal: run.signal,
          stdout: run.stdoutText,
          stderr: run.stderrText,
          stdoutTruncated: run.stdout.truncated,
        });
        if (evaluation.status === "succeeded" && evaluation.data !== null) actualVersion = evaluation.data.version;
        else semanticFailure = evaluation.summary;
        if (run.storageError !== null) semanticFailure = `runtime probe stream storage failed: ${run.storageError}`;
        if (run.stderrText.length > 0) warnings.push("runtime probe wrote stderr; full warning evidence is retained in startup records");
        if (run.storageError === null && run.stderr.truncated) {
          semanticFailure = `runtime probe stderr preview was truncated; inspect complete retained evidence at ${run.stderr.textPath ?? startup.stderrText}`;
        } else if (run.storageError === null && probeErrorDiagnostic(run.stderrText)) {
          semanticFailure = "runtime probe emitted a loader or fatal diagnostic";
        }
      } catch (error) {
        semanticFailure = bounded(error, "runtime probe failed");
      }
    }
  } finally {
    try {
      await startup.sink.close();
    } catch (error) {
      semanticFailure ??= `runtime probe stream evidence could not be closed; inspect ${startup.stderrText}: ${bounded(error, "stream close failed")}`;
    }
  }
  if (actualVersion !== null && actualVersion !== config.targetVersion) warnings.push(`runtime version ${actualVersion} does not match target ${config.targetVersion}`);

  const probe = probeSummary(run);
  const usable = allPresent && run !== null && run.spawnError === null && run.storageError === null && run.trigger === null && run.signal === null && (run.exitCode === 0 || run.exitCode === 1) && semanticFailure === null && run.cleanup.state === "confirmed" && run.stdout.complete && run.stderr.complete;
  if (!usable && allPresent) warnings.push(semanticFailure ?? run?.error ?? "runtime version probe was unavailable");
  const state: RuntimeState = {
    health: usable ? "ready" : "unavailable",
    registryVersion: REGISTRY_VERSION,
    targetVersion: config.targetVersion,
    actualVersion,
    comparison: usable ? (actualVersion === config.targetVersion ? "match" : "mismatch") : "unavailable",
    executable: paths.executable,
    companions,
    exeSha256: hashes[0] ?? null,
    baselineHashesMatch,
    checkedAt: new Date().toISOString(),
    evidencePath: startup.record,
    probe,
    warnings: warnings.slice(0, 32),
  };
  try {
    await (options.writer ?? new AtomicJsonWriter()).write(startup.record, startupRecord(state, run));
  } catch (error) {
    throw new RuntimeStartupError(`cannot commit startup runtime evidence: ${bounded(error, "storage failure")}`, { cause: error });
  }
  return immutable(state);
}

export class RuntimeManager {
  private readonly config: LoadedConfig;
  private readonly options: RuntimeHealthOptions;
  private currentState: RuntimeState;
  private identity = "";
  private refreshing: Promise<RuntimeState> | null = null;

  private constructor(config: LoadedConfig, options: RuntimeHealthOptions, state: RuntimeState, identity: string) {
    this.config = config;
    this.options = options;
    this.currentState = state;
    this.identity = identity;
  }

  public static async create(config: LoadedConfig, options: RuntimeHealthOptions = {}): Promise<RuntimeManager> {
    const state = await checkRuntime(config, options);
    return new RuntimeManager(config, options, state, await identityFor(config));
  }

  public get state(): RuntimeState {
    return this.currentState;
  }

  public async refreshIfChanged(): Promise<RuntimeState> {
    const nextIdentity = await identityFor(this.config);
    // An unavailable runtime may be retried on a later explicit call (§8.1);
    // this is not an automatic update loop. A ready snapshot is reused unless
    // the companion identity changed.
    if (nextIdentity === this.identity && this.currentState.health === "ready") return this.currentState;
    if (this.refreshing !== null) return this.refreshing;
    this.refreshing = checkRuntime(this.config, this.options).then((state) => {
      this.currentState = state;
      this.identity = nextIdentity;
      this.refreshing = null;
      return state;
    }, (error: unknown) => {
      this.refreshing = null;
      throw error;
    });
    return this.refreshing;
  }
}

async function identityFor(config: LoadedConfig): Promise<string> {
  const paths = runtimePaths(config);
  const values = await Promise.all(paths.companions.map(safeHash));
  return values.map((value) => value ?? "missing").join("|");
}
