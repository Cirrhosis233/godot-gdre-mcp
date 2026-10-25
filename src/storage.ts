import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { joinPath, operationRoot, startupRoot } from "./paths.js";
import { DurableFileStreamSink } from "./streams.js";
import type { StreamPaths, StreamSink } from "./streams.js";
import { boundedUtf8 } from "./text.js";

export interface OperationPaths {
  readonly operationId: string;
  readonly workspace: string;
  readonly operation: string;
  readonly output: string;
  readonly profile: string;
  readonly stdoutBin: string;
  readonly stdoutText: string;
  readonly stderrBin: string;
  readonly stderrText: string;
  readonly manifest: string;
  readonly artifacts: string;
}

/** One internal secondary process's retained stream branch (for example preflight). */
export interface AuxiliaryStreamBranch extends StreamPaths {
  readonly directory: string;
  readonly sink: DurableFileStreamSink;
}

export interface StreamEvidence {
  readonly bytes: number;
  readonly sha256: string | null;
  readonly error: string | null;
}

export interface StorageFaults {
  readonly failAfterWrites?: number;
  readonly failManifest?: boolean;
  readonly failArtifacts?: boolean;
  readonly failStreams?: boolean;
}

export class StorageError extends Error {
  public readonly code = "storage_failed";
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export interface JsonWriter {
  write(file: string, value: unknown): Promise<void>;
}

const bounded = (value: unknown): string => boundedUtf8(value);

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

/** Atomic UTF-8 sibling-temp write with flush and close before replacement. */
export class AtomicJsonWriter implements JsonWriter {
  private writes = 0;
  private readonly faults: StorageFaults;

  public constructor(faults: StorageFaults = {}) {
    this.faults = faults;
  }

  public async write(file: string, value: unknown): Promise<void> {
    this.writes += 1;
    if (this.faults.failAfterWrites !== undefined && this.writes > this.faults.failAfterWrites) {
      throw new StorageError("injected atomic JSON write failure");
    }
    const temp = `${file}.tmp-${randomUUID().toLowerCase()}`;
    let handle: FileHandle | undefined;
    try {
      const opened = await fs.open(temp, "wx");
      handle = opened;
      await opened.write(jsonBytes(value));
      await opened.sync();
      await opened.close();
      handle = undefined;
      try {
        await fs.rename(temp, file);
      } catch (error) {
        // Windows rename does not replace an existing file on every supported
        // filesystem. Move the prior snapshot aside instead of deleting it so a
        // failed replacement can restore the last durable snapshot.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        const backup = `${file}.previous-${randomUUID().toLowerCase()}`;
        let moved = false;
        try {
          await fs.rename(file, backup);
          moved = true;
          await fs.rename(temp, file);
        } catch (replaceError) {
          if (moved) {
            try {
              await fs.rename(backup, file);
            } catch {
              throw new StorageError(
                `atomic JSON replacement failed for ${file}; the prior snapshot was retained at ${backup}: ${bounded(replaceError)}`,
                { cause: replaceError },
              );
            }
          }
          throw replaceError;
        }
        if (moved) await fs.rm(backup, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      throw error instanceof StorageError ? error : new StorageError(`atomic JSON write failed for ${file}: ${bounded(error)}`, { cause: error });
    } finally {
      try {
        await handle?.close();
      } catch {
        // Preserve the original write error.
      }
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // Best effort cleanup of a sibling temp file.
      }
    }
  }
}

const makeOperationPaths = (workspace: string, operationId: string): OperationPaths => {
  const operation = joinPath(operationRoot(workspace), operationId);
  return {
    operationId,
    workspace,
    operation,
    output: joinPath(operation, "output"),
    profile: joinPath(operation, "profile"),
    stdoutBin: joinPath(operation, "stdout.bin"),
    stdoutText: joinPath(operation, "stdout.txt"),
    stderrBin: joinPath(operation, "stderr.bin"),
    stderrText: joinPath(operation, "stderr.txt"),
    manifest: joinPath(operation, "manifest.json"),
    artifacts: joinPath(operation, "artifacts.json"),
  };
};

const createEmptyFile = async (file: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "wx");
  } finally {
    await handle?.close();
  }
};

export interface OperationStorageOptions {
  readonly faults?: StorageFaults;
  readonly writer?: JsonWriter;
  readonly idFactory?: () => string;
}

/** Operation-local files, allocated exclusively before launch. */
export class OperationStorage {
  public readonly paths: OperationPaths;
  private readonly writer: JsonWriter;
  private readonly faults: StorageFaults;
  private readonly streamSink: DurableFileStreamSink;

  private constructor(paths: OperationPaths, options: OperationStorageOptions) {
    this.paths = paths;
    this.writer = options.writer ?? new AtomicJsonWriter(options.faults);
    this.faults = options.faults ?? {};
    this.streamSink = new DurableFileStreamSink(paths, this.faults);
  }

  public static async create(
    workspace: string,
    options: OperationStorageOptions = {},
  ): Promise<OperationStorage> {
    const root = operationRoot(workspace);
    await fs.mkdir(root, { recursive: true });
    const idFactory = options.idFactory ?? (() => randomUUID().toLowerCase());
    let paths: OperationPaths | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = idFactory().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate)) {
        throw new StorageError("operation ID factory did not produce a lowercase UUIDv4");
      }
      const candidatePaths = makeOperationPaths(workspace, candidate);
      try {
        await fs.mkdir(candidatePaths.operation, { recursive: false });
        paths = candidatePaths;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw new StorageError(`cannot allocate operation directory: ${bounded(error)}`, { cause: error });
      }
    }
    if (paths === undefined) throw new StorageError("could not allocate a unique operation ID");
    const storage = new OperationStorage(paths, options);
    try {
      await fs.mkdir(paths.output, { recursive: false });
      await fs.mkdir(paths.profile, { recursive: false });
      await Promise.all([
        createEmptyFile(paths.stdoutBin),
        createEmptyFile(paths.stdoutText),
        createEmptyFile(paths.stderrBin),
        createEmptyFile(paths.stderrText),
      ]);
      await storage.writer.write(paths.artifacts, { schemaVersion: 1, complete: false, entries: [], errors: [] });
      await storage.openStreams();
      return storage;
    } catch (error) {
      try {
        await storage.closeStreams();
      } catch {
        // Preserve the initialization failure; closeStreams still attempts every handle.
      }
      throw error instanceof StorageError ? error : new StorageError(`cannot initialize operation record: ${bounded(error)}`, { cause: error });
    }
  }

  private async openStreams(): Promise<void> {
    await this.streamSink.open();
  }

  public async writeManifest(value: unknown): Promise<void> {
    if (this.faults.failManifest) throw new StorageError("injected manifest write failure");
    await this.writer.write(this.paths.manifest, value);
  }

  public async writeArtifacts(value: unknown): Promise<void> {
    if (this.faults.failArtifacts) throw new StorageError("injected artifact inventory write failure");
    await this.writer.write(this.paths.artifacts, value);
  }

  /**
   * Open a secondary retained stream branch inside this operation. The caller
   * receives distinct raw/display files so an internal preflight process never
   * overwrites the actual command's stdout/stderr evidence.
   */
  public async createAuxiliaryStreams(name: string): Promise<AuxiliaryStreamBranch> {
    if (!/^[a-z0-9-]+$/u.test(name)) throw new StorageError(`invalid auxiliary evidence name: ${name}`);
    const directory = joinPath(this.paths.operation, name);
    const paths: StreamPaths = {
      stdoutBin: joinPath(directory, "stdout.bin"),
      stdoutText: joinPath(directory, "stdout.txt"),
      stderrBin: joinPath(directory, "stderr.bin"),
      stderrText: joinPath(directory, "stderr.txt"),
    };
    try {
      await fs.mkdir(directory, { recursive: false });
      await Promise.all([
        createEmptyFile(paths.stdoutBin),
        createEmptyFile(paths.stdoutText),
        createEmptyFile(paths.stderrBin),
        createEmptyFile(paths.stderrText),
      ]);
    } catch (error) {
      throw error instanceof StorageError ? error : new StorageError(`cannot initialize auxiliary stream evidence: ${bounded(error)}`, { cause: error });
    }
    const sink = new DurableFileStreamSink(paths, this.faults);
    try {
      await sink.open();
    } catch (error) {
      try {
        await sink.close();
      } catch {
        // Preserve the opening failure; close attempted every opened handle.
      }
      throw error instanceof StorageError ? error : new StorageError(`cannot open auxiliary stream evidence: ${bounded(error)}`, { cause: error });
    }
    return { directory, ...paths, sink };
  }

  /** Atomically write a secondary JSON evidence file inside a named branch. */
  public async writeAuxiliaryJson(name: string, file: string, value: unknown): Promise<string> {
    if (!/^[a-z0-9-]+$/u.test(name) || !/^[a-z0-9-]+\.json$/u.test(file)) {
      throw new StorageError("invalid auxiliary evidence path");
    }
    const directory = joinPath(this.paths.operation, name);
    await fs.mkdir(directory, { recursive: true });
    const target = joinPath(directory, file);
    await this.writer.write(target, value);
    return target;
  }

  public async appendStream(kind: "stdout" | "stderr", raw: Buffer, text: string): Promise<void> {
    try {
      await this.streamSink.append(kind, raw, text);
    } catch (error) {
      throw error instanceof StorageError
        ? error
        : new StorageError(bounded(error), { cause: error });
    }
  }

  public async closeStreams(): Promise<void> {
    await this.streamSink.close();
  }
}

/** Hash one closed raw evidence file without reading it into memory. */
export const hashEvidenceFile = async (file: string, signal?: AbortSignal): Promise<StreamEvidence> => {
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file, { signal })) {
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += raw.byteLength;
      hash.update(raw);
    }
    return { bytes, sha256: hash.digest("hex"), error: null };
  } catch (error) {
    return { bytes: 0, sha256: null, error: bounded(error) };
  }
};

export interface StartupStorage {
  readonly directory: string;
  readonly stdoutBin: string;
  readonly stdoutText: string;
  readonly stderrBin: string;
  readonly stderrText: string;
  readonly record: string;
  readonly sink: StreamSink;
}

export async function createStartupStorage(workspace: string, idFactory: () => string = () => randomUUID().toLowerCase()): Promise<StartupStorage> {
  const root = startupRoot(workspace);
  await fs.mkdir(root, { recursive: true });
  let directory = "";
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = idFactory().toLowerCase();
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new StorageError("startup ID factory did not produce a UUID");
    const candidate = joinPath(root, id);
    try {
      await fs.mkdir(candidate, { recursive: false });
      directory = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new StorageError(`cannot allocate startup evidence directory: ${bounded(error)}`, { cause: error });
    }
  }
  if (!directory) throw new StorageError("could not allocate startup evidence directory");
  const result = {
    directory,
    stdoutBin: joinPath(directory, "stdout.bin"),
    stdoutText: joinPath(directory, "stdout.txt"),
    stderrBin: joinPath(directory, "stderr.bin"),
    stderrText: joinPath(directory, "stderr.txt"),
    record: joinPath(directory, "startup.json"),
  };
  await Promise.all([result.stdoutBin, result.stdoutText, result.stderrBin, result.stderrText].map(createEmptyFile));
  const sink = new DurableFileStreamSink(result);
  try {
    await sink.open();
  } catch (error) {
    try {
      await sink.close();
    } catch {
      // Preserve the opening failure; close() attempted every opened handle.
    }
    throw new StorageError(`cannot open startup stream evidence: ${bounded(error)}`, { cause: error });
  }
  return { ...result, sink };
}

export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new StorageError(`cannot read JSON evidence ${file}: ${bounded(error)}`, { cause: error });
  }
}
