import { isSupportedAbsolutePath, joinPath, pathApiFor, pathIdentity } from "./paths.js";

/**
 * Shared sibling placement proposal for default final products.
 *
 * This module is pure path policy: it does not resolve aliases, inspect the
 * filesystem, create directories, or claim that the proposed destination is
 * safe. Command destination preparation remains responsible for acceptance,
 * overlap, metadata, and target-state checks.
 */

export type OutputPlacementKind =
  | "extracted"
  | "exported"
  | "translations"
  | "patched";

export interface PlacementPrimaryInput {
  /** Canonical real path of an already admitted primary input. */
  readonly realPath: string;
  readonly kind: "file" | "directory";
}

export interface DefaultSiblingOutputOptions {
  /** Existing operation directory whose final segment is the allocated operation UUID. */
  readonly operationDirectory: string;
  readonly kind: OutputPlacementKind;
  /** Admitted primaries after glob expansion; never dependencies or auxiliary inputs. */
  readonly primaryInputs: readonly PlacementPrimaryInput[];
}

/** A rejected sibling placement that requires a caller-selected output. */
export class OutputPlacementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OutputPlacementError";
  }
}

const explicitOutput = (
  kind: OutputPlacementKind,
  reason: string,
): OutputPlacementError =>
  new OutputPlacementError(
    `default ${kind} output requires explicit output: ${reason}`,
  );

const operationIdentifier = (operationDirectory: string): string => {
  const identifier = pathApiFor(operationDirectory).basename(operationDirectory);
  if (identifier.length === 0 || identifier === "." || identifier === "..") {
    throw new OutputPlacementError(
      "default output requires explicit output: the operation directory has no usable operation identifier",
    );
  }
  return identifier;
};

const inputStem = (
  realPath: string,
  kind: PlacementPrimaryInput["kind"],
): string => {
  const base = pathApiFor(realPath).basename(realPath);
  if (kind === "directory") return base;
  const extension = pathApiFor(realPath).extname(base);
  if (extension.length === 0) return base;
  const stem = base.slice(0, -extension.length);
  return stem.length === 0 ? base : stem;
};

/**
 * Propose the default final product path beside admitted primary inputs.
 *
 * - one file: `<stem>-<kind>-<operationId>{.pck}` beside the file
 * - one directory: `<name>-<kind>-<operationId>` beside (never inside) it
 * - several primaries with one canonical parent: `gdre-<kind>-<operationId>`
 * - package patching requires exactly one source and yields a `.pck` file
 *
 * Missing primaries, mixed parents, or a primary directory that is itself a
 * filesystem root throw an actionable error requiring explicit output. A file
 * whose parent is a drive root is still placed beside that file.
 */
export function defaultSiblingOutput(
  options: DefaultSiblingOutputOptions,
): string {
  const { kind, primaryInputs } = options;
  const operationId = operationIdentifier(options.operationDirectory);
  if (primaryInputs.length === 0) {
    throw explicitOutput(kind, "no admitted primary input is available");
  }
  if (kind === "patched" && primaryInputs.length !== 1) {
    throw explicitOutput(
      kind,
      "package patching requires exactly one primary source",
    );
  }

  const parents: string[] = [];
  const stems: string[] = [];
  for (const input of primaryInputs) {
    if (!isSupportedAbsolutePath(input.realPath)) {
      throw explicitOutput(
        kind,
        `primary input is not a supported absolute local path: ${input.realPath}`,
      );
    }
    const api = pathApiFor(input.realPath);
    const parent = api.dirname(input.realPath);
    if (input.kind === "directory" && parent === input.realPath) {
      throw explicitOutput(
        kind,
        `primary directory input is a filesystem root: ${input.realPath}`,
      );
    }
    parents.push(parent);
    stems.push(inputStem(input.realPath, input.kind));
  }

  const canonicalParents = new Set(parents.map((parent) => pathIdentity(parent)));
  if (canonicalParents.size !== 1) {
    throw explicitOutput(
      kind,
      `primary inputs resolve to different parent directories: ${[...new Set(parents)].join(", ")}`,
    );
  }

  const suffix = kind === "patched" ? ".pck" : "";
  if (primaryInputs.length === 1) {
    return joinPath(parents[0]!, `${stems[0]!}-${kind}-${operationId}${suffix}`);
  }
  return joinPath(parents[0]!, `gdre-${kind}-${operationId}${suffix}`);
}

/** Minimal prepared-input shape needed to select admitted primaries. */
export interface PlacementInputPreparation {
  readonly resolvedInputs: readonly string[];
  readonly fingerprints: readonly {
    readonly path: string;
    readonly realPath: string;
    readonly kind: "file" | "directory";
  }[];
}

/**
 * Select admitted primaries from `resolvedInputs`, which contains only the
 * caller's inputs after glob expansion. Fingerprints may also carry auxiliary
 * input-role entries (hints, CSVs); they are intentionally not selected here.
 */
export function admittedPrimaryInputs(
  preparation: PlacementInputPreparation,
): readonly PlacementPrimaryInput[] {
  const byDisplay = new Map(
    preparation.fingerprints.map((fingerprint) => [fingerprint.path, fingerprint]),
  );
  return preparation.resolvedInputs.map((display) => {
    const fingerprint = byDisplay.get(display);
    if (fingerprint === undefined) {
      throw new OutputPlacementError(
        `default output requires explicit output: admitted primary input lacks a prepared fingerprint: ${display}`,
      );
    }
    return { realPath: fingerprint.realPath, kind: fingerprint.kind };
  });
}
