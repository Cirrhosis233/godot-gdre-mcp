import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AtomicJsonWriter,
  StorageError,
  type JsonWriter,
} from "../src/storage.js";
import {
  ExecutionImpl,
  type ExecutionContext,
  type ExecutionOpenOptions,
} from "../src/execution.js";
import type { LoadedConfig } from "../src/config.js";
import { NodeProcessRunner } from "../src/process.js";
import type {
  ProcessRunResult,
  ProcessRunner,
  ProcessRunOptions,
  StreamSummaryValue,
} from "../src/process.js";
import {
  ScriptedOwnershipFactory,
  type OwnedLaunchRequest,
  type OwnershipCompletion,
  type OwnershipFactory,
  type OwnershipHandle,
  type OwnershipRootExit,
} from "../src/process-tree.js";
import type { OperationResult, RuntimeState } from "../src/types.js";
import type { RuntimeManager } from "../src/runtime.js";

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const makeStream = (
  options: ProcessRunOptions,
  kind: "stdout" | "stderr",
  text: string,
): StreamSummaryValue => {
  const rawPath = kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin;
  const textPath = kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText;
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    text,
    truncated: false,
    utf8Valid: true,
    rawPath,
    textPath,
    complete: true,
  };
};

const successOutput = "Godot RE Tools v2.8.0-beta.2\r\n";

const successfulRun = async (
  options: ProcessRunOptions,
  cleanup: ProcessRunResult["cleanup"] = {
    state: "not_needed",
    trigger: null,
    actions: [],
    error: null,
  },
  pid: number | null = null,
): Promise<ProcessRunResult> => {
  await options.sink?.append("stdout", Buffer.from(successOutput, "utf8"), successOutput);
  await options.sink?.close();
  const spawnedAtMono = performance.now();
  const exitedAtMono = spawnedAtMono + 1;
  return {
    pid,
    exitCode: 1,
    signal: null,
    spawnError: null,
    timedOut: false,
    trigger: null,
    exitObserved: true,
    spawnedAt: new Date().toISOString(),
    spawnedAtMono,
    exitedAt: new Date().toISOString(),
    exitedAtMono,
    stdout: makeStream(options, "stdout", successOutput),
    stderr: makeStream(options, "stderr", ""),
    stdoutText: successOutput,
    stderrText: "",
    ownership: null,
    cleanup,
    captureError: null,
    storageError: null,
    error: null,
  };
};

const heldRunner = (): {
  readonly runner: ProcessRunner;
  readonly entered: Promise<void>;
  release(): void;
} => {
  let enteredResolve: (() => void) | undefined;
  let releaseResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    runner: {
      async run(options): Promise<ProcessRunResult> {
        enteredResolve?.();
        await released;
        return successfulRun(options);
      },
    },
    entered,
    release(): void {
      releaseResolve?.();
    },
  };
};

const waitForRunnerStart = async (
  entered: Promise<void>,
  operation: Promise<OperationResult>,
  timeoutMs = 5_000,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      entered,
      operation.then((result) => {
        throw new Error(`Held operation ended before runner start: ${result.error?.code ?? result.status}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Held runner did not start within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

class TrackedSignal {
  private readonly controller = new AbortController();
  public added = 0;
  public removed = 0;

  public get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  public get reason(): unknown {
    return this.controller.signal.reason;
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.added += 1;
    (this.controller.signal as unknown as EventTarget).addEventListener(type, listener, options);
  }

  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.removed += 1;
    (this.controller.signal as unknown as EventTarget).removeEventListener(type, listener, options);
  }

  public abort(reason?: unknown): void {
    this.controller.abort(reason);
  }

  public asSignal(): AbortSignal {
    return this as unknown as AbortSignal;
  }
}

class RecordingWriter implements JsonWriter {
  public readonly terminal: Record<string, unknown>[] = [];
  private readonly delegate = new AtomicJsonWriter();
  private readonly delayMs: number;
  private readonly failFirstTerminal: boolean;

  public constructor(options: { readonly delayMs?: number; readonly failFirstTerminal?: boolean; } = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.failFirstTerminal = options.failFirstTerminal ?? false;
  }

  public async write(file: string, value: unknown): Promise<void> {
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : null;
    const state = typeof record?.state === "string" ? record.state : null;
    const terminal = state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out" || state === "interrupted";
    if (terminal) {
      this.terminal.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      if (this.terminal.length === 1 && this.delayMs > 0) await sleep(this.delayMs);
      if (this.failFirstTerminal && this.terminal.length === 1) {
        throw new StorageError("injected terminal write failure");
      }
    }
    await this.delegate.write(file, value);
  }
}

const readyRuntime = (root: string): RuntimeState => ({
  health: "ready",
  registryVersion: "2.8.0-beta.2",
  targetVersion: "2.8.0-beta.2",
  actualVersion: "2.8.0-beta.2",
  comparison: "match",
  executable: path.join(root, "runtime", "gdre_tools.exe"),
  companions: [
    { path: path.join(root, "runtime", "gdre_tools.exe"), present: true, sha256: "a".repeat(64) },
    { path: path.join(root, "runtime", "gdre_tools.pck"), present: true, sha256: "b".repeat(64) },
    { path: path.join(root, "runtime", "GodotMonoDecompNativeAOT.dll"), present: true, sha256: "c".repeat(64) },
  ],
  exeSha256: "a".repeat(64),
  baselineHashesMatch: true,
  checkedAt: new Date().toISOString(),
  evidencePath: path.join(root, "startup.json"),
  probe: {
    exitCode: 1,
    signal: null,
    stdout: {
      bytes: 0,
      text: "",
      truncated: false,
      utf8Valid: true,
      rawPath: null,
      textPath: null,
      complete: false,
    },
    stderr: {
      bytes: 0,
      text: "",
      truncated: false,
      utf8Valid: true,
      rawPath: null,
      textPath: null,
      complete: false,
    },
    error: null,
  },
  warnings: [],
});

const makeConfig = (root: string): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults: {},
  settings: [],
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: "builtin",
    settings: "builtin",
  },
});

const makeExecution = (
  root: string,
  options: {
    readonly processRunner?: ProcessRunner;
    readonly ownershipFactory?: OwnershipFactory;
    readonly storageFaults?: ExecutionOpenOptions["storageFaults"];
    readonly writer?: JsonWriter;
  } = {},
): ExecutionImpl => {
  const config = makeConfig(root);
  const runtime = readyRuntime(root);
  const runtimeManager = {
    state: runtime,
    refreshIfChanged: async (): Promise<RuntimeState> => runtime,
  } as unknown as RuntimeManager;
  return new ExecutionImpl(config, runtimeManager, {
    processRunner: options.processRunner ?? { run: (processOptions) => successfulRun(processOptions) },
    ownershipFactory: options.ownershipFactory,
    storageFaults: options.storageFaults,
    writer: options.writer,
  });
};

const boundedClose = async (execution: ExecutionImpl): Promise<void> => {
  await Promise.race([
    execution.close("shutdown"),
    sleep(1_000).then(() => {
      throw new Error("execution.close did not complete within the bounded test allowance");
    }),
  ]);
};

const execute = (execution: ExecutionImpl, signal: AbortSignal, timeoutMs = 1_000): Promise<ReturnType<ExecutionImpl["execute"]> extends Promise<infer T> ? T : never> =>
  execution.execute("version", { timeoutMs }, { signal } as ExecutionContext) as ReturnType<ExecutionImpl["execute"]>;

test("allocation failure removes the request listener and does not retain active work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-allocation-"));
  const execution = makeExecution(root, { storageFaults: { failAfterWrites: 0 } });
  const signal = new TrackedSignal();
  try {
    const result = await execute(execution, signal.asSignal());
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "unavailable");
    assert.equal(signal.added, 1);
    assert.equal(signal.removed, 1);
    await boundedClose(execution);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("holder startup reports an early validation failure instead of waiting indefinitely", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-startup-failure-"));
  const firstRun = heldRunner();
  const execution = makeExecution(root, { processRunner: firstRun.runner });
  try {
    const first = execute(execution, AbortSignal.any([]), 3_600_001);
    const result = await first;
    assert.equal(result.error?.code, "validation_failed");
    await assert.rejects(waitForRunnerStart(firstRun.entered, first), /ended before runner start.*validation_failed/u);
  } finally {
    firstRun.release();
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("holder startup wait is bounded when neither signal settles", { timeout: 5_000 }, async () => {
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { release = resolve; });
  const operation = new Promise<OperationResult>(() => undefined);
  const rescue = setTimeout(() => release?.(), 100);
  try {
    await assert.rejects(waitForRunnerStart(entered, operation, 25), /did not start within 25 ms/u);
  } finally {
    clearTimeout(rescue);
    release?.();
  }
});

test("cancellation during preparation unregisters the request listener and launches no process", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-cancellation-"));
  const delegate = new AtomicJsonWriter();
  let enteredWrite: (() => void) | undefined;
  const writeEntered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  const writer: JsonWriter = {
    async write(file, value): Promise<void> {
      enteredWrite?.();
      enteredWrite = undefined;
      // Controllable preparation: the initial inventory write is still in flight
      // when the request is cancelled.
      await sleep(60);
      await delegate.write(file, value);
    },
  };
  let launches = 0;
  const execution = makeExecution(root, {
    writer,
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        launches += 1;
        return successfulRun(options);
      },
    },
  });
  const cancelledSignal = new TrackedSignal();
  try {
    const cancelled = execute(execution, cancelledSignal.asSignal(), 1_000);
    await writeEntered;
    cancelledSignal.abort();
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult.status, "cancelled");
    assert.equal(cancelledResult.error?.code, "cancelled");
    assert.equal(launches, 0, "a cancelled operation never launches a process");
    assert.equal(cancelledSignal.added, 1);
    assert.equal(cancelledSignal.removed, 1);
  } finally {
    // Release the request and let any pending call settle before the fixture
    // root is removed, including when an assertion above failed.
    cancelledSignal.abort();
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("an independent call reaches its own process while the first is still running", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-overlap-"));
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEnteredResolve: (() => void) | undefined;
  const secondEntered = new Promise<void>((resolve) => {
    secondEnteredResolve = resolve;
  });
  let entered = 0;
  const execution = makeExecution(root, {
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        entered += 1;
        if (entered === 1) await firstGate;
        else secondEnteredResolve?.();
        return successfulRun(options);
      },
    },
  });
  try {
    const first = execute(execution, AbortSignal.any([]), 2_000);
    const second = execute(execution, AbortSignal.any([]), 2_000);
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    await Promise.race([
      secondEntered,
      sleep(2_000).then(() => {
        throw new Error("the second call never reached the runner while the first was held");
      }),
    ]);
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.success, true);
    assert.equal(secondResult.success, true);
    assert.equal(entered, 2);
  } finally {
    // Release the held gate first, then let close drain every pending call
    // before the fixture root is removed, including when an assertion failed.
    releaseFirst?.();
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("fast success publishes one final versioned record with matching timing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-fast-success-"));
  const writer = new RecordingWriter();
  const execution = makeExecution(root, { writer });
  try {
    const result = await execute(execution, AbortSignal.any([]), 1_000);
    assert.equal(result.success, true);
    assert.equal(result.status, "succeeded");
    assert.equal(writer.terminal.length, 1);
    assert.equal(writer.terminal[0]?.state, "succeeded");

    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.recordVersion, 2);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal("events" in manifest, false);
    assert.equal(manifest.state, result.status);
    assert.equal(manifest.success, result.success);
    assert.deepEqual(manifest.timing, result.timing);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal publication is awaited once without a timeout correction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-publication-"));
  const writer = new RecordingWriter({ delayMs: 220 });
  const execution = makeExecution(root, { writer });
  try {
    const result = await execute(execution, AbortSignal.any([]), 150);
    assert.equal(result.success, true);
    assert.equal(result.status, "succeeded");
    assert.equal(result.persistence.state, "complete");
    assert.equal(writer.terminal.length, 1);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.state, result.status);
    assert.deepEqual(manifest.timing, result.timing);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit timeout during evidence publication uses the same signal and one final record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-evidence-timeout-"));
  const delegate = new AtomicJsonWriter();
  let runSignal: AbortSignal | undefined;
  let finalAttempts = 0;
  const writer: JsonWriter = {
    async write(file, value) {
      const record = value as Record<string, unknown>;
      if (file.endsWith("artifacts.json") && record.complete === true) await sleep(180);
      if (record.recordVersion === 2) finalAttempts += 1;
      await delegate.write(file, value);
    },
  };
  const execution = makeExecution(root, {
    writer,
    processRunner: { run: async (options) => {
      runSignal = options.signal;
      assert.equal(options.timeoutMs, undefined);
      assert.equal(options.deadlineMono, undefined);
      return successfulRun(options);
    } },
  });
  try {
    const result = await execute(execution, AbortSignal.any([]), 100);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(runSignal?.aborted, true);
    assert.deepEqual(runSignal?.reason, { kind: "timeout" });
    assert.equal(finalAttempts, 1);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8"));
    assert.equal(manifest.status, "timed_out");
    assert.equal(manifest.persistence.state, "complete");
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed final publication reports incomplete persistence without fabricating a record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-publication-failure-"));
  const writer = new RecordingWriter({ failFirstTerminal: true });
  const execution = makeExecution(root, { writer });
  try {
    const result = await execute(execution, AbortSignal.any([]));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    assert.equal(writer.terminal.length, 1);
    await assert.rejects(readFile(result.paths.manifest!, "utf8"), { code: "ENOENT" });
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("a write-then-throw final publication reports disagreement without republishing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-publication-uncertain-"));
  const delegate = new AtomicJsonWriter();
  let finalAttempts = 0;
  const writer: JsonWriter = {
    async write(file, value) {
      await delegate.write(file, value);
      if (typeof value === "object" && value !== null && "recordVersion" in value) {
        finalAttempts += 1;
        throw new StorageError("final write completion could not be confirmed");
      }
    },
  };
  const execution = makeExecution(root, { writer });
  try {
    const result = await execute(execution, AbortSignal.any([]));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    assert.equal(finalAttempts, 1);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.recordVersion, 2);
    assert.equal(manifest.success, true);
    assert.notEqual(manifest.status, result.status);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup_failed remains higher priority than a terminal storage failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-execution-cleanup-"));
  const writer = new RecordingWriter({ failFirstTerminal: true });
  const cleanup = {
    state: "unconfirmed" as const,
    trigger: null,
    actions: ["owned cleanup was not confirmed"],
    error: "owned process cleanup was not confirmed",
  };
  const execution = makeExecution(root, {
    writer,
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        return successfulRun(options, cleanup, 1234);
      },
    },
  });
  try {
    const result = await execute(execution, AbortSignal.any([]));
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "cleanup_failed");
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.persistence.state, "incomplete");
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

const controlledVersionOutput = "Godot RE Tools v2.8.0-beta.2\r\n";

interface ControlledVersionOptions {
  readonly readyFailure?: string;
  readonly readyDelayMs?: number;
  readonly exitCode?: number;
}

/**
 * A controlled ownership adapter that launches the version fixture itself.
 * Readiness and the root-exit observation are independent, exactly like the
 * real helper status seam.
 */
const controlledVersionFactory = (options: ControlledVersionOptions = {}): OwnershipFactory =>
  new ScriptedOwnershipFactory(async () => {
    const startedMono = performance.now();
    const rootStartedAtUtc = new Date().toISOString();
    const script = [
      `process.stdout.write(${JSON.stringify(controlledVersionOutput)});`,
      `process.exitCode = ${String(options.exitCode ?? 0)};`,
    ].join("");
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const pid = child.pid ?? null;
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const rootExit = new Promise<OwnershipRootExit>((resolve) => {
      child.once("exit", () => {
        resolve({
          observedAtUtc: new Date().toISOString(),
          elapsedMilliseconds: performance.now() - startedMono,
        });
      });
      child.once("error", () => {
        resolve({ observedAtUtc: null, elapsedMilliseconds: null });
      });
    });
    const completed: OwnershipCompletion = {
      helperExitCode: 0,
      helperSignal: null,
      launchStarted: pid !== null,
      rootPid: pid,
      rootExitObserved: true,
      rootExitCode: options.exitCode ?? 0,
      rootExit: null,
      cleanupConfirmed: true,
      noDescendantsConfirmed: true,
      knownPids: pid === null ? [] : [pid],
      activePids: [],
      stopRequested: false,
      actions: [],
      error: null,
      status: null,
    };
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      ready: options.readyFailure !== undefined
        ? Promise.resolve({
          success: false,
          error: options.readyFailure,
          helperPid: 900,
          rootPid: null,
          rootStartedAtUtc: null,
        })
        : new Promise((resolve) => {
          setTimeout(() => resolve({
            success: true,
            error: null,
            helperPid: 900,
            rootPid: pid,
            rootStartedAtUtc,
          }), options.readyDelayMs ?? 0);
        }),
      rootExit,
      waitForCompletion: async () => {
        await closed;
        const observation = await rootExit;
        return { ...completed, rootExit: observation };
      },
      terminate: async () => {
        // This controlled root exits on its own; give its output time to flush
        // before falling back to a held-handle kill.
        await Promise.race([closed, sleep(5_000)]);
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch { /* already exited */ }
          await Promise.race([closed, sleep(1_000)]);
        }
        const observation = await rootExit;
        return { ...completed, rootExit: observation };
      },
    };
  });

test("unconfirmed cleanup with an unknown root PID fails and blocks later launches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-exec-unknown-pid-"));
  let runs = 0;
  const cleanup = {
    state: "unconfirmed" as const,
    trigger: null,
    actions: [],
    error: "unknown owned process cleanup",
  };
  const execution = makeExecution(root, {
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        runs += 1;
        return successfulRun(options, cleanup, null);
      },
    },
  });
  try {
    const first = await execute(execution, AbortSignal.any([]));
    assert.equal(first.success, false);
    assert.equal(first.status, "failed");
    assert.equal(first.error?.code, "cleanup_failed");
    assert.equal(first.process.pid, null);
    assert.equal(first.cleanup.state, "unconfirmed");

    const second = await execute(execution, AbortSignal.any([]));
    assert.equal(second.success, false);
    assert.equal(second.error?.code, "cleanup_failed");
    assert.equal(second.paths.operation, null);
    assert.equal(runs, 1, "the blocked launch must not reach the process runner");
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed cleanup outranks a concurrent spawn/ownership error and blocks later launches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-exec-cleanup-priority-"));
  let runs = 0;
  const cleanup = {
    state: "unconfirmed" as const,
    trigger: null,
    actions: [],
    error: "owned process cleanup was not confirmed",
  };
  const execution = makeExecution(root, {
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        runs += 1;
        return {
          ...await successfulRun(options, cleanup, 4321),
          spawnError: { code: "ownership_unavailable", message: "ownership helper disappeared" },
        };
      },
    },
  });
  try {
    const first = await execute(execution, AbortSignal.any([]));
    assert.equal(first.success, false);
    assert.equal(first.error?.code, "cleanup_failed");
    assert.equal(first.cleanup.state, "unconfirmed");

    const second = await execute(execution, AbortSignal.any([]));
    assert.equal(second.error?.code, "cleanup_failed");
    assert.equal(second.paths.operation, null);
    assert.equal(runs, 1);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("a genuine no-launch failure stays not_needed and does not quarantine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-exec-no-launch-"));
  let runs = 0;
  const noLaunch = {
    state: "not_needed" as const,
    trigger: null,
    actions: [],
    error: null,
  };
  const execution = makeExecution(root, {
    processRunner: {
      async run(options): Promise<ProcessRunResult> {
        runs += 1;
        if (runs === 1) {
          return {
            ...await successfulRun(options, noLaunch, null),
            spawnError: { code: "ownership_unavailable", message: "helper could not be started" },
            error: "helper could not be started",
          };
        }
        return successfulRun(options, noLaunch, null);
      },
    },
  });
  try {
    const first = await execute(execution, AbortSignal.any([]));
    assert.equal(first.success, false);
    assert.equal(first.error?.code, "spawn_failed");
    assert.equal(first.cleanup.state, "not_needed");

    const second = await execute(execution, AbortSignal.any([]));
    assert.equal(second.success, true, JSON.stringify(second.error));
    assert.equal(runs, 2);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("a readiness/ownership error fails version evaluation despite valid text and confirmed cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-exec-ready-failure-"));
  const execution = makeExecution(root, {
    processRunner: new NodeProcessRunner(),
    ownershipFactory: controlledVersionFactory({
      readyFailure: "ownership helper did not confirm the owned launch",
      exitCode: 1,
    }),
  });
  try {
    const result = await execute(execution, AbortSignal.any([]), 5_000);
    assert.equal(result.success, false, JSON.stringify(result.error));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "spawn_failed");
    assert.match(result.error?.message ?? "", /did not confirm the owned launch/u);
    assert.equal(result.process.pid !== null, true);
    assert.equal(result.cleanup.state, "confirmed");
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});

test("delayed readiness does not invert or zero the recorded process interval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-exec-timing-"));
  const execution = makeExecution(root, {
    processRunner: new NodeProcessRunner(),
    ownershipFactory: controlledVersionFactory({ readyDelayMs: 700, exitCode: 0 }),
  });
  try {
    const result = await execute(execution, AbortSignal.any([]), 5_000);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(typeof result.timing.processMs, "number");
    assert.ok(result.timing.processMs! > 0, `processMs=${String(result.timing.processMs)}`);
    assert.notEqual(result.timing.startedAt, null);
    assert.notEqual(result.timing.processExitedAt, null);
    assert.ok(Date.parse(result.timing.processExitedAt!) >= Date.parse(result.timing.startedAt!));
    assert.equal(result.process.pid !== null, true);
  } finally {
    await boundedClose(execution);
    await rm(root, { recursive: true, force: true });
  }
});
