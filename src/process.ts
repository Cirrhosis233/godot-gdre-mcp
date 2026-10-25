import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import {
  NativeOwnershipFactory,
  type CleanupTrigger,
  type OwnedLaunchRequest,
  type OwnershipCompletion,
  type OwnershipFactory,
  type OwnershipHandle,
  type OwnershipReady,
  type OwnershipRootExit,
} from "./process-tree.js";
import { DurableFileStreamSink } from "./streams.js";
import type { StreamPaths, StreamSink } from "./streams.js";
import { boundedUtf8 } from "./text.js";

export type { StreamPaths, StreamSink } from "./streams.js";

// Kept local rather than adding a public schema type to the registry layer.
export interface StreamSummaryValue {
  readonly bytes: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly utf8Valid: boolean;
  readonly rawPath: string | null;
  readonly textPath: string | null;
  readonly complete: boolean;
}

export interface ProcessRunOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Absolute performance.now() execution deadline, when the caller owns one. */
  readonly deadlineMono?: number;
  readonly streamPaths: StreamPaths;
  readonly signal?: AbortSignal;
  readonly statusPath: string;
  readonly ownershipFactory?: OwnershipFactory;
  readonly helperScriptPath?: string;
  readonly sink?: StreamSink;
  /** Exact caller-known secret values redacted from bounded previews only. */
  readonly redactSecrets?: readonly string[];
}

export interface ProcessCleanup {
  readonly state: "not_needed" | "confirmed" | "unconfirmed";
  readonly trigger: CleanupTrigger | null;
  readonly actions: readonly string[];
  readonly error: string | null;
}

export interface ProcessRunResult {
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: { readonly code: string; readonly message: string } | null;
  readonly timedOut: boolean;
  readonly trigger: CleanupTrigger | null;
  readonly exitObserved: boolean;
  readonly spawnedAt: string | null;
  readonly spawnedAtMono: number | null;
  readonly exitedAt: string | null;
  readonly exitedAtMono: number | null;
  readonly stdout: StreamSummaryValue;
  readonly stderr: StreamSummaryValue;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly ownership: OwnershipCompletion | null;
  readonly cleanup: ProcessCleanup;
  readonly captureError: string | null;
  readonly storageError: string | null;
  readonly error: string | null;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}

const MAX_PREVIEW_BYTES = 8192;
const PREVIEW_SOURCE_EXTRA_BYTES = 8;
const TRUNCATION_MARKER = "\n...[truncated]...\n";
const DRAIN_AFTER_COMPLETION_MS = 2_000;
const NATURAL_COMPLETION_WAIT_MS = 15_000;

const bounded = (value: unknown, fallback = "process error"): string => boundedUtf8(value, fallback);

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

interface HeadTake {
  readonly text: string;
  readonly bytes: number;
  readonly end: number;
}

interface TailTake {
  readonly text: string;
  readonly bytes: number;
  readonly start: number;
}

const takeHead = (value: string, budget: number): HeadTake => {
  if (budget <= 0) return { text: "", bytes: 0, end: 0 };
  let result = "";
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const nextBytes = byteLength(character);
    if (bytes + nextBytes > budget) break;
    result += character;
    bytes += nextBytes;
    end += character.length;
  }
  return { text: result, bytes, end };
};

const takeTail = (value: string, budget: number): TailTake => {
  if (budget <= 0) return { text: "", bytes: 0, start: value.length };
  let result = "";
  let bytes = 0;
  let start = value.length;
  for (let end = value.length; end > 0;) {
    let characterStart = end - 1;
    const last = value.charCodeAt(characterStart);
    if (last >= 0xdc00 && last <= 0xdfff && characterStart > 0) {
      const previous = value.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) characterStart -= 1;
    }
    const character = value.slice(characterStart, end);
    const nextBytes = byteLength(character);
    if (bytes + nextBytes > budget) break;
    result = character + result;
    bytes += nextBytes;
    start = characterStart;
    end = characterStart;
  }
  return { text: result, bytes, start };
};

const renderPreview = (prefix: string, suffix: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } => {
  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (markerBytes >= maxBytes) return { text: takeHead(TRUNCATION_MARKER, maxBytes).text, truncated: true };
  const available = maxBytes - markerBytes;
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;
  const initialHead = takeHead(prefix, headBudget);
  const initialTail = takeTail(suffix, tailBudget);
  let head = initialHead.text;
  let tail = initialTail.text;
  let remaining = available - initialHead.bytes - initialTail.bytes;
  // A code-point boundary can leave a few bytes unused on either side. Reuse
  // those bytes without ever splitting a UTF-16 surrogate pair.
  if (remaining > 0) {
    const extraHead = takeHead(prefix.slice(initialHead.end), remaining);
    head += extraHead.text;
    remaining -= extraHead.bytes;
  }
  if (remaining > 0) {
    const extraTail = takeTail(suffix.slice(0, initialTail.start), remaining);
    tail = `${extraTail.text}${tail}`;
  }
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
};

/** Incrementally retain only the bounded prefix and suffix needed for a preview. */
class IncrementalPreviewCapture {
  private readonly maxBytes: number;
  private readonly prefix: string[] = [];
  private readonly suffix: string[] = [];
  private prefixBytes = 0;
  private suffixBytes = 0;
  private suffixStart = 0;
  private totalBytes = 0;
  private prefixClosed = false;
  private pendingHighSurrogate = "";
  private finished = false;

  public constructor(maxBytes = MAX_PREVIEW_BYTES) {
    this.maxBytes = maxBytes;
  }

  public push(value: string): void {
    if (this.finished || value.length === 0 && this.pendingHighSurrogate.length === 0) return;
    const chunk = this.pendingHighSurrogate.length === 0 ? value : `${this.pendingHighSurrogate}${value}`;
    this.pendingHighSurrogate = "";
    for (let index = 0; index < chunk.length;) {
      const code = chunk.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 === chunk.length) {
        this.pendingHighSurrogate = chunk.slice(index);
        break;
      }
      const isPair = code >= 0xd800 && code <= 0xdbff
        && index + 1 < chunk.length
        && chunk.charCodeAt(index + 1) >= 0xdc00
        && chunk.charCodeAt(index + 1) <= 0xdfff;
      const character = chunk.slice(index, index + (isPair ? 2 : 1));
      this.consume(character);
      index += character.length;
    }
  }

  public finish(): { readonly text: string; readonly truncated: boolean } {
    if (!this.finished) {
      this.finished = true;
      if (this.pendingHighSurrogate.length > 0) {
        this.consume(this.pendingHighSurrogate);
        this.pendingHighSurrogate = "";
      }
    }
    if (this.totalBytes <= this.maxBytes) return { text: this.prefix.join(""), truncated: false };
    return renderPreview(this.prefix.join(""), this.suffix.slice(this.suffixStart).join(""), this.maxBytes);
  }

  private consume(character: string): void {
    const characterBytes = byteLength(character);
    this.totalBytes += characterBytes;
    if (!this.prefixClosed) {
      if (this.prefixBytes + characterBytes <= this.maxBytes + PREVIEW_SOURCE_EXTRA_BYTES) {
        this.prefix.push(character);
        this.prefixBytes += characterBytes;
      } else {
        this.prefixClosed = true;
      }
    }

    // Keep a few extra bytes on each side so boundary reallocation can use
    // the complete 8192-byte budget without retaining the full output.
    const suffixLimit = Math.max(0, this.maxBytes) + PREVIEW_SOURCE_EXTRA_BYTES;
    this.suffix.push(character);
    this.suffixBytes += characterBytes;
    while (this.suffixBytes > suffixLimit) {
      const removed = this.suffix[this.suffixStart];
      if (removed === undefined) break;
      this.suffixStart += 1;
      this.suffixBytes -= byteLength(removed);
    }
    if (this.suffixStart > 1_024 && this.suffixStart * 2 > this.suffix.length) {
      this.suffix.splice(0, this.suffixStart);
      this.suffixStart = 0;
    }
  }
}

/** Return a UTF-8-byte-bounded head/marker/tail preview. */
export function boundedPreview(value: string, maxBytes = MAX_PREVIEW_BYTES): { readonly text: string; readonly truncated: boolean } {
  const capture = new IncrementalPreviewCapture(maxBytes);
  capture.push(value);
  return capture.finish();
}

class SinkWriteFailure extends Error {
  public constructor(cause: unknown) {
    super(bounded(cause, "stream storage failed"), { cause });
    this.name = "SinkWriteFailure";
  }
}

interface CapturedStream {
  readonly bytes: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly utf8Valid: boolean;
  readonly complete: boolean;
  readonly error: string | null;
  readonly storageError: string | null;
}

const failedCapture = (error: string, storageError: string | null = null): CapturedStream => ({
  bytes: 0,
  preview: "",
  truncated: false,
  utf8Valid: true,
  complete: false,
  error,
  storageError,
});

/** Fold ASCII letters without Unicode expansions so indices stay aligned with the original text. */
const asciiFold = (value: string): string => value.replace(/[A-Z]/gu, (character) =>
  String.fromCharCode(character.charCodeAt(0) + 0x20),
);

class PreviewRedactor {
  private pending = "";
  private readonly secrets: readonly string[];
  private readonly foldedSecrets: readonly string[];

  public constructor(secrets: readonly string[] = []) {
    this.secrets = secrets.filter((value) => value.length > 0);
    this.foldedSecrets = this.secrets.map(asciiFold);
  }

  public push(value: string): string {
    if (this.secrets.length === 0) return value;
    let work = `${this.pending}${value}`;
    let output = "";
    while (work.length > 0) {
      const foldedWork = asciiFold(work);
      let matchIndex = -1;
      let matchLength = 0;
      for (let index = 0; index < this.foldedSecrets.length; index += 1) {
        const candidate = this.foldedSecrets[index]!;
        const found = foldedWork.indexOf(candidate);
        if (found >= 0 && (matchIndex < 0 || found < matchIndex)) {
          matchIndex = found;
          matchLength = this.secrets[index]!.length;
        }
      }
      if (matchIndex < 0) {
        const hold = this.longestSecretPrefixSuffix(work);
        let safeLength = work.length - hold;
        if (safeLength > 0) {
          const previous = work.charCodeAt(safeLength - 1);
          if (previous >= 0xd800 && previous <= 0xdbff) safeLength -= 1;
        }
        output += work.slice(0, safeLength);
        work = work.slice(safeLength);
        break;
      }
      output += work.slice(0, matchIndex);
      output += "<redacted>";
      work = work.slice(matchIndex + matchLength);
    }
    this.pending = work;
    return output;
  }

  public finish(): string {
    const output = this.push("") + this.pending;
    this.pending = "";
    return output;
  }

  private longestSecretPrefixSuffix(value: string): number {
    const foldedValue = asciiFold(value);
    let longest = 0;
    for (const secret of this.foldedSecrets) {
      const max = Math.min(secret.length - 1, foldedValue.length);
      for (let length = max; length > longest; length -= 1) {
        if (foldedValue.endsWith(secret.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }
}

const capture = async (
  readable: NodeJS.ReadableStream,
  kind: "stdout" | "stderr",
  sink: StreamSink,
  redactSecrets?: readonly string[],
): Promise<CapturedStream> => {
  const decoder = new StringDecoder("utf8");
  const validator = new TextDecoder("utf-8", { fatal: true });
  const previewCapture = new IncrementalPreviewCapture();
  const previewRedactor = new PreviewRedactor(redactSecrets);
  let bytes = 0;
  let utf8Valid = true;
  const append = async (raw: Buffer, decoded: string): Promise<void> => {
    try {
      await sink.append(kind, raw, decoded);
    } catch (error) {
      throw new SinkWriteFailure(error);
    }
  };
  try {
    for await (const rawChunk of readable as AsyncIterable<Buffer | string>) {
      const raw = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      bytes += raw.byteLength;
      try {
        validator.decode(raw, { stream: true });
      } catch {
        utf8Valid = false;
      }
      const decoded = decoder.write(raw);
      previewCapture.push(previewRedactor.push(decoded));
      await append(raw, decoded);
    }
    const finalText = decoder.end();
    previewCapture.push(previewRedactor.push(finalText));
    previewCapture.push(previewRedactor.finish());
    try {
      validator.decode(new Uint8Array(), { stream: false });
    } catch {
      utf8Valid = false;
    }
    if (finalText.length > 0) await append(Buffer.alloc(0), finalText);
    const preview = previewCapture.finish();
    return { bytes, preview: preview.text, truncated: preview.truncated, utf8Valid, complete: true, error: null, storageError: null };
  } catch (error) {
    const preview = previewCapture.finish();
    const storage = error instanceof SinkWriteFailure;
    return {
      bytes,
      preview: preview.text,
      truncated: preview.truncated,
      utf8Valid,
      complete: false,
      error: bounded(error, `${kind} capture failed`),
      storageError: storage ? bounded(error, `${kind} stream storage failed`) : null,
    };
  }
};

export const emptySummary = (rawPath: string | null = null, textPath: string | null = null): StreamSummaryValue => ({
  bytes: 0,
  text: "",
  truncated: false,
  utf8Valid: true,
  rawPath,
  textPath,
  complete: rawPath !== null && textPath !== null,
});

const toSummary = (captured: CapturedStream, rawPath: string, textPath: string): StreamSummaryValue => ({
  bytes: captured.bytes,
  text: captured.preview,
  truncated: captured.truncated,
  utf8Valid: captured.utf8Valid,
  rawPath,
  textPath,
  complete: captured.complete,
});

const withTimeout = <T>(promise: Promise<T>, milliseconds: number, fallback: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback());
    }, Math.max(0, milliseconds));
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback());
    });
  });

const unavailableOwnership: OwnershipFactory = {
  async launch(): Promise<OwnershipHandle> {
    const completion: OwnershipCompletion = {
      helperExitCode: null,
      helperSignal: null,
      launchStarted: false,
      rootPid: null,
      rootExitObserved: false,
      rootExitCode: null,
      rootExit: null,
      cleanupConfirmed: false,
      noDescendantsConfirmed: false,
      knownPids: [],
      activePids: null,
      stopRequested: false,
      actions: [],
      error: "Windows Job Object helper is unavailable",
      status: null,
    };
    return {
      stdout: null,
      stderr: null,
      ready: Promise.resolve({
        success: false,
        error: completion.error,
        helperPid: null,
        rootPid: null,
        rootStartedAtUtc: null,
      }),
      rootExit: new Promise(() => undefined),
      waitForCompletion: async () => completion,
      terminate: async () => completion,
    };
  },
};

const makeDefaultOwnership = (helperScriptPath: string | undefined): OwnershipFactory =>
  helperScriptPath === undefined ? unavailableOwnership : new NativeOwnershipFactory({ helperScriptPath });

const abortTrigger = (reason: unknown): CleanupTrigger => {
  if (typeof reason === "string" && (reason === "disconnect" || reason === "shutdown")) return reason;
  if (reason && typeof reason === "object" && "kind" in reason) {
    const kind = (reason as { readonly kind?: unknown }).kind;
    if (kind === "disconnect" || kind === "shutdown" || kind === "timeout") return kind;
  }
  return "cancel";
};

export class NodeProcessRunner implements ProcessRunner {
  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const runEntryMono = performance.now();
    const isAborted = (): boolean => options.signal !== undefined && options.signal.aborted;
    const deadlineMono = options.deadlineMono ?? (options.timeoutMs === undefined ? undefined : runEntryMono + options.timeoutMs);
    const sink = options.sink ?? new DurableFileStreamSink(options.streamPaths);
    const ownedSink = options.sink === undefined ? sink as DurableFileStreamSink : undefined;
    const closeOwnedSink = async (): Promise<void> => {
      if (ownedSink !== undefined) await ownedSink.close().catch(() => undefined);
    };
    const spawnFailure = async (
      error: string,
      code: string,
      spawnError: { readonly code: string; readonly message: string } | null = null,
      cleanupError: string | null = error,
    ): Promise<ProcessRunResult> => {
      await closeOwnedSink();
      return {
        pid: null,
        exitCode: null,
        signal: null,
        spawnError: spawnError ?? { code, message: error },
        timedOut: false,
        trigger: null,
        exitObserved: false,
        spawnedAt: null,
        spawnedAtMono: null,
        exitedAt: null,
        exitedAtMono: null,
        stdout: emptySummary(options.streamPaths.stdoutBin, options.streamPaths.stdoutText),
        stderr: emptySummary(options.streamPaths.stderrBin, options.streamPaths.stderrText),
        stdoutText: "",
        stderrText: "",
        ownership: null,
        cleanup: { state: "not_needed", trigger: null, actions: [], error: cleanupError },
        captureError: null,
        storageError: null,
        error,
      };
    };

    const cancellationBeforeSpawn = async (): Promise<ProcessRunResult> => {
      await closeOwnedSink();
      const trigger = abortTrigger(options.signal?.reason);
      return {
        pid: null,
        exitCode: null,
        signal: null,
        spawnError: null,
        timedOut: trigger === "timeout",
        trigger,
        exitObserved: false,
        spawnedAt: null,
        spawnedAtMono: null,
        exitedAt: null,
        exitedAtMono: null,
        stdout: emptySummary(options.streamPaths.stdoutBin, options.streamPaths.stdoutText),
        stderr: emptySummary(options.streamPaths.stderrBin, options.streamPaths.stderrText),
        stdoutText: "",
        stderrText: "",
        ownership: null,
        cleanup: {
          state: "not_needed",
          trigger: abortTrigger(options.signal?.reason),
          actions: ["child was not spawned because cancellation was already observed"],
          error: null,
        },
        captureError: null,
        storageError: null,
        error: null,
      };
    };

    const deadlineExpiredBeforeSpawn = async (): Promise<ProcessRunResult> => {
      await closeOwnedSink();
      return {
        pid: null,
        exitCode: null,
        signal: null,
        spawnError: null,
        timedOut: true,
        trigger: "timeout",
        exitObserved: false,
        spawnedAt: null,
        spawnedAtMono: null,
        exitedAt: null,
        exitedAtMono: null,
        stdout: emptySummary(options.streamPaths.stdoutBin, options.streamPaths.stdoutText),
        stderr: emptySummary(options.streamPaths.stderrBin, options.streamPaths.stderrText),
        stdoutText: "",
        stderrText: "",
        ownership: null,
        cleanup: { state: "not_needed", trigger: "timeout", actions: ["child was not spawned because the execution budget expired"], error: null },
        captureError: null,
        storageError: null,
        error: null,
      };
    };

    // An already-aborted request must never spawn a child. The caller still
    // closes the allocated empty log files during finalization.
    if (isAborted()) return cancellationBeforeSpawn();
    if (ownedSink !== undefined) await ownedSink.open();
    if (deadlineMono !== undefined && performance.now() >= deadlineMono) return deadlineExpiredBeforeSpawn();

    const ownershipFactory = options.ownershipFactory ?? makeDefaultOwnership(options.helperScriptPath);
    const launchRequest: OwnedLaunchRequest = {
      executable: options.executable,
      argv: [...options.argv],
      cwd: options.cwd,
      env: options.env,
    };
    let ownership: OwnershipHandle;
    try {
      // The helper creates the root with Job membership as part of creation.
      // Node never spawns an unowned root, so there is no attachment interval.
      ownership = await ownershipFactory.launch(launchRequest, options.statusPath);
    } catch (error) {
      return spawnFailure(bounded(error, "ownership helper could not be started"), "ownership_unavailable", {
        code: "ownership_unavailable",
        message: bounded(error, "ownership helper could not be started"),
      });
    }

    let trigger: CleanupTrigger | null = null;
    let terminationRequested = false;
    let naturalCompletionTimedOut = false;
    let naturalCompletionError: string | null = null;
    let resolveTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    const requestTermination = (): void => {
      if (terminationRequested) return;
      terminationRequested = true;
      resolveTermination?.();
    };

    let exitObserved = false;
    let naturalExitObserved = false;
    let exitedAt: string | null = null;
    let exitedAtMono: number | null = null;
    let spawnedAt: string | null = null;
    let spawnedAtMono: number | null = null;
    const markExitObserved = (observation: OwnershipRootExit): void => {
      if (exitObserved) return;
      exitObserved = true;
      exitedAt = observation.observedAtUtc;
      if (observation.elapsedMilliseconds !== null) {
        // One Node monotonic anchor; the difference then equals the native
        // Stopwatch interval measured between root creation and observation.
        const anchor = performance.now();
        exitedAtMono = anchor;
        spawnedAtMono = anchor - observation.elapsedMilliseconds;
      }
      if (trigger === null) naturalExitObserved = true;
    };
    // The adapter owns native status polling; the runner only consumes the
    // typed root-exit observation. A rejection must not escape unhandled.
    const rootExitSeen = ownership.rootExit.then(
      (observation) => {
        markExitObserved(observation);
        return "root-exit" as const;
      },
      () => "root-exit-unavailable" as const,
    );

    const stdoutCapture = ownership.stdout === null
      ? Promise.resolve(failedCapture("stdout pipe unavailable"))
      : capture(ownership.stdout, "stdout", sink, options.redactSecrets);
    const stderrCapture = ownership.stderr === null
      ? Promise.resolve(failedCapture("stderr pipe unavailable"))
      : capture(ownership.stderr, "stderr", sink, options.redactSecrets);

    const setTrigger = (candidate: CleanupTrigger): void => {
      if (trigger !== null || naturalExitObserved) return;
      trigger = candidate;
      requestTermination();
    };

    const timeoutHandle = deadlineMono === undefined ? undefined
      : setTimeout(() => setTrigger("timeout"), Math.max(1, Math.ceil(deadlineMono - performance.now())));
    const abortListener = (): void => setTrigger(abortTrigger(options.signal?.reason));
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (isAborted()) abortListener();

    let resolveCaptureFailure: (() => void) | undefined;
    const captureFailure = new Promise<void>((resolve) => {
      resolveCaptureFailure = resolve;
    });
    const notifyCaptureFailure = (captured: CapturedStream): void => {
      if (captured.error === null) return;
      if (captured.storageError !== null) {
        setTrigger("storage");
      } else if (!exitObserved) {
        // A broken capture pipe is not a contract trigger, but continuing
        // without draining it can block the process. Terminate to regain
        // control and classify the incomplete evidence as a process failure.
        requestTermination();
      }
      resolveCaptureFailure?.();
    };
    void stdoutCapture.then(notifyCaptureFailure, () => {
      if (!exitObserved) requestTermination();
      resolveCaptureFailure?.();
    });
    void stderrCapture.then(notifyCaptureFailure, () => {
      if (!exitObserved) requestTermination();
      resolveCaptureFailure?.();
    });

    let ownershipCompletion: OwnershipCompletion | null = null;
    let ownershipAttachError: string | null = null;
    let readyRootPid: number | null = null;

    let abortReady: (() => void) | undefined;
    const abortedPromise = new Promise<"abort">((resolve) => {
      abortReady = () => resolve("abort");
    });
    const onHarnessAbort = (): void => abortReady?.();
    if (isAborted()) onHarnessAbort();
    else options.signal?.addEventListener("abort", onHarnessAbort, { once: true });
    let readyBudgetTimer: NodeJS.Timeout | undefined;
    const readyBudget = new Promise<"budget">((resolve) => {
      if (deadlineMono !== undefined) {
        readyBudgetTimer = setTimeout(() => resolve("budget"), Math.max(1, deadlineMono - performance.now()));
      }
    });

    const readyOutcome = await Promise.race([
      ownership.ready.then(
        (ready) => ({ kind: "ready" as const, ready }),
        (error: unknown) => ({ kind: "ready-error" as const, error }),
      ),
      abortedPromise.then(() => ({ kind: "abort" as const })),
      readyBudget.then(() => ({ kind: "budget" as const })),
      termination.then(() => ({ kind: "termination" as const })),
    ]);
    if (readyBudgetTimer !== undefined) clearTimeout(readyBudgetTimer);
    options.signal?.removeEventListener("abort", onHarnessAbort);

    if (readyOutcome.kind === "ready") {
      const ready: OwnershipReady = readyOutcome.ready;
      if (!ready.success) {
        ownershipAttachError = ready.error ?? "ownership helper did not confirm the owned launch";
        ownershipCompletion = await ownership.terminate("shutdown");
      } else {
        readyRootPid = ready.rootPid;
        // Native creation time, independent of when readiness was observed.
        spawnedAt = ready.rootStartedAtUtc;
        // A stop may already have been requested while readiness was pending.
        if (trigger !== null || terminationRequested) {
          ownershipCompletion = await ownership.terminate(trigger ?? "cancel");
        }
      }
    } else if (readyOutcome.kind === "ready-error") {
      ownershipAttachError = bounded(readyOutcome.error, "ownership helper launch failed");
      ownershipCompletion = await ownership.terminate("shutdown");
    } else {
      if (readyOutcome.kind === "budget") setTrigger("timeout");
      else if (readyOutcome.kind === "abort") setTrigger(abortTrigger(options.signal?.reason));
      ownershipCompletion = await ownership.terminate(trigger ?? "cancel");
      // The root may have been created while the stop was being delivered.
      readyRootPid = ownershipCompletion.rootPid;
    }

    if (ownershipCompletion === null) {
      const completionOutcome = ownership.waitForCompletion().then(
        (completion) => ({ kind: "completed" as const, completion }),
        (error: unknown) => ({ kind: "completion-error" as const, error }),
      );
      // The local completion allowance guards only helper cleanup after the
      // root has exited. It is never armed while the runtime is still running;
      // long-running work is bounded solely by the caller's deadline/abort.
      const first = await Promise.race([
        completionOutcome,
        termination.then(() => ({ kind: "termination" as const })),
        captureFailure.then(() => ({ kind: "capture" as const })),
        rootExitSeen.then(() => ({ kind: "root-exit" as const })),
      ]);

      if (first.kind === "completed") {
        ownershipCompletion = first.completion;
      } else if (first.kind === "completion-error") {
        ownershipAttachError ??= bounded(first.error, "ownership helper completion could not be observed");
        ownershipCompletion = await ownership.terminate("shutdown");
      } else if (first.kind === "root-exit") {
        let naturalBoundTimer: NodeJS.Timeout | undefined;
        const naturalBound = new Promise<"natural-bound">((resolve) => {
          naturalBoundTimer = setTimeout(() => resolve("natural-bound"), NATURAL_COMPLETION_WAIT_MS);
        });
        const settled = await Promise.race([
          completionOutcome,
          termination.then(() => ({ kind: "termination" as const })),
          captureFailure.then(() => ({ kind: "capture" as const })),
          naturalBound.then(() => ({ kind: "natural-bound" as const })),
        ]);
        if (naturalBoundTimer !== undefined) clearTimeout(naturalBoundTimer);
        if (settled.kind === "completed") {
          ownershipCompletion = settled.completion;
        } else if (settled.kind === "completion-error") {
          ownershipAttachError ??= bounded(settled.error, "ownership helper completion could not be observed");
          ownershipCompletion = await ownership.terminate("shutdown");
        } else if (settled.kind === "natural-bound") {
          naturalCompletionTimedOut = true;
          naturalCompletionError = `the owned process exited but helper completion did not finish within ${NATURAL_COMPLETION_WAIT_MS} ms; the helper was stopped, so this operation cannot be reported as a natural success`;
          // The bound must request actual termination rather than merely claim it.
          ownershipCompletion = await ownership.terminate("timeout");
        } else {
          ownershipCompletion = await ownership.terminate(trigger ?? "storage");
        }
      } else {
        ownershipCompletion = await ownership.terminate(trigger ?? "storage");
      }
    }

    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abortListener);

    if (!exitObserved && ownershipCompletion.rootExit !== null) {
      markExitObserved(ownershipCompletion.rootExit);
    }
    const pid = ownershipCompletion.rootPid ?? readyRootPid;

    const captures = await withTimeout<readonly [CapturedStream, CapturedStream]>(
      Promise.all([stdoutCapture, stderrCapture]),
      DRAIN_AFTER_COMPLETION_MS,
      () => {
        try { ownership.stdout?.destroy(); ownership.stderr?.destroy(); } catch { /* best effort */ }
        return [failedCapture("capture drain deadline expired"), failedCapture("capture drain deadline expired")];
      },
    );
    let sinkCloseError: string | null = null;
    await sink.close().catch((error: unknown) => {
      sinkCloseError = bounded(error, "stream storage could not be closed");
      if (!exitObserved) setTrigger("storage");
    });

    const stdout = captures[0];
    const stderr = captures[1];
    const cleanupConfirmed = ownershipCompletion.cleanupConfirmed || ownershipCompletion.noDescendantsConfirmed;
    // Only typed native ownership evidence proves no root was created. An
    // unknown launch outcome is unconfirmed, never "not_needed".
    const launchExplicitlyAbsent = ownershipCompletion.launchStarted === false;
    const cleanupState: ProcessCleanup["state"] = launchExplicitlyAbsent
      ? "not_needed"
      : cleanupConfirmed
        ? "confirmed"
        : "unconfirmed";
    const cleanupActions: string[] = [...ownershipCompletion.actions];
    if (naturalCompletionTimedOut) {
      cleanupActions.push(`natural completion bound of ${NATURAL_COMPLETION_WAIT_MS} ms expired before helper completion`);
    }
    if (cleanupConfirmed) cleanupActions.push("native helper confirmed the owned Job has no remaining members");
    const cleanup: ProcessCleanup = {
      state: cleanupState,
      trigger,
      actions: cleanupActions,
      // A confirmed native cleanup does not turn a missed completion bound into
      // a natural success; the ownership error stays explicit.
      error: naturalCompletionError ?? (cleanupConfirmed
        ? null
        : launchExplicitlyAbsent
          ? ownershipAttachError
          : ownershipCompletion.error ?? ownershipAttachError ?? "owned process cleanup was not confirmed"),
    };
    const captureError = stdout.error ?? stderr.error;
    const storageError = stdout.storageError ?? stderr.storageError ?? sinkCloseError;
    const processError = naturalCompletionError ?? ownershipAttachError ?? captureError ?? sinkCloseError;

    return {
      pid,
      exitCode: ownershipCompletion.rootExitObserved ? ownershipCompletion.rootExitCode : null,
      signal: null,
      spawnError: naturalCompletionError !== null
        ? { code: "ownership_completion_timeout", message: naturalCompletionError }
        : ownershipAttachError !== null
          // A readiness/ownership error remains a consumed process failure even
          // when cleanup later learned the root PID.
          ? { code: "ownership_unavailable", message: ownershipAttachError }
          : pid === null && processError !== null
            ? { code: "ownership_unavailable", message: processError }
            : null,
      timedOut: trigger === "timeout",
      trigger,
      exitObserved,
      spawnedAt,
      spawnedAtMono,
      exitedAt,
      exitedAtMono,
      stdout: toSummary(stdout, options.streamPaths.stdoutBin, options.streamPaths.stdoutText),
      stderr: toSummary(stderr, options.streamPaths.stderrBin, options.streamPaths.stderrText),
      stdoutText: stdout.preview,
      stderrText: stderr.preview,
      ownership: ownershipCompletion,
      cleanup,
      captureError,
      storageError,
      error: processError,
    };
  }
}

export const defaultProcessRunner: ProcessRunner = new NodeProcessRunner();
