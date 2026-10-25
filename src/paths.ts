import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ResolvedPath {
  readonly display: string;
  readonly identity: string;
  readonly realPath: string;
  readonly existingRoot: string;
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
const DRIVE_RELATIVE = /^[A-Za-z]:/u;

/** Select the same path flavor for admitted Windows drive paths and host-native paths. */
export const pathApiFor = (value: string): typeof path.posix =>
  DRIVE_ABSOLUTE.test(value) ? path.win32 : path;
// Win32 also treats superscript ¹²³ as digits in COM/LPT device basenames.
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/iu;

const trimTrailingSeparators = (value: string): string => {
  if (DRIVE_ABSOLUTE.test(value)) {
    const driveRoot = `${value.slice(0, 2)}\\`;
    return value.length > 3 ? value.replace(/[\\/]+$/u, "") : driveRoot;
  }
  return value.length > 1 ? value.replace(/[\\/]+$/u, "") : value;
};

const segments = (value: string): string[] => {
  const withoutDrive = DRIVE_ABSOLUTE.test(value) ? value.slice(2) : value;
  return withoutDrive.split(/[\\/]+/u).filter((segment) => segment.length > 0);
};

export function isSupportedAbsolutePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) return false;
  if (/^(?:\\\\|\\\\[.?]\\)/u.test(value)) return false;
  if (/^[\\/]/u.test(value) && !DRIVE_ABSOLUTE.test(value)) return false;
  if (DRIVE_RELATIVE.test(value) && !DRIVE_ABSOLUTE.test(value)) return false;
  if (!(DRIVE_ABSOLUTE.test(value) || path.isAbsolute(value))) return false;
  return validatePathSyntax(value);
}

export function validatePathSyntax(value: string): boolean {
  if (/[\0\r\n]/u.test(value)) return false;
  if (/^\\\\/u.test(value) || /^\\\\[.?]\\/u.test(value)) return false;
  if (DRIVE_RELATIVE.test(value) && !DRIVE_ABSOLUTE.test(value)) return false;
  for (const segment of segments(value)) {
    if (segment === "." || segment === "..") continue;
    if (/[.:]$/u.test(segment) || /[. ]$/u.test(segment)) return false;
    if (segment.includes(":")) return false;
    if (RESERVED_DEVICE.test(segment)) return false;
  }
  return true;
}

export function resolveDisplayPath(base: string, value: string, allowRelative: boolean): string {
  if (!validatePathSyntax(value)) {
    throw new Error("path contains an unsupported Windows path form");
  }
  if (isSupportedAbsolutePath(value)) {
    return trimTrailingSeparators(
      DRIVE_ABSOLUTE.test(value) ? path.win32.normalize(value) : path.normalize(value),
    );
  }
  if (!allowRelative || value.startsWith("~") || /[%$][({A-Za-z_]/u.test(value)) {
    throw new Error("path must be absolute and must not use shell or environment expansion");
  }
  const resolved = DRIVE_ABSOLUTE.test(base)
    ? path.win32.resolve(base, value)
    : path.resolve(base, value);
  return trimTrailingSeparators(resolved);
}

const canonicalText = (value: string): string => {
  const normalized = DRIVE_ABSOLUTE.test(value)
    ? path.win32.normalize(value).replaceAll("\\", "/")
    : path.normalize(value).replaceAll("\\", "/");
  const root = normalized.length >= 3 && /^[A-Za-z]:\/$/u.test(normalized)
    ? normalized.slice(0, 2).toLowerCase() + "/"
    : normalized.replace(/\/+$/u, "");
  return root.toLowerCase();
};

const existingAncestor = async (value: string): Promise<{ readonly ancestor: string; readonly rest: readonly string[] }> => {
  let current = value;
  const rest: string[] = [];
  while (true) {
    try {
      await fs.lstat(current);
      return { ancestor: current, rest: rest.reverse() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        throw error;
      }
      const parent = DRIVE_ABSOLUTE.test(current) ? path.win32.dirname(current) : path.dirname(current);
      if (parent === current) return { ancestor: current, rest: rest.reverse() };
      const name = DRIVE_ABSOLUTE.test(current) ? path.win32.basename(current) : path.basename(current);
      rest.push(name);
      current = parent;
    }
  }
};

/** Resolve existing aliases and append only validated, non-existing segments. */
export async function canonicalizePath(display: string): Promise<ResolvedPath> {
  if (!validatePathSyntax(display)) throw new Error("path is not a supported local path");
  try {
    const real = await fs.realpath(display);
    return { display, identity: canonicalText(real), realPath: real, existingRoot: real };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
      throw error;
    }
    const { ancestor, rest } = await existingAncestor(display);
    let realAncestor: string;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch {
      realAncestor = ancestor;
    }
    const appended = rest.reduce(
      (current, segment) => (DRIVE_ABSOLUTE.test(current) ? path.win32.join(current, segment) : path.join(current, segment)),
      realAncestor,
    );
    return { display, identity: canonicalText(appended), realPath: appended, existingRoot: realAncestor };
  }
}

const driveTypes = new Map<string, Promise<string>>();
const caseSensitivity = new Map<string, Promise<boolean>>();

const powershellPath = (): string =>
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

const queryDriveType = (drive: string): Promise<string> => {
  const key = drive.toUpperCase();
  const cached = driveTypes.get(key);
  if (cached !== undefined) return cached;
  const query = new Promise<string>((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[System.IO.DriveInfo]::new('${key}').DriveType`],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < 256) output += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* the failure below is reported */ }
    }, 10_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`drive type could not be classified: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const value = output.trim();
      if (code === 0 && value.length > 0) resolve(value);
      else reject(new Error("drive type could not be classified"));
    });
  });
  driveTypes.set(key, query);
  return query;
};

const assertSupportedDrive = async (file: string): Promise<void> => {
  if (process.platform !== "win32") return;
  const match = /^([A-Za-z]):/u.exec(file);
  if (match === null || match[1] === undefined) throw new Error("path is not on a local drive");
  const type = await queryDriveType(`${match[1]}:`);
  if (type === "Network" || type === "NoRootDirectory" || type === "Unknown" || type === "CDRom") {
    throw new Error(`drive ${match[1].toUpperCase()}: is not a supported local writable drive (${type})`);
  }
};

/** Read-only drive classification reused by input preparation before scanning or hashing. */
export const assertSupportedLocalDrive = assertSupportedDrive;

const probeCaseSensitivity = async (directory: string): Promise<boolean> => {
  if (process.platform !== "win32") return false;
  const key = canonicalText(directory);
  const cached = caseSensitivity.get(key);
  if (cached !== undefined) return cached;
  const probe = new Promise<boolean>(async (resolve, reject) => {
    const token = randomUUID().replaceAll("-", "");
    const name = `gdre-case-${token}-aA`;
    const file = joinPath(directory, name);
    const swapped = joinPath(directory, `gdre-case-${token}-Aa`);
    try {
      await fs.writeFile(file, "", { flag: "wx" });
      try {
        await fs.stat(swapped);
        resolve(false);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") resolve(true);
        else reject(new Error(`directory case sensitivity could not be classified: ${code ?? "unknown error"}`));
      }
    } catch (error) {
      reject(new Error(`directory case sensitivity could not be classified: ${(error as Error).message}`));
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  });
  caseSensitivity.set(key, probe);
  return probe;
};

const assertSupportedDirectory = async (target: string): Promise<void> => {
  let directory = target;
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) directory = path.dirname(directory);
  } catch {
    directory = path.dirname(directory);
  }
  await assertSupportedDrive(directory);
  if (await probeCaseSensitivity(directory)) {
    throw new Error("case-sensitive directory trees are not supported; select a case-insensitive workspace");
  }
};

/**
 * Classify and create a workspace path. Network/mapped drives, case-sensitive
 * trees, and paths whose drive/case behavior cannot be classified are rejected
 * before the workspace is used for an operation.
 */
export async function resolveWorkspacePath(display: string): Promise<ResolvedPath> {
  if (!isSupportedAbsolutePath(display)) throw new Error("workspace is not a supported absolute local path");
  const initial = await canonicalizePath(display);
  // Reject network/unsupported drives before creating anything. Case
  // sensitivity is probed on the workspace itself after creation so this
  // classification does not write a probe file into a parent directory.
  await assertSupportedDrive(initial.existingRoot);
  await fs.mkdir(display, { recursive: true });
  const resolved = await canonicalizePath(display);
  await assertSupportedDirectory(resolved.realPath);
  return resolved;
}

export function pathIdentity(value: string): string {
  return canonicalText(value);
}

export function pathOverlaps(left: string, right: string): boolean {
  const a = pathIdentity(left).replace(/\/+$/u, "");
  const b = pathIdentity(right).replace(/\/+$/u, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function pathContains(parent: string, child: string): boolean {
  const a = pathIdentity(parent).replace(/\/+$/u, "");
  const b = pathIdentity(child).replace(/\/+$/u, "");
  return a === b || b.startsWith(`${a}/`);
}

export function ensureNoUnsafePath(value: string): void {
  if (!validatePathSyntax(value)) throw new Error("path contains a reserved, UNC, device, ADS, or trailing-space form");
}

export const operationRoot = (workspace: string): string =>
  DRIVE_ABSOLUTE.test(workspace)
    ? path.win32.join(workspace, ".gdre", "operations")
    : path.join(workspace, ".gdre", "operations");

export const startupRoot = (workspace: string): string =>
  DRIVE_ABSOLUTE.test(workspace)
    ? path.win32.join(workspace, ".gdre", "startup")
    : path.join(workspace, ".gdre", "startup");

export const joinPath = (...parts: string[]): string => {
  const first = parts[0] ?? "";
  return pathApiFor(first).join(...parts);
};
