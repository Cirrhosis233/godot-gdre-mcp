import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { boundedUtf8 } from "./text.js";
import { joinPath } from "./paths.js";

export type ArtifactKind = "file" | "directory" | "link" | "other";

export interface ArtifactRoot {
  readonly path: string;
  readonly role: string;
}

export interface ArtifactEntry {
  readonly path: string;
  readonly role: string;
  readonly kind: ArtifactKind;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly error: string | null;
}

export interface ArtifactInventoryOptions {
  readonly deadlineMono?: number;
  readonly signal?: AbortSignal;
}

export interface ArtifactInventory {
  readonly entries: readonly ArtifactEntry[];
  readonly errors: readonly string[];
  readonly complete: boolean;
  readonly stopReason: "deadline" | "cancelled" | null;
}

class InventoryStop extends Error {
  public readonly reason: "deadline" | "cancelled";

  public constructor(reason: InventoryStop["reason"]) {
    super(reason === "deadline" ? "artifact inventory execution deadline expired" : "artifact inventory cancellation observed");
    this.name = "InventoryStop";
    this.reason = reason;
  }
}

class HashReadFailure extends Error {
  public readonly causeValue: unknown;

  public constructor(cause: unknown) {
    super(diagnostic(cause, "artifact file could not be hashed"), { cause });
    this.name = "HashReadFailure";
    this.causeValue = cause;
  }
}

const diagnostic = (value: unknown, fallback: string): string => boundedUtf8(value, fallback);

const pathKey = (value: string): string => value.replace(/[\\/]+$/u, "").toLowerCase();

const checkStop = (options: ArtifactInventoryOptions): void => {
  if (options.signal?.aborted === true) throw new InventoryStop("cancelled");
  if (options.deadlineMono !== undefined && performance.now() > options.deadlineMono) {
    throw new InventoryStop("deadline");
  }
};

const kindOf = (stats: Awaited<ReturnType<typeof lstat>>): ArtifactKind => {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
};

const emptyEntry = (
  file: string,
  role: string,
  kind: ArtifactKind,
  error: string | null,
): ArtifactEntry => ({
  path: file,
  role,
  kind,
  bytes: null,
  sha256: null,
  error,
});

const hashFile = async (
  file: string,
  options: ArtifactInventoryOptions,
): Promise<{ readonly bytes: number; readonly sha256: string }> => {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(file);
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      checkStop(options);
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += raw.byteLength;
      hash.update(raw);
    }
    checkStop(options);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof InventoryStop) throw error;
    throw new HashReadFailure(error);
  } finally {
    stream.destroy();
  }
};

const appendError = (errors: string[], file: string, error: unknown, fallback: string): string => {
  const message = `${file}: ${diagnostic(error, fallback)}`;
  errors.push(message);
  return message;
};

const inspectPath = async (
  file: string,
  role: string,
  isRoot: boolean,
  options: ArtifactInventoryOptions,
  entries: ArtifactEntry[],
  errors: string[],
): Promise<void> => {
  checkStop(options);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(file);
  } catch (error) {
    const message = appendError(errors, file, error, "artifact path could not be stated");
    if (!isRoot) entries.push(emptyEntry(file, role, "other", message));
    return;
  }
  checkStop(options);

  const kind = kindOf(stats);
  if (kind === "link") {
    const message = `${file}: symlink/reparse point recorded without traversal`;
    entries.push(emptyEntry(file, role, kind, message));
    errors.push(message);
    return;
  }
  if (kind === "directory") {
    if (!isRoot) entries.push(emptyEntry(file, role, kind, null));
    let children: Dirent<string>[];
    try {
      children = await readdir(file, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      const message = appendError(errors, file, error, "artifact directory could not be enumerated");
      if (!isRoot) {
        entries[entries.length - 1] = { ...entries[entries.length - 1]!, error: message };
      }
      return;
    }
    checkStop(options);
    children.sort((left, right) => {
      const leftKey = pathKey(left.name);
      const rightKey = pathKey(right.name);
      return leftKey.localeCompare(rightKey) || left.name.localeCompare(right.name);
    });
    for (const child of children) {
      checkStop(options);
      await inspectPath(joinPath(file, child.name), role, false, options, entries, errors);
    }
    return;
  }

  if (kind !== "file") {
    entries.push(emptyEntry(file, role, kind, null));
    return;
  }

  try {
    const hashed = await hashFile(file, options);
    entries.push({ path: file, role, kind, bytes: hashed.bytes, sha256: hashed.sha256, error: null });
  } catch (error) {
    if (error instanceof InventoryStop) {
      entries.push({
        path: file,
        role,
        kind,
        bytes: Number.isSafeInteger(stats.size) ? stats.size : null,
        sha256: null,
        error: error.message,
      });
      throw error;
    }
    const failure = error instanceof HashReadFailure ? error : null;
    const message = appendError(errors, file, failure?.causeValue ?? error, "artifact file could not be hashed");
    entries.push({
      path: file,
      role,
      kind,
      bytes: Number.isSafeInteger(stats.size) ? stats.size : null,
      sha256: null,
      error: message,
    });
  }
};

/** Enumerate declared artifact roots without following links or reparse points. */
export async function inventoryArtifacts(
  roots: readonly ArtifactRoot[],
  options: ArtifactInventoryOptions = {},
): Promise<ArtifactInventory> {
  const entries: ArtifactEntry[] = [];
  const errors: string[] = [];
  const uniqueRoots = new Map<string, ArtifactRoot>();
  for (const root of roots) uniqueRoots.set(pathKey(root.path), root);
  const orderedRoots = [...uniqueRoots.values()].sort((left, right) =>
    pathKey(left.path).localeCompare(pathKey(right.path)) || left.path.localeCompare(right.path),
  );
  let stopReason: ArtifactInventory["stopReason"] = null;

  for (const root of orderedRoots) {
    try {
      await inspectPath(root.path, root.role, true, options, entries, errors);
    } catch (error) {
      if (!(error instanceof InventoryStop)) throw error;
      stopReason = error.reason;
      errors.push(error.message);
      break;
    }
  }

  entries.sort((left, right) =>
    pathKey(left.path).localeCompare(pathKey(right.path)) || left.path.localeCompare(right.path),
  );
  return {
    entries,
    errors,
    complete: stopReason === null && errors.length === 0,
    stopReason,
  };
}
