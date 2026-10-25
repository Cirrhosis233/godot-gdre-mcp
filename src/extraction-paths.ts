import { promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  nativeListingDirectoryInspector,
  type ListingDirectoryInspection,
  type ListingDirectoryInspector,
  type ListingPreparation,
} from "./listing-paths.js";
import {
  assertSupportedLocalDrive,
  canonicalizePath,
  isSupportedAbsolutePath,
  joinPath,
  pathIdentity,
  pathOverlaps,
  resolveDisplayPath,
  validatePathSyntax,
} from "./paths.js";
import {
  defaultSiblingOutput,
  OutputPlacementError,
  type OutputPlacementKind,
  type PlacementPrimaryInput,
} from "./output-placement.js";

/** A rejected extraction destination or member mapping. */
export class ExtractionPathError extends Error {
  public readonly code = "path_unsupported" as const;

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionPathError";
  }
}

export interface ExtractionDestinationOptions {
  readonly workspace: string;
  readonly operationDirectory: string;
  /** Operation-owned destination; defaults to `<operationDirectory>/output`. */
  readonly ownedOutput?: string;
  /** Caller-selected destination; relative values resolve against the workspace. */
  readonly requestedOutput?: string;
  /**
   * Facts used to propose the product beside admitted primary inputs when
   * `requestedOutput` is omitted. The shared helper has no internal-output
   * fallback.
   */
  readonly defaultPlacement: {
    readonly kind: Exclude<OutputPlacementKind, "patched">;
    readonly primaryInputs: readonly PlacementPrimaryInput[];
  };
  readonly preparedInputs: ListingPreparation;
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
  readonly directoryInspector?: ListingDirectoryInspector;
}

export interface ExtractionDestinationRevalidationOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
  readonly directoryInspector?: ListingDirectoryInspector;
}

/** Immutable identity/attribute snapshot of each existing destination ancestor. */
export interface ExtractionAncestorIdentity {
  readonly path: string;
  readonly identity: string;
  /** Stable filesystem object identity from `stat` dev/ino bigint values. */
  readonly fileId: string;
  readonly caseSensitive: boolean;
  readonly reparsePoint: boolean;
}

export interface ExtractionDestinationPreparation {
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly ownedOutput: string;
  readonly ownedIdentity: string;
  readonly effectiveOutput: string;
  readonly effectiveIdentity: string;
  readonly effectiveRealPath: string;
  readonly existingRoot: string;
  readonly targetState: "absent" | "empty";
  readonly ancestors: readonly ExtractionAncestorIdentity[];
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const MEMBER_PREFIX = "res://";
export const EXTRACTION_ROOT_LOG = "gdre_export.log";
const UNSAFE_SEGMENT = /[<>:"|?*\u0000-\u001f]/u;

const checkBudget = (signal?: AbortSignal, deadlineMono?: number): void => {
  if (signal?.aborted === true) throw new Error("extraction destination preparation was cancelled");
  if (deadlineMono !== undefined && performance.now() >= deadlineMono) {
    throw new Error("extraction destination preparation exceeded its deadline");
  }
};

const parentPath = (value: string): string => DRIVE_ABSOLUTE.test(value)
  ? path.win32.dirname(value)
  : path.dirname(value);

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const budgetExceeded = (signal: AbortSignal | undefined, deadlineMono: number | undefined): boolean =>
  signal?.aborted === true || (deadlineMono !== undefined && performance.now() >= deadlineMono);

/** Keep destination/path rejection distinguishable from cancellation and storage failures. */
const pathBoundary = async <T>(
  message: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
  deadlineMono?: number,
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExtractionPathError || budgetExceeded(signal, deadlineMono)) throw error;
    throw new ExtractionPathError(message, { cause: error });
  }
};

const resolveDestination = (workspace: string, requestedOutput: string): string => {
  if (requestedOutput.length === 0 || (!isSupportedAbsolutePath(requestedOutput) && /^[\\/]/u.test(requestedOutput))) {
    throw new ExtractionPathError(`extraction destination is not a supported absolute or workspace-relative path: ${requestedOutput}`);
  }
  try {
    return resolveDisplayPath(workspace, requestedOutput, true);
  } catch (error) {
    throw new ExtractionPathError(`extraction destination is not a supported path: ${requestedOutput}`, { cause: error });
  }
};

const inspectTargetState = async (realPath: string): Promise<"absent" | "empty"> => {
  try {
    const stats = await fs.stat(realPath);
    if (!stats.isDirectory()) {
      throw new ExtractionPathError("extraction destination is not a directory");
    }
    const entries = await fs.readdir(realPath);
    if (entries.length > 0) {
      throw new ExtractionPathError("extraction destination is not empty");
    }
    return "empty";
  } catch (error) {
    if (error instanceof ExtractionPathError) throw error;
    if (!isMissing(error)) {
      throw new ExtractionPathError("extraction destination could not be inspected", { cause: error });
    }
    return "absent";
  }
};

const inspectAncestors = async (
  existingRoot: string,
  inspector: ListingDirectoryInspector,
  signal?: AbortSignal,
  deadlineMono?: number,
): Promise<readonly ExtractionAncestorIdentity[]> => {
  checkBudget(signal, deadlineMono);
  const chain: string[] = [];
  let current = existingRoot;
  while (true) {
    checkBudget(signal, deadlineMono);
    chain.push(current);
    const parent = parentPath(current);
    if (parent === current) break;
    current = parent;
  }
  chain.reverse();

  let inspected: ReadonlyMap<string, ListingDirectoryInspection>;
  try {
    inspected = await inspector.inspect(chain, signal, deadlineMono);
  } catch (error) {
    if (signal?.aborted === true || (deadlineMono !== undefined && performance.now() >= deadlineMono)) throw error;
    throw new ExtractionPathError("extraction destination ancestors could not be classified", { cause: error });
  }

  const ancestors: ExtractionAncestorIdentity[] = [];
  for (const directory of chain) {
    checkBudget(signal, deadlineMono);
    let stats: BigIntStats;
    try {
      stats = await fs.stat(directory, { bigint: true });
    } catch (error) {
      throw new ExtractionPathError(`extraction destination ancestor could not be inspected: ${directory}`, { cause: error });
    }
    if (!stats.isDirectory()) {
      throw new ExtractionPathError(`extraction destination ancestor is not a directory: ${directory}`);
    }
    if (stats.ino === 0n) {
      throw new ExtractionPathError(`extraction destination ancestor object identity is unavailable: ${directory}`);
    }
    const result = inspected.get(pathIdentity(directory)) ?? inspected.get(directory);
    if (result === undefined) {
      throw new ExtractionPathError(`directory attribute inspection omitted a required directory: ${directory}`);
    }
    if (result.reparsePoint) {
      throw new ExtractionPathError(`extraction destination traversal encountered an unsupported reparse point: ${directory}`);
    }
    if (result.caseSensitive) {
      throw new ExtractionPathError(`case-sensitive extraction destination tree is unsupported: ${directory}`);
    }
    ancestors.push({
      path: directory,
      identity: pathIdentity(directory),
      fileId: `${stats.dev.toString()}:${stats.ino.toString()}`,
      caseSensitive: result.caseSensitive,
      reparsePoint: result.reparsePoint,
    });
  }
  return ancestors;
};

export async function prepareExtractionDestination(
  options: ExtractionDestinationOptions,
): Promise<ExtractionDestinationPreparation> {
  checkBudget(options.signal, options.deadlineMono);
  const ownedOutput = options.ownedOutput ?? joinPath(options.operationDirectory, "output");
  const proposedDefault = (): string => {
    try {
      return defaultSiblingOutput({
        operationDirectory: options.operationDirectory,
        kind: options.defaultPlacement.kind,
        primaryInputs: options.defaultPlacement.primaryInputs,
      });
    } catch (error) {
      if (error instanceof OutputPlacementError) {
        throw new ExtractionPathError(error.message, { cause: error });
      }
      throw error;
    }
  };
  const effectiveOutput = options.requestedOutput === undefined
    ? proposedDefault()
    : resolveDestination(options.workspace, options.requestedOutput);
  const ownedResolved = await pathBoundary(
    "operation-owned extraction output is not a supported local path",
    () => canonicalizePath(ownedOutput),
    options.signal,
    options.deadlineMono,
  );
  await pathBoundary(
    "operation-owned extraction output is not on a supported local drive",
    () => assertSupportedLocalDrive(ownedResolved.realPath),
    options.signal,
    options.deadlineMono,
  );
  const effectiveResolved = await pathBoundary(
    "extraction destination is not a supported local path",
    () => canonicalizePath(effectiveOutput),
    options.signal,
    options.deadlineMono,
  );
  await pathBoundary(
    "extraction destination is not on a supported local drive",
    () => assertSupportedLocalDrive(effectiveResolved.realPath),
    options.signal,
    options.deadlineMono,
  );
  checkBudget(options.signal, options.deadlineMono);

  for (const fingerprint of options.preparedInputs.fingerprints) {
    checkBudget(options.signal, options.deadlineMono);
    if (pathOverlaps(effectiveResolved.identity, fingerprint.identity)) {
      throw new ExtractionPathError(`extraction destination overlaps an extraction input: ${effectiveOutput}`);
    }
  }

  const metadata = await pathBoundary(
    "operation administrative metadata could not be resolved",
    () => canonicalizePath(joinPath(options.workspace, ".gdre")),
    options.signal,
    options.deadlineMono,
  );
  if (effectiveResolved.identity !== ownedResolved.identity && pathOverlaps(effectiveResolved.identity, metadata.identity)) {
    throw new ExtractionPathError(`extraction destination overlaps operation administrative metadata: ${effectiveOutput}`);
  }

  const targetState = await inspectTargetState(effectiveResolved.realPath);
  const ancestors = await inspectAncestors(
    effectiveResolved.existingRoot,
    options.directoryInspector ?? nativeListingDirectoryInspector,
    options.signal,
    options.deadlineMono,
  );

  return {
    workspace: options.workspace,
    operationDirectory: options.operationDirectory,
    ownedOutput,
    ownedIdentity: ownedResolved.identity,
    effectiveOutput,
    effectiveIdentity: effectiveResolved.identity,
    effectiveRealPath: effectiveResolved.realPath,
    existingRoot: effectiveResolved.existingRoot,
    targetState,
    ancestors,
  };
}

/**
 * Re-resolve the prepared destination and its existing ancestor chain
 * immediately before launch. A target that was absent may now be
 * an empty directory (explicit creation by the caller); it may not become an
 * alias to a different location, a file, or nonempty.
 */
export async function revalidateExtractionDestination(
  preparation: ExtractionDestinationPreparation,
  options: ExtractionDestinationRevalidationOptions = {},
): Promise<ExtractionDestinationPreparation> {
  const { signal, deadlineMono } = options;
  checkBudget(signal, deadlineMono);
  const inspector = options.directoryInspector ?? nativeListingDirectoryInspector;

  const effectiveResolved = await pathBoundary(
    "extraction destination could not be re-resolved",
    () => canonicalizePath(preparation.effectiveOutput),
    signal,
    deadlineMono,
  );
  await pathBoundary(
    "extraction destination is not on a supported local drive",
    () => assertSupportedLocalDrive(effectiveResolved.realPath),
    signal,
    deadlineMono,
  );
  if (effectiveResolved.identity !== preparation.effectiveIdentity) {
    throw new ExtractionPathError("extraction destination identity changed before launch");
  }

  for (const ancestor of preparation.ancestors) {
    checkBudget(signal, deadlineMono);
    let stats: BigIntStats;
    try {
      stats = await fs.stat(ancestor.path, { bigint: true });
    } catch (error) {
      throw new ExtractionPathError(`extraction destination ancestor no longer exists before launch: ${ancestor.path}`, { cause: error });
    }
    if (!stats.isDirectory()) {
      throw new ExtractionPathError(`extraction destination ancestor is not a directory before launch: ${ancestor.path}`);
    }
    if (`${stats.dev.toString()}:${stats.ino.toString()}` !== ancestor.fileId) {
      throw new ExtractionPathError(`extraction destination ancestor object identity changed before launch: ${ancestor.path}`);
    }
    const current = await pathBoundary(
      `extraction destination ancestor could not be re-resolved: ${ancestor.path}`,
      () => canonicalizePath(ancestor.path),
      signal,
      deadlineMono,
    );
    if (current.identity !== ancestor.identity) {
      throw new ExtractionPathError(`extraction destination ancestor identity changed before launch: ${ancestor.path}`);
    }
  }

  const targetState = await inspectTargetState(effectiveResolved.realPath);
  const ancestors = await inspectAncestors(effectiveResolved.existingRoot, inspector, signal, deadlineMono);
  return {
    ...preparation,
    effectiveRealPath: effectiveResolved.realPath,
    existingRoot: effectiveResolved.existingRoot,
    targetState,
    ancestors,
  };
}

export interface ExtractionMemberMappingOptions {
  readonly effectiveOutput: string;
  /** Complete preflight member set; only the runtime's `res://` spellings are accepted. */
  readonly members: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
}

export interface ExtractionMemberPath {
  readonly member: string;
  readonly relative: string;
  readonly path: string;
}

export interface ExtractionMemberMapping {
  readonly members: readonly ExtractionMemberPath[];
  readonly expectedPaths: readonly string[];
}

const validateMember = (member: string): readonly string[] => {
  if (!member.startsWith(MEMBER_PREFIX)) {
    throw new ExtractionPathError(`extraction member is not a res:// path: ${member}`);
  }
  const name = member.slice(MEMBER_PREFIX.length);
  if (name.length === 0) throw new ExtractionPathError("extraction member path is empty");
  if (name.includes("\\")) {
    throw new ExtractionPathError(`extraction member contains an ambiguous backslash: ${member}`);
  }
  if (name.startsWith("/")) {
    throw new ExtractionPathError(`extraction member contains an absolute path: ${member}`);
  }
  if (!validatePathSyntax(name)) {
    throw new ExtractionPathError(`extraction member contains an unsupported Windows path form: ${member}`);
  }
  const parts = name.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") {
      throw new ExtractionPathError(`extraction member contains a traversal or empty segment: ${member}`);
    }
    if (UNSAFE_SEGMENT.test(part)) {
      throw new ExtractionPathError(`extraction member contains a Windows-invalid segment: ${member}`);
    }
  }
  return parts;
};

/** Validate one logical `res://` member without mapping it under an output root. */
export const validateLogicalMember = (member: string): readonly string[] => validateMember(member);

/**
 * Map the complete preflight member set to expected absolute paths under the
 * accepted destination. This is pure validation; actual output is never used
 * to infer names.
 */
export function mapExtractionMembers(options: ExtractionMemberMappingOptions): ExtractionMemberMapping {
  checkBudget(options.signal, options.deadlineMono);
  if (!isSupportedAbsolutePath(options.effectiveOutput)) {
    throw new ExtractionPathError("extraction destination must be an absolute local path");
  }

  const scans: { readonly record: ExtractionMemberPath; readonly identity: string }[] = [];
  const identities = new Set<string>();
  for (const member of options.members) {
    checkBudget(options.signal, options.deadlineMono);
    const parts = validateMember(member);
    const relative = parts.join("/");
    const identity = pathIdentity(relative);
    if (identities.has(identity)) {
      throw new ExtractionPathError(`extraction member paths collide case-insensitively: ${member}`);
    }
    identities.add(identity);
    scans.push({
      record: { member, relative, path: joinPath(options.effectiveOutput, ...parts) },
      identity,
    });
  }

  const runtimeLog = pathIdentity(EXTRACTION_ROOT_LOG);
  for (const scan of scans) {
    checkBudget(options.signal, options.deadlineMono);
    if (scan.identity === runtimeLog || scan.identity.startsWith(`${runtimeLog}/`)) {
      throw new ExtractionPathError(`extraction member collides with the runtime root log ${EXTRACTION_ROOT_LOG}: ${scan.record.member}`);
    }
    const parts = scan.identity.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      checkBudget(options.signal, options.deadlineMono);
      prefix = index === 0 ? parts[0]! : `${prefix}/${parts[index]!}`;
      if (identities.has(prefix)) {
        throw new ExtractionPathError(`extraction member path is both a file and a directory: ${scan.record.member}`);
      }
    }
  }

  const records = scans.map((scan) => scan.record);
  return { members: records, expectedPaths: records.map((record) => record.path) };
}
