import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BigIntStats, Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { assertSupportedLocalDrive, canonicalizePath, pathIdentity, resolveDisplayPath, validatePathSyntax } from "./paths.js";
import type { ListFilesInput } from "./types.js";

export interface ListingInputFingerprint {
  /** Caller spelling used for argv and human-facing evidence. */
  readonly path: string;
  /** Canonical real path observed during preparation. */
  readonly realPath: string;
  readonly role: "input" | "dependency";
  readonly identity: string;
  readonly kind: "file" | "directory";
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly mtimeNs: string | null;
  readonly fileId: string | null;
}

export interface ListingExpectedLoad {
  readonly path: string;
  readonly realPath: string;
  readonly role: "input" | "dependency";
  readonly kind: "file" | "directory";
}

export interface ListingDirectoryInspection {
  readonly caseSensitive: boolean;
  readonly reparsePoint: boolean;
}

/** OS boundary used to classify all directories discovered by one preparation pass. */
export interface ListingDirectoryInspector {
  inspect(
    directories: readonly string[],
    signal?: AbortSignal,
    deadlineMono?: number,
  ): Promise<ReadonlyMap<string, ListingDirectoryInspection>>;
}

export interface ListingPreparationOptions {
  readonly directoryInspector?: ListingDirectoryInspector;
}

export interface ListingPreparation {
  readonly workspace: string;
  readonly inputEntries: ReadonlyArray<ListFilesInput["inputs"][number]>;
  readonly resolvedInputs: readonly string[];
  readonly fingerprints: readonly ListingInputFingerprint[];
  readonly expectedLoads: readonly ListingExpectedLoad[];
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const GLOB_EXTGLOB = /[@?*+!]\([^\\/]*\)/u;
const GLOB_BRACE = /\{[^{}]*\}/u;
const GLOB_BRACKET = /\[[^\]]*\]/u;
const GLOB_INTERPOLATION = /\$\{[^}]+\}|\$\([^)]*\)/u;

const checkBudget = (signal?: AbortSignal, deadlineMono?: number): void => {
  if (signal?.aborted === true) throw new Error("listing input preparation was cancelled");
  if (deadlineMono !== undefined && performance.now() >= deadlineMono) throw new Error("listing input preparation exceeded its deadline");
};

/**
 * FILE_CASE_SENSITIVE_INFO is queried with read-only access (0x1 flag) and
 * FILE_FLAG_BACKUP_SEMANTICS. The attribute query also lets the pass reject
 * reparse-point directories instead of walking an uncertain subtree.
 */
const CASE_INFO_SCRIPT = `
$source = @'
using System;
using System.Runtime.InteropServices;
public static class GdreCaseInfo {
  [StructLayout(LayoutKind.Sequential)] public struct CaseInfo { public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct AttributeInfo { public uint FileAttributes; public uint ReparseTag; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out CaseInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out AttributeInfo info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type $source
$raw = [Console]::In.ReadToEnd()
$payload = ConvertFrom-Json -InputObject $raw
$paths = @($payload.paths)
$items = foreach ($item in $paths) {
  $handle = [GdreCaseInfo]::CreateFile([string]$item, 0x80, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  if ($handle.ToInt64() -eq -1) {
    [pscustomobject]@{ path = [string]$item; status = "error"; caseSensitive = $false; reparsePoint = $false }
    continue
  }
  $attributeHandle = [GdreCaseInfo]::CreateFile([string]$item, 0x80, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
  if ($attributeHandle.ToInt64() -eq -1) {
    [GdreCaseInfo]::CloseHandle($handle) | Out-Null
    [pscustomobject]@{ path = [string]$item; status = "error"; caseSensitive = $false; reparsePoint = $false }
    continue
  }
  $caseInfo = New-Object GdreCaseInfo+CaseInfo
  $attributeInfo = New-Object GdreCaseInfo+AttributeInfo
  $caseOk = [GdreCaseInfo]::GetFileInformationByHandleEx($handle, 23, [ref]$caseInfo, [Runtime.InteropServices.Marshal]::SizeOf($caseInfo))
  $attributeOk = [GdreCaseInfo]::GetFileInformationByHandleEx($attributeHandle, 9, [ref]$attributeInfo, [Runtime.InteropServices.Marshal]::SizeOf($attributeInfo))
  [GdreCaseInfo]::CloseHandle($handle) | Out-Null
  [GdreCaseInfo]::CloseHandle($attributeHandle) | Out-Null
  if (-not $caseOk -or -not $attributeOk) {
    [pscustomobject]@{ path = [string]$item; status = "error"; caseSensitive = $false; reparsePoint = $false }
    continue
  }
  [pscustomobject]@{
    path = [string]$item
    status = "ok"
    caseSensitive = (($caseInfo.Flags -band 1) -ne 0)
    reparsePoint = (($attributeInfo.FileAttributes -band 0x400) -ne 0)
  }
}
[pscustomobject]@{ items = @($items) } | ConvertTo-Json -Compress
`;

const powershellExecutable = (): string => process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

const parentPath = (value: string): string => DRIVE_ABSOLUTE.test(value)
  ? path.win32.dirname(value)
  : path.dirname(value);

const childPath = (directory: string, name: string): string => DRIVE_ABSOLUTE.test(directory)
  ? path.win32.join(directory, name)
  : path.join(directory, name);

const ordinalCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const identityOverlaps = (candidate: string, metadataRoot: string): boolean =>
  candidate === metadataRoot || candidate.startsWith(`${metadataRoot}/`);

const normalizeInspectorKey = (value: string): string => pathIdentity(value);

const parseInspectionResults = (
  directories: readonly string[],
  value: unknown,
): ReadonlyMap<string, ListingDirectoryInspection> => {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { readonly items?: unknown }).items)) {
    throw new Error("directory attribute inspector returned an invalid response");
  }
  const items = (value as { readonly items: readonly unknown[] }).items;
  const expected = new Set(directories.map(normalizeInspectorKey));
  const result = new Map<string, ListingDirectoryInspection>();
  for (const item of items) {
    if (typeof item !== "object" || item === null) throw new Error("directory attribute inspector returned an invalid item");
    const record = item as { readonly path?: unknown; readonly status?: unknown; readonly caseSensitive?: unknown; readonly reparsePoint?: unknown };
    if (typeof record.path !== "string" || record.status !== "ok" || typeof record.caseSensitive !== "boolean" || typeof record.reparsePoint !== "boolean") {
      throw new Error("directory attribute inspector could not classify a required directory");
    }
    const key = normalizeInspectorKey(record.path);
    if (!expected.has(key) || result.has(key)) throw new Error("directory attribute inspector returned an unexpected directory");
    result.set(key, { caseSensitive: record.caseSensitive, reparsePoint: record.reparsePoint });
  }
  if (result.size !== expected.size) throw new Error("directory attribute inspector omitted a required directory");
  return result;
};

export const nativeListingDirectoryInspector: ListingDirectoryInspector = {
  async inspect(directories, signal, deadlineMono): Promise<ReadonlyMap<string, ListingDirectoryInspection>> {
    const unique = new Map<string, string>();
    for (const directory of directories) unique.set(normalizeInspectorKey(directory), directory);
    const ordered = [...unique.entries()]
      .sort((left, right) => ordinalCompare(left[0], right[0]))
      .map((entry) => entry[1]);
    if (ordered.length === 0) return new Map();
    checkBudget(signal, deadlineMono);
    if (process.platform !== "win32") {
      return new Map(ordered.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
    }

    const child = spawn(
      powershellExecutable(),
      ["-NoProfile", "-NonInteractive", "-Command", CASE_INFO_SCRIPT],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    child.stderr?.resume();
    const remaining = deadlineMono === undefined ? 5_000 : Math.max(1, deadlineMono - performance.now());
    const timeoutMs = Math.min(5_000, Math.ceil(remaining));
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let stopping: Error | null = null;
      const timer = setTimeout(() => {
        stopping ??= new Error("directory attribute inspection timed out");
        try { child.kill(); } catch { /* close below remains authoritative */ }
      }, timeoutMs);
      timer.unref();
      const stop = (error: Error): void => {
        stopping ??= error;
        try { child.kill(); } catch { /* close below remains authoritative */ }
      };
      const onAbort = (): void => stop(new Error("directory attribute inspection was cancelled"));
      const onStdinError = (): void => stop(new Error("directory attribute inspector input failed"));
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer | string) => output.push(Buffer.from(chunk)));
      child.stdin?.once("error", onStdinError);
      child.once("error", () => stop(new Error("directory attribute inspector could not start")));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.stdin?.removeListener("error", onStdinError);
        if (stopping !== null) {
          reject(stopping);
        } else if (code !== 0) {
          reject(new Error("directory attribute inspector exited unsuccessfully"));
        } else {
          try {
            resolve(JSON.parse(Buffer.concat(output).toString("utf8")) as unknown);
          } catch {
            reject(new Error("directory attribute inspector returned invalid JSON"));
          }
        }
      });
      try {
        child.stdin?.end(JSON.stringify({ paths: ordered }));
      } catch {
        stop(new Error("directory attribute inspector input failed"));
      }
    });
    return parseInspectionResults(ordered, result);
  },
};

interface PreparationContext {
  readonly workspace: string;
  readonly metadataIdentity: string;
  readonly signal?: AbortSignal;
  readonly deadlineMono?: number;
  readonly directoryInspector: ListingDirectoryInspector;
  readonly caseDirectories: Map<string, string>;
  readonly reparseDirectories: Map<string, string>;
  readonly walkedDirectories: Set<string>;
}

const makeContext = async (
  workspace: string,
  signal: AbortSignal | undefined,
  deadlineMono: number | undefined,
  directoryInspector: ListingDirectoryInspector,
): Promise<PreparationContext> => {
  checkBudget(signal, deadlineMono);
  const workspaceResolved = await canonicalizePath(workspace);
  await assertSupportedLocalDrive(workspaceResolved.realPath);
  const metadataDisplay = resolveDisplayPath(workspace, ".gdre", true);
  const metadata = await canonicalizePath(metadataDisplay);
  return {
    workspace,
    metadataIdentity: metadata.identity,
    signal,
    deadlineMono,
    directoryInspector,
    caseDirectories: new Map(),
    reparseDirectories: new Map(),
    walkedDirectories: new Set(),
  };
};

const assertNotMetadata = (context: PreparationContext, display: string, identity: string): void => {
  if (identityOverlaps(identity, context.metadataIdentity)) {
    throw new Error(`listing path overlaps the workspace metadata tree: ${display}`);
  }
};

const registerDirectory = async (context: PreparationContext, display: string): Promise<string> => {
  checkBudget(context.signal, context.deadlineMono);
  const resolved = await canonicalizePath(display);
  await assertSupportedLocalDrive(resolved.realPath);
  assertNotMetadata(context, display, resolved.identity);
  let current = resolved.realPath;
  const visited = new Set<string>();
  while (true) {
    checkBudget(context.signal, context.deadlineMono);
    const identity = pathIdentity(current);
    if (visited.has(identity)) throw new Error(`directory ancestry could not be classified: ${display}`);
    visited.add(identity);
    context.caseDirectories.set(identity, current);
    const parent = parentPath(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved.realPath;
};

const listChildren = async (context: PreparationContext, directory: string): Promise<readonly Dirent[]> => {
  await registerDirectory(context, directory);
  try {
    checkBudget(context.signal, context.deadlineMono);
    return await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    throw new Error(`cannot enumerate listing directory ${directory}`, { cause: error });
  }
};

const lstatEntry = async (context: PreparationContext, display: string): Promise<BigIntStats> => {
  try {
    checkBudget(context.signal, context.deadlineMono);
    return await fs.lstat(display, { bigint: true });
  } catch (error) {
    throw new Error(`cannot inspect listing path ${display}`, { cause: error });
  }
};

const rejectSymlink = (display: string, stats: BigIntStats): void => {
  if (stats.isSymbolicLink()) throw new Error(`listing traversal encountered a symbolic link: ${display}`);
};

const inspectDirectoryTree = async (context: PreparationContext, directory: string, rootAlias = false): Promise<void> => {
  if (!rootAlias) context.reparseDirectories.set(pathIdentity(directory), directory);
  const realDirectory = await registerDirectory(context, directory);
  const identity = pathIdentity(realDirectory);
  if (context.walkedDirectories.has(identity)) return;
  context.walkedDirectories.add(identity);
  const children = await listChildren(context, directory);
  for (const child of children) {
    checkBudget(context.signal, context.deadlineMono);
    const next = childPath(directory, child.name);
    const stats = await lstatEntry(context, next);
    rejectSymlink(next, stats);
    if (stats.isDirectory()) await inspectDirectoryTree(context, next);
  }
};

const splitPattern = (value: string): { readonly root: string; readonly segments: readonly string[] } => {
  const normalized = value.replaceAll("\\", "/");
  if (DRIVE_ABSOLUTE.test(normalized)) {
    return { root: `${normalized.slice(0, 2)}/`, segments: normalized.slice(3).split("/").filter(Boolean) };
  }
  if (normalized.startsWith("/")) return { root: "/", segments: normalized.slice(1).split("/").filter(Boolean) };
  return { root: "", segments: normalized.split("/").filter(Boolean) };
};

const hasUnsupportedGlobSyntax = (pattern: string): boolean =>
  GLOB_EXTGLOB.test(pattern) || GLOB_BRACE.test(pattern) || GLOB_BRACKET.test(pattern) || GLOB_INTERPOLATION.test(pattern);

const segmentRegex = (segment: string, caseInsensitive: boolean): RegExp => {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, caseInsensitive ? "iu" : "u");
};

const expandPattern = async (
  context: PreparationContext,
  pattern: string,
): Promise<readonly string[]> => {
  if (hasUnsupportedGlobSyntax(pattern)) throw new Error("glob uses unsupported extglob, brace, bracket, or interpolation syntax");
  const resolved = resolveDisplayPath(context.workspace, pattern, true);
  const parsed = splitPattern(resolved);
  const wildcardIndex = parsed.segments.findIndex((segment) => segment.includes("*") || segment.includes("?"));
  if (wildcardIndex < 0) throw new Error(`glob matched no inputs: ${pattern}`);
  const patternRoot = parsed.root || context.workspace;
  const fixedPrefix = parsed.segments.slice(0, wildcardIndex).reduce(childPath, patternRoot);
  const fixedStats = await fs.stat(fixedPrefix, { bigint: true });
  if (!fixedStats.isDirectory()) throw new Error(`glob fixed prefix is not a directory: ${fixedPrefix}`);
  const realPrefix = await registerDirectory(context, fixedPrefix);
  const results: string[] = [];
  const caseInsensitive = process.platform === "win32";

  const walk = async (current: string, index: number, rootAlias = false): Promise<void> => {
    checkBudget(context.signal, context.deadlineMono);
    if (!rootAlias) context.reparseDirectories.set(pathIdentity(current), current);
    const currentStats = await lstatEntry(context, current);
    rejectSymlink(current, currentStats);
    if (!currentStats.isDirectory()) return;
    await registerDirectory(context, current);
    const segment = parsed.segments[index];
    if (segment === undefined) {
      results.push(current);
      return;
    }
    if (segment === "**") {
      await walk(current, index + 1, rootAlias);
      const children = await listChildren(context, current);
      for (const child of children) {
        checkBudget(context.signal, context.deadlineMono);
        const next = childPath(current, child.name);
        const stats = await lstatEntry(context, next);
        rejectSymlink(next, stats);
        if (stats.isDirectory()) await walk(next, index, false);
      }
      return;
    }
    const children = await listChildren(context, current);
    const matcher = segmentRegex(segment, caseInsensitive);
    for (const child of children) {
      checkBudget(context.signal, context.deadlineMono);
      if (!matcher.test(child.name)) continue;
      const next = childPath(current, child.name);
      const stats = await lstatEntry(context, next);
      rejectSymlink(next, stats);
      if (index === parsed.segments.length - 1) {
        results.push(next);
      } else if (stats.isDirectory()) {
        await walk(next, index + 1, false);
      }
    }
  };

  await walk(realPrefix, wildcardIndex, true);
  if (results.length === 0) throw new Error(`glob matched no inputs: ${pattern}`);
  const displayResults = results.map((realPath) => {
    const relative = DRIVE_ABSOLUTE.test(realPrefix)
      ? path.win32.relative(realPrefix, realPath)
      : path.relative(realPrefix, realPath);
    return relative.length === 0 ? fixedPrefix : childPath(fixedPrefix, relative);
  });
  return displayResults;
};

const valueFor = (entry: ListFilesInput["inputs"][number]): string => entry.kind === "path" ? entry.path : entry.pattern;

const hashFile = async (file: string, signal?: AbortSignal, deadlineMono?: number): Promise<string> => {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.readableWebStream() as unknown as AsyncIterable<Uint8Array>) {
      checkBudget(signal, deadlineMono);
      hash.update(chunk);
    }
    checkBudget(signal, deadlineMono);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const statsFor = async (display: string, context: PreparationContext): Promise<{ readonly stats: BigIntStats; readonly resolved: Awaited<ReturnType<typeof canonicalizePath>> }> => {
  checkBudget(context.signal, context.deadlineMono);
  const resolved = await canonicalizePath(display);
  await assertSupportedLocalDrive(resolved.realPath);
  await registerDirectory(context, parentPath(resolved.realPath));
  const stats = await fs.stat(display, { bigint: true });
  assertNotMetadata(context, display, resolved.identity);
  return { stats, resolved };
};

const statFingerprint = async (
  display: string,
  role: "input" | "dependency",
  context: PreparationContext,
): Promise<ListingInputFingerprint> => {
  const { stats, resolved } = await statsFor(display, context);
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (kind === null) throw new Error(`listing input is not a regular file or directory: ${display}`);
  const sha256 = kind === "file" ? await hashFile(display, context.signal, context.deadlineMono) : null;
  return {
    path: display,
    realPath: resolved.realPath,
    role,
    identity: resolved.identity,
    kind,
    bytes: kind === "file" && stats.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stats.size) : null,
    sha256,
    mtimeNs: stats.mtimeNs.toString(),
    fileId: `${stats.dev.toString()}:${stats.ino.toString()}`,
  };
};

const findPcks = async (context: PreparationContext, root: string): Promise<readonly string[]> => {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const directoryStats = await lstatEntry(context, directory);
    rejectSymlink(directory, directoryStats);
    if (!directoryStats.isDirectory()) throw new Error(`listing dependency search root is not a directory: ${directory}`);
    const children = await listChildren(context, directory);
    for (const child of children) {
      checkBudget(context.signal, context.deadlineMono);
      const next = childPath(directory, child.name);
      const stats = await lstatEntry(context, next);
      rejectSymlink(next, stats);
      if (stats.isDirectory()) {
        await visit(next);
      } else if (stats.isFile() && child.name.toLowerCase().endsWith(".pck")) {
        result.push(next);
      }
    }
  };
  await visit(root);
  const ordered = await Promise.all(result.map(async (display) => ({ display, identity: (await canonicalizePath(display)).identity })));
  ordered.sort((left, right) => ordinalCompare(left.identity, right.identity));
  return ordered.map((item) => item.display);
};

const dependencyCandidates = async (context: PreparationContext, display: string): Promise<readonly string[]> => {
  const lower = display.toLowerCase();
  if (lower.endsWith(".exe")) {
    const candidate = `${display.slice(0, -4)}.pck`;
    try {
      checkBudget(context.signal, context.deadlineMono);
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) throw new Error(`matching executable sidecar is not a regular file: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`executable input has no verified matching sidecar PCK: ${display}`);
      throw error;
    }
    await registerDirectory(context, parentPath(candidate));
    return [candidate];
  }
  if (lower.endsWith(".app")) {
    const resources = childPath(childPath(display, "Contents"), "Resources");
    let resourcesIsDirectory = false;
    try {
      checkBudget(context.signal, context.deadlineMono);
      resourcesIsDirectory = (await fs.stat(resources)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const searchRoot = resourcesIsDirectory ? resources : display;
    const pcks = await findPcks(context, searchRoot);
    if (pcks.length !== 1) throw new Error(`app input has ${String(pcks.length)} candidate PCK dependencies; only one unambiguous candidate is supported: ${display}`);
    return pcks;
  }
  return [];
};

const classifyDirectories = async (context: PreparationContext): Promise<void> => {
  const directories = [...context.caseDirectories.values(), ...context.reparseDirectories.values()];
  const inspected = await context.directoryInspector.inspect(directories, context.signal, context.deadlineMono);
  for (const directory of directories) {
    checkBudget(context.signal, context.deadlineMono);
    const result = inspected.get(normalizeInspectorKey(directory)) ?? inspected.get(directory);
    if (result === undefined) throw new Error("directory attribute inspection omitted a required directory");
    if (result.reparsePoint) throw new Error(`listing traversal encountered an unsupported reparse point: ${directory}`);
    if (result.caseSensitive) throw new Error(`case-sensitive input tree is unsupported: ${directory}`);
  }
};

const fingerprintSignature = (value: ListingInputFingerprint): string => [
  value.role,
  value.identity,
  pathIdentity(value.realPath),
  value.kind,
  value.bytes === null ? "" : String(value.bytes),
  value.sha256 ?? "",
  value.mtimeNs ?? "",
  value.fileId ?? "",
].join("\u0000");

const graphMatches = (left: ListingPreparation, right: ListingPreparation): boolean => {
  if (left.fingerprints.length !== right.fingerprints.length) return false;
  for (let index = 0; index < left.fingerprints.length; index += 1) {
    if (fingerprintSignature(left.fingerprints[index]!) !== fingerprintSignature(right.fingerprints[index]!)) return false;
  }
  return left.resolvedInputs.length === right.resolvedInputs.length && left.resolvedInputs.every((value, index) => {
    const candidate = right.resolvedInputs[index];
    return candidate !== undefined && pathIdentity(value) === pathIdentity(candidate);
  });
};

export async function prepareListingInputs(
  workspace: string,
  input: ListFilesInput,
  signal?: AbortSignal,
  deadlineMono?: number,
  options: ListingPreparationOptions = {},
): Promise<ListingPreparation> {
  const context = await makeContext(
    workspace,
    signal,
    deadlineMono,
    options.directoryInspector ?? nativeListingDirectoryInspector,
  );
  const groups: string[][] = [];
  for (const entry of input.inputs) {
    checkBudget(signal, deadlineMono);
    const value = valueFor(entry);
    if (!validatePathSyntax(value)) throw new Error(`input path is not representable: ${value}`);
    const values = entry.kind === "glob"
      ? [...await expandPattern(context, value)]
      : [resolveDisplayPath(workspace, value, true)];
    if (entry.kind === "path") {
      const stats = await lstatEntry(context, values[0]!);
      await registerDirectory(context, stats.isDirectory() ? values[0]! : parentPath(values[0]!));
    }
    if (entry.kind === "glob") {
      const ordered = await Promise.all(values.map(async (display) => ({ display, identity: (await canonicalizePath(display)).identity })));
      ordered.sort((left, right) => ordinalCompare(left.identity, right.identity) || ordinalCompare(pathIdentity(left.display), pathIdentity(right.display)));
      groups.push(ordered.map((item) => item.display));
    } else {
      groups.push(values);
    }
  }

  const resolvedInputs = groups.flat();
  if (resolvedInputs.length === 0) throw new Error("listing inputs resolved to an empty set");
  const canonical = new Map<string, string>();
  const inputRecords: {
    readonly display: string;
    readonly identity: string;
    readonly kind: "file" | "directory";
    readonly dependencies: readonly string[];
  }[] = [];
  const dependencyDisplays: string[] = [];
  const inputKinds: ("file" | "directory")[] = [];
  for (const display of resolvedInputs) {
    checkBudget(signal, deadlineMono);
    const { stats, resolved } = await statsFor(display, context);
    const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
    if (kind === null) throw new Error(`listing input is not a regular file or directory: ${display}`);
    assertNotMetadata(context, display, resolved.identity);
    if (canonical.has(resolved.identity)) throw new Error(`listing inputs contain duplicate or aliased path: ${display}`);
    canonical.set(resolved.identity, display);
    const dependencies = [...await dependencyCandidates(context, display)];
    inputRecords.push({ display, identity: resolved.identity, kind, dependencies });
    inputKinds.push(kind);
    if (kind === "directory") await inspectDirectoryTree(context, display, true);
    dependencyDisplays.push(...dependencies);
  }
  if (inputKinds.includes("directory") && (inputKinds.length !== 1 || inputKinds[0] !== "directory")) {
    throw new Error("directory listing inputs cannot be combined with other inputs");
  }

  for (const dependency of dependencyDisplays) {
    checkBudget(signal, deadlineMono);
    const { stats, resolved } = await statsFor(dependency, context);
    if (!stats.isFile()) throw new Error(`listing dependency is not a regular file: ${dependency}`);
    assertNotMetadata(context, dependency, resolved.identity);
    if (canonical.has(resolved.identity)) continue;
    canonical.set(resolved.identity, dependency);
  }

  await classifyDirectories(context);
  const fingerprints: ListingInputFingerprint[] = [];
  for (const record of inputRecords) fingerprints.push(await statFingerprint(record.display, "input", context));
  for (const dependency of dependencyDisplays) {
    const identity = (await canonicalizePath(dependency)).identity;
    if (fingerprints.some((value) => value.identity === identity)) continue;
    fingerprints.push(await statFingerprint(dependency, "dependency", context));
  }
  const fingerprintsByIdentity = new Map(fingerprints.map((value) => [value.identity, value]));
  const expectedLoads: ListingExpectedLoad[] = [];
  for (const record of inputRecords) {
    const loads = record.dependencies.length === 0 ? [record.display] : record.dependencies;
    for (const load of loads) {
      const identity = (await canonicalizePath(load)).identity;
      const fingerprint = fingerprintsByIdentity.get(identity);
      if (fingerprint === undefined) throw new Error("listing expected load was not present in the prepared fingerprint graph");
      expectedLoads.push({
        path: load,
        realPath: fingerprint.realPath,
        role: record.dependencies.length === 0 ? fingerprint.role : "dependency",
        kind: fingerprint.kind,
      });
    }
  }
  return {
    workspace,
    inputEntries: Object.freeze([...input.inputs]),
    resolvedInputs,
    fingerprints,
    expectedLoads,
  };
}

export async function revalidateListingInputs(
  preparation: ListingPreparation,
  signal?: AbortSignal,
  deadlineMono?: number,
  options: ListingPreparationOptions = {},
): Promise<ListingPreparation> {
  const fresh = await prepareListingInputs(
    preparation.workspace,
    { inputs: [...preparation.inputEntries] },
    signal,
    deadlineMono,
    options,
  );
  if (!graphMatches(preparation, fresh)) throw new Error("listing input graph changed before launch");
  return fresh;
}
