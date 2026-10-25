import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { boundedUtf8 } from "./text.js";

export type CleanupTrigger = "cancel" | "timeout" | "disconnect" | "shutdown" | "storage";

export interface OwnedLaunchRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface OwnershipReady {
  readonly success: boolean;
  readonly error: string | null;
  readonly helperPid: number | null;
  /** Root PID reported by the helper; null until the root is actually created. */
  readonly rootPid: number | null;
  /** Native creation timestamp for the root; null when the helper did not report it. */
  readonly rootStartedAtUtc: string | null;
}

export interface OwnershipRootExit {
  readonly observedAtUtc: string | null;
  /** Monotonic root lifetime measured by the native helper. */
  readonly elapsedMilliseconds: number | null;
}

export interface OwnershipCompletion {
  readonly helperExitCode: number | null;
  readonly helperSignal: string | null;
  /**
   * true: the root is known to have started; false: native evidence explicitly
   * shows no root was created; null: the launch outcome is unknown.
   */
  readonly launchStarted: boolean | null;
  readonly rootPid: number | null;
  readonly rootExitObserved: boolean;
  readonly rootExitCode: number | null;
  readonly rootExit: OwnershipRootExit | null;
  readonly cleanupConfirmed: boolean;
  readonly noDescendantsConfirmed: boolean;
  readonly knownPids: readonly number[];
  readonly activePids: readonly number[] | null;
  readonly stopRequested: boolean;
  /** Actions this handle actually performed; never planned or inferred actions. */
  readonly actions: readonly string[];
  readonly error: string | null;
  readonly status: Record<string, unknown> | null;
}

export interface OwnershipHandle {
  /** The helper's forwarded root output. Null when the helper has no such stream. */
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** Resolves once the root process exists and is owned by the helper's Job. */
  readonly ready: Promise<OwnershipReady>;
  /**
   * Resolves once the helper observes the root's exit. It stays pending when
   * the helper closes without that observation and never rejects.
   */
  readonly rootExit: Promise<OwnershipRootExit>;
  waitForCompletion(): Promise<OwnershipCompletion>;
  terminate(trigger: CleanupTrigger): Promise<OwnershipCompletion>;
}

export interface OwnershipFactory {
  launch(request: OwnedLaunchRequest, statusPath: string): Promise<OwnershipHandle>;
}

const bounded = (value: unknown, fallback: string): string => boundedUtf8(value, fallback);

const powershellPath = (): string =>
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

/** Compile the helper once before a short-lived root process is spawned. */
export async function prepareNativeOwnershipHelper(helperScriptPath: string): Promise<string> {
  const directory = path.dirname(path.resolve(helperScriptPath));
  const prepareScriptPath = path.join(directory, "prepare-gdre-job-object.ps1");
  const assemblyPath = path.join(directory, "gdre-job-object.dll");
  const child = spawn(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", prepareScriptPath, "-OutputPath", assemblyPath],
    { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  const result = await waitChild(child, 30_000);
  if (result.timedOut) {
    // The compiler child is held by this handle. Terminate it and reap the
    // close event before reporting failure, rather than leaving it running.
    try {
      child.kill();
    } catch {
      // It may have exited between the timeout and this kill.
    }
    if (child.exitCode === null && child.signalCode === null) {
      await waitChild(child, 5_000);
    }
    const exited = child.exitCode !== null || child.signalCode !== null;
    throw new Error(exited
      ? "Windows Job Object helper compilation timed out; compiler exit was observed after requesting termination"
      : "Windows Job Object helper compilation timed out and the held compiler process did not exit after termination was requested");
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error("Windows Job Object helper compilation failed before runtime startup");
  }
  return assemblyPath;
}

const readStatus = async (statusPath: string): Promise<Record<string, unknown> | null> => {
  try {
    const source = await fs.readFile(statusPath, "utf8");
    const value: unknown = JSON.parse(source);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asBoolean = (record: Record<string, unknown> | null, key: string): boolean =>
  record?.[key] === true;

const asNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNonNegativeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item))
    : [];

const statusState = (status: Record<string, unknown> | null): string =>
  typeof status?.state === "string" ? status.state : "";

const isTerminalState = (status: Record<string, unknown> | null): boolean => {
  const state = statusState(status);
  return state === "completed" || state === "stopped" || state === "cancelled" || state === "failed";
};

const statusCompletion = (
  status: Record<string, unknown> | null,
  helperExitCode: number | null,
  helperSignal: string | null,
  fallbackError: string | null = null,
  actions: readonly string[] = [],
): OwnershipCompletion => {
  const launch = asRecord(status?.launch);
  const attach = asRecord(status?.attach);
  const root = asRecord(status?.root);
  const stop = asRecord(status?.stop);
  const cleanup = asRecord(status?.cleanup);
  const active = cleanup?.activeJobPids;
  const activePids = Array.isArray(active) ? asNumberArray(active) : null;
  const cleanupState = typeof cleanup?.state === "string" ? cleanup.state : "";
  // Job membership comes from creation; cleanup confirmation still needs
  // consistent native evidence. An enumeration failure is unknown, not empty.
  const cleanupConfirmed =
    asBoolean(cleanup, "confirmed") &&
    cleanupState === "confirmed" &&
    cleanup?.error == null &&
    Array.isArray(active) &&
    active.length === 0;
  const launchStarted = asBoolean(launch, "started") || asBoolean(attach, "success")
    ? true
    : status !== null
      && launch !== null
      && launch.started === false
      && (statusState(status) === "cancelled" || statusState(status) === "failed")
      ? false
      : null;
  const rootPidValue = asNullableNumber(launch?.rootPid) ?? asNullableNumber(root?.pid);
  const rootPid = rootPidValue !== null && rootPidValue > 0 ? rootPidValue : null;
  const rootExitObserved = asBoolean(root, "exitObserved");
  const rootExitCode = rootExitObserved ? asNullableNumber(root?.exitCode) : null;
  const rootExit: OwnershipRootExit | null = rootExitObserved
    ? {
      observedAtUtc: asNullableString(root?.observedAtUtc),
      elapsedMilliseconds: asNonNegativeNumber(root?.elapsedMilliseconds),
    }
    : null;
  const knownPids = asNumberArray(status?.knownPids);
  const failure =
    typeof status?.failure === "string"
      ? status.failure
      : typeof cleanup?.error === "string"
        ? cleanup.error
        : typeof attach?.error === "string"
          ? attach.error
          : fallbackError;
  return {
    helperExitCode,
    helperSignal,
    launchStarted,
    rootPid,
    rootExitObserved,
    rootExitCode,
    rootExit,
    cleanupConfirmed,
    noDescendantsConfirmed: cleanupConfirmed,
    knownPids,
    activePids,
    stopRequested: asBoolean(stop, "requested"),
    actions,
    error: failure,
    status,
  };
};

const waitChild = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean }> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut });
    };
    const timer = setTimeout(() => finish(null, null, true), timeoutMs);
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => finish(exitCode, signal));
    child.once("error", () => finish(null, null));
  });

export interface NativeOwnershipOptions {
  readonly helperScriptPath: string;
  readonly powershellPath?: string;
  readonly helperReadyTimeoutMs?: number;
}

/**
 * Starts the Windows helper that creates the root with PROC_THREAD_ATTRIBUTE_JOB_LIST,
 * so Job ownership begins with process creation. The initial launch request travels
 * over the helper's private stdin pipe; the same pipe carries cooperative stop and
 * closes on Node death. Root stdout/stderr are forwarded through the helper's
 * inherited handles.
 */
export class NativeOwnershipFactory implements OwnershipFactory {
  private readonly helperScriptPath: string;
  private readonly helperPowershellPath: string;
  private readonly helperReadyTimeoutMs: number;

  public constructor(options: NativeOwnershipOptions) {
    this.helperScriptPath = path.resolve(options.helperScriptPath);
    this.helperPowershellPath = options.powershellPath ?? powershellPath();
    this.helperReadyTimeoutMs = options.helperReadyTimeoutMs ?? 10_000;
  }

  public async launch(request: OwnedLaunchRequest, statusPath: string): Promise<OwnershipHandle> {
    const helper = spawn(
      this.helperPowershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.helperScriptPath,
        "-StatusPath",
        statusPath,
      ],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const handle = new NativeOwnershipHandle(helper, statusPath, this.helperReadyTimeoutMs);
    // Flush the initial request without blocking the caller. A slow or
    // non-reading helper must not delay cancellation and readiness handling;
    // write errors are captured on the handle for completion evidence.
    handle.startLaunch(request);
    return handle;
  }
}

class NativeOwnershipHandle implements OwnershipHandle {
  public readonly stdout: Readable | null;
  public readonly stderr: Readable | null;
  public readonly ready: Promise<OwnershipReady>;
  public readonly rootExit: Promise<OwnershipRootExit>;
  private readonly helper: ChildProcess;
  private readonly statusPath: string;
  private readonly closed: Promise<void>;
  private closeResolve: (() => void) | undefined;
  private helperClosed = false;
  private helperExitCode: number | null = null;
  private helperSignal: string | null = null;
  private helperError: string | null = null;
  private completion: Promise<OwnershipCompletion> | null = null;
  private termination: Promise<OwnershipCompletion> | null = null;
  private stopDelivered = false;
  private helperKilled = false;
  private stopError: string | null = null;
  private readyResolved = false;
  private readyResolve: ((value: OwnershipReady) => void) | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private rootExitResolved = false;
  private rootExitResolve: ((value: OwnershipRootExit) => void) | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollingStopped = false;
  private closeFinalized = false;

  public constructor(helper: ChildProcess, statusPath: string, readyTimeoutMs: number) {
    this.helper = helper;
    this.statusPath = statusPath;
    this.stdout = helper.stdout;
    this.stderr = helper.stderr;
    this.closed = new Promise<void>((resolve) => {
      this.closeResolve = resolve;
    });
    this.ready = new Promise<OwnershipReady>((resolve) => {
      this.readyResolve = resolve;
    });
    this.rootExit = new Promise<OwnershipRootExit>((resolve) => {
      this.rootExitResolve = resolve;
    });
    // Listeners are installed at creation so a fast helper exit is never missed.
    helper.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.helperClosed = true;
      this.helperExitCode = code;
      this.helperSignal = signal;
      this.stopPolling();
      void this.finalizeClose();
    });
    helper.once("error", (error: Error) => {
      this.helperClosed = true;
      this.helperError = bounded(error, "ownership helper spawn failed");
      this.helperExitCode = null;
      this.helperSignal = null;
      this.stopPolling();
      void this.finalizeClose();
    });
    helper.stdin?.on("error", () => {
      // A closed control pipe is expected during stop/EOF races; completion
      // evidence comes from status and the helper exit, not this write error.
    });
    this.readyTimer = setTimeout(() => {
      if (this.readyResolved) return;
      this.resolveReady({
        success: false,
        error: "ownership helper did not confirm root creation within the bounded deadline",
        helperPid: helper.pid ?? null,
        rootPid: null,
        rootStartedAtUtc: null,
      });
    }, Math.max(1, readyTimeoutMs));
    this.readyTimer.unref();
    this.startPolling();
  }

  public startLaunch(request: OwnedLaunchRequest): void {
    const stdin = this.helper.stdin;
    if (stdin === null || stdin === undefined) {
      this.helperError ??= "ownership helper control pipe is unavailable";
      return;
    }
    const env: [string, string][] = [];
    for (const [name, value] of Object.entries(request.env)) {
      if (value !== undefined) env.push([name, value]);
    }
    // One base64 UTF-8 JSON line carries the launch data. The helper decodes
    // and parses it; it is never evaluated as code or persisted to disk. The
    // environment travels as name/value pairs because PowerShell's JSON
    // dictionary parsing is case-insensitive and would reject "Path"/"PATH".
    const payload = Buffer.from(JSON.stringify({
      executable: request.executable,
      argv: [...request.argv],
      cwd: request.cwd,
      env,
    }), "utf8").toString("base64");
    try {
      stdin.write(`${payload}\n`, (error) => {
        if (error) this.helperError ??= bounded(error, "launch request could not be sent");
      });
    } catch (error) {
      this.helperError ??= bounded(error, "launch request could not be sent");
    }
  }

  private startPolling(): void {
    const poll = async (): Promise<void> => {
      if (this.pollingStopped) return;
      const status = await readStatus(this.statusPath);
      if (this.pollingStopped) return;
      this.applyStatus(status);
      if (!this.pollingStopped) {
        this.pollTimer = setTimeout(() => {
          void poll();
        }, 25);
        this.pollTimer.unref();
      }
    };
    void poll();
  }

  private stopPolling(): void {
    this.pollingStopped = true;
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private applyStatus(status: Record<string, unknown> | null): void {
    if (status === null) return;
    const launch = asRecord(status.launch);
    const root = asRecord(status.root);
    const rootPid = asNullableNumber(launch?.rootPid);
    if (!this.readyResolved && asBoolean(launch, "started") && rootPid !== null && rootPid > 0) {
      this.resolveReady({
        success: true,
        error: null,
        helperPid: this.helper.pid ?? null,
        rootPid,
        rootStartedAtUtc: asNullableString(launch?.startedAtUtc),
      });
    } else if (!this.readyResolved) {
      const state = typeof status.state === "string" ? status.state : "";
      if (state === "failed" || state === "cancelled") {
        this.resolveReady({
          success: false,
          error: typeof status.failure === "string"
            ? status.failure
            : state === "cancelled"
              ? "cancellation was requested before the root process was created"
              : "ownership helper reported a launch failure",
          helperPid: this.helper.pid ?? null,
          rootPid: null,
          rootStartedAtUtc: null,
        });
      }
    }

    if (!this.rootExitResolved && asBoolean(launch, "started") && asBoolean(root, "exitObserved")) {
      this.rootExitResolved = true;
      this.rootExitResolve?.({
        observedAtUtc: asNullableString(root?.observedAtUtc),
        elapsedMilliseconds: asNonNegativeNumber(root?.elapsedMilliseconds),
      });
      this.rootExitResolve = undefined;
    }
  }

  private resolveReady(value: OwnershipReady): void {
    if (this.readyResolved) return;
    this.readyResolved = true;
    if (this.readyTimer !== undefined) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.readyResolve?.(value);
    this.readyResolve = undefined;
  }

  private async finalizeClose(): Promise<void> {
    if (this.closeFinalized) return;
    this.closeFinalized = true;
    const status = await readStatus(this.statusPath);
    this.applyStatus(status);
    if (!this.readyResolved) {
      this.resolveReady({
        success: false,
        error: this.helperError
          ?? (typeof status?.failure === "string"
            ? status.failure
            : "ownership helper exited before the root process was created"),
        helperPid: this.helper.pid ?? null,
        rootPid: null,
        rootStartedAtUtc: null,
      });
    }
    this.closeResolve?.();
    this.closeResolve = undefined;
  }

  public async waitForCompletion(): Promise<OwnershipCompletion> {
    await this.closed;
    return this.resolveCompletion();
  }

  public async terminate(trigger: CleanupTrigger): Promise<OwnershipCompletion> {
    if (this.termination === null) this.termination = this.performTermination(trigger);
    return this.termination;
  }

  private async performTermination(trigger: CleanupTrigger): Promise<OwnershipCompletion> {
    const stdin = this.helper.stdin;
    if (!this.helperClosed && stdin !== null && stdin !== undefined && !stdin.destroyed) {
      try {
        stdin.write(`${trigger}\n`);
        this.stopDelivered = true;
      } catch (error) {
        this.stopError ??= bounded(error, "cooperative stop could not be sent");
      }
      try {
        stdin.end();
      } catch {
        // EOF is a best-effort second signal; the helper may already be gone.
      }
    }

    if (!this.helperClosed) {
      const graceful = await this.waitForClose(5_000);
      if (!graceful) {
        // This is an identity-backed handle kill on the child Node spawned,
        // never a PID lookup. Closing the helper closes its Job handle and the
        // kernel then enforces kill-on-job-close.
        try {
          this.helperKilled = this.helper.kill();
        } catch {
          // The helper may already be gone; helper exit evidence decides.
        }
        const forced = await this.waitForClose(5_000);
        if (!forced) {
          this.stopError ??= "the ownership helper did not exit after the bounded stop request";
        }
      }
    }

    return this.resolveCompletion();
  }

  private async waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.helperClosed) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    });
    const result = await Promise.race([this.closed.then(() => true), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  private resolveCompletion(): Promise<OwnershipCompletion> {
    if (this.completion === null) {
      this.completion = (async (): Promise<OwnershipCompletion> => {
        const status = await readStatus(this.statusPath);
        // Ensure the root-exit observation reflects the final status even when
        // the helper closed before the last poll read it.
        this.applyStatus(status);
        const actions: string[] = [];
        if (this.stopDelivered) actions.push("requested a cooperative stop through the helper control pipe");
        if (this.helperKilled) actions.push("terminated the held helper process after it did not exit");
        if (status === null && this.helperError === null) {
          actions.push("observed the helper exit without readable status evidence");
        }
        const fallback = this.helperError
          ?? this.stopError
          ?? (status === null
            ? "ownership helper exited without publishing status evidence"
            : isTerminalState(status)
              ? null
              : "ownership helper exited before reporting a terminal status; cleanup is unconfirmed");
        if (fallback !== null && !isTerminalState(status)) {
          actions.push(`observed the helper exit before a terminal status (last state: ${statusState(status)})`);
        }
        return statusCompletion(status, this.helperExitCode, this.helperSignal, fallback, actions);
      })();
    }
    return this.completion;
  }
}

/** A deterministic fault seam for tests; never used by production execution. */
export class ScriptedOwnershipFactory implements OwnershipFactory {
  private readonly factory: (request: OwnedLaunchRequest, statusPath: string) => Promise<OwnershipHandle>;

  public constructor(factory: (request: OwnedLaunchRequest, statusPath: string) => Promise<OwnershipHandle>) {
    this.factory = factory;
  }

  public launch(request: OwnedLaunchRequest, statusPath: string): Promise<OwnershipHandle> {
    return this.factory(request, statusPath);
  }
}

export { readStatus, statusCompletion };
