import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSupportedAbsolutePath } from "../../src/paths.js";
import { defaultProcessRunner, type ProcessRunResult } from "../../src/process.js";
import { prepareNativeOwnershipHelper } from "../../src/process-tree.js";
import { OperationStorage, type OperationPaths } from "../../src/storage.js";
import { DurableFileStreamSink, type StreamSink } from "../../src/streams.js";
import { writeIndependentPck } from "./extraction-fixtures.js";
import { createFixtureProfile } from "./extraction-input-fixtures.js";

/**
 * Controlled package-patch fixture and independent format-2 reader.
 *
 * The source package is authored with the shared independent PCK writer. The
 * reader below parses the accepted unencrypted format-2 layout directly from
 * bytes; it never consults GDRE or product inspection code. Expected member
 * bytes are the authored literals in this module.
 */

export const pckPatchFixtureContent = {
  project:
    'config_version=5\n[application]\nconfig/name="09b native package patch fixture"\n',
  retained: "retained member bytes: unchanged by replacement\n",
  target: "original target payload v1\n",
  /** Binary replacement containing NUL and non-UTF-8 bytes. */
  replacement: Buffer.from([
    0x72, 0x65, 0x70, 0x6c, 0x61, 0x63, 0x65, 0x6d, 0x65, 0x6e, 0x74, 0x20,
    0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x20, 0x76, 0x32, 0x3a, 0x20,
    0x00, 0xff, 0x80, 0x01, 0x7f, 0x0a,
    0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x20, 0x72, 0x65, 0x70, 0x6c, 0x61,
    0x63, 0x65, 0x6d, 0x65, 0x6e, 0x74, 0x20, 0x62, 0x79, 0x74, 0x65, 0x73,
    0x0a,
  ]),
} as const;

export const pckPatchFixtureExpectedMetadata = {
  formatVersion: 2,
  engineVersion: { major: 4, minor: 4, patch: 0 },
  encrypted: false,
} as const;

export interface PckPatchFixtureMember {
  readonly logicalMember: string;
  readonly relative: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
  /** Format-2 directory MD5, computed from the authored bytes. */
  readonly md5: string;
}

export interface PckPatchFixtureReplacement {
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

export interface PckPatchFixture {
  readonly root: string;
  /** Absolute path to the independently authored source PCK. */
  readonly sourcePackage: string;
  /** Absolute path to the literal replacement file. */
  readonly replacementFile: string;
  readonly members: readonly PckPatchFixtureMember[];
  readonly target: PckPatchFixtureMember;
  readonly retained: PckPatchFixtureMember;
  readonly replacement: PckPatchFixtureReplacement;
}

export interface IndependentPckMember {
  readonly storedName: string;
  readonly logicalMember: string;
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
  readonly md5: string;
  /** Actual payload bytes read from the package. */
  readonly bytes: Buffer;
}

export interface IndependentPck {
  readonly metadata: {
    readonly formatVersion: number;
    readonly engineVersion: {
      readonly major: number;
      readonly minor: number;
      readonly patch: number;
    };
    readonly encrypted: boolean;
  };
  readonly members: readonly IndependentPckMember[];
}

export class IndependentPckFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndependentPckFormatError";
  }
}

const PCK_MAGIC = 0x43504447;
const PCK_FORMAT_V2 = 2;
const PREFIX_SIZE = 100;
const RESERVED_START = 32;
const RESERVED_SIZE = 64;
const MAX_MEMBER_COUNT = 4096;
const PCK_ALIGNMENT = 32;

const memberFor = (relative: string, bytes: Buffer): PckPatchFixtureMember => ({
  logicalMember: `res://${relative}`,
  relative,
  bytes,
  size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  md5: createHash("md5").update(bytes).digest("hex"),
});

const fixtureMembers: readonly PckPatchFixtureMember[] = [
  memberFor("project.godot", Buffer.from(pckPatchFixtureContent.project, "utf8")),
  memberFor("data/keep.txt", Buffer.from(pckPatchFixtureContent.retained, "utf8")),
  memberFor("data/replace.txt", Buffer.from(pckPatchFixtureContent.target, "utf8")),
];

/**
 * Author the controlled package-patch fixture below the caller-selected root.
 *
 * Layout: project.godot, retained data/keep.txt and target data/replace.txt,
 * plus a distinct binary replacement file. The caller owns the root and its
 * cleanup, mirroring the other test fixture helpers.
 */
export async function createPckPatchFixture(root: string): Promise<PckPatchFixture> {
  if (!path.isAbsolute(root)) throw new Error(`PCK patch fixture root must be absolute: ${root}`);
  await mkdir(root, { recursive: true });
  const sourcePackage = path.join(root, "source-package.pck");
  const replacementFile = path.join(root, "replacement.bin");
  await writeIndependentPck(
    sourcePackage,
    fixtureMembers.map((member) => ({ relative: member.relative, bytes: member.bytes })),
  );
  await writeFile(replacementFile, pckPatchFixtureContent.replacement, { flag: "wx" });

  const target = fixtureMembers.find((member) => member.relative === "data/replace.txt");
  const retained = fixtureMembers.find((member) => member.relative === "data/keep.txt");
  if (target === undefined || retained === undefined) throw new Error("PCK patch fixture members are incomplete");
  return {
    root,
    sourcePackage,
    replacementFile,
    members: fixtureMembers,
    target,
    retained,
    replacement: {
      bytes: pckPatchFixtureContent.replacement,
      size: pckPatchFixtureContent.replacement.byteLength,
      sha256: createHash("sha256").update(pckPatchFixtureContent.replacement).digest("hex"),
    },
  };
}

const fail = (message: string): never => {
  throw new IndependentPckFormatError(message);
};

const requireRange = (bytes: Buffer, start: number, length: number, label: string): void => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > bytes.byteLength
  ) {
    fail(`${label} is outside the package bounds`);
  }
};

const readU32 = (bytes: Buffer, offset: number, label: string): number => {
  requireRange(bytes, offset, 4, label);
  return bytes.readUInt32LE(offset);
};

const readU64 = (bytes: Buffer, offset: number, label: string): number => {
  requireRange(bytes, offset, 8, label);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} exceeds the safe integer range`);
  return Number(value);
};

const align = (value: number, boundary: number): number =>
  value + ((boundary - (value % boundary)) % boundary);

const decodeName = (bytes: Buffer, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8`);
  }
};

/**
 * Read one unencrypted standalone format-2 package.
 *
 * Bounded to the accepted fixture layout: formulaic header, absolute file base,
 * four-byte aligned padded UTF-8 names, per-member relative offsets, sizes,
 * MD5, flags, in-bounds payloads and the trailing magic. Encrypted packages and
 * other formats are rejected rather than partially interpreted.
 */
export function readIndependentFormat2Pck(bytes: Buffer): IndependentPck {
  if (bytes.byteLength < PREFIX_SIZE) fail(`package is truncated: ${bytes.byteLength} bytes`);
  if (readU32(bytes, 0, "package magic") !== PCK_MAGIC) fail("package magic is not GDPC");
  const formatVersion = readU32(bytes, 4, "package format");
  if (formatVersion !== PCK_FORMAT_V2) fail(`unsupported package format ${formatVersion}; expected 2`);
  const major = readU32(bytes, 8, "engine major");
  const minor = readU32(bytes, 12, "engine minor");
  const patch = readU32(bytes, 16, "engine patch");
  const flags = readU32(bytes, 20, "package flags");
  if (flags !== 0) fail(`unsupported package flags 0x${flags.toString(16)}; expected unencrypted absolute file base`);
  const fileBase = readU64(bytes, 24, "package file base");
  for (let index = RESERVED_START; index < RESERVED_START + RESERVED_SIZE; index += 1) {
    if (bytes[index] !== 0) fail(`package reserved header byte ${String(index)} is not zero`);
  }
  const count = readU32(bytes, 96, "member count");
  if (count > MAX_MEMBER_COUNT) fail(`package member count ${count} exceeds the bounded limit`);
  if (readU32(bytes, bytes.byteLength - 4, "trailing magic") !== PCK_MAGIC) fail("package trailing magic is not GDPC");

  interface Entry {
    readonly storedName: string;
    readonly logicalMember: string;
    readonly offset: number;
    readonly size: number;
    readonly md5: string;
    readonly dataStart: number;
    readonly dataEnd: number;
  }

  const entries: Entry[] = [];
  let cursor = PREFIX_SIZE;
  for (let index = 0; index < count; index += 1) {
    const storedNameLength = readU32(bytes, cursor, `member ${index} stored name length`);
    cursor += 4;
    if (storedNameLength === 0) fail(`member ${index} has an empty stored name`);
    if (storedNameLength % 4 !== 0) fail(`member ${index} stored name length is not four-byte aligned`);
    requireRange(bytes, cursor, storedNameLength, `member ${index} stored name`);
    const storedNameBytes = bytes.subarray(cursor, cursor + storedNameLength);
    cursor += storedNameLength;
    const nulIndex = storedNameBytes.indexOf(0);
    const nameBytes = nulIndex === -1 ? storedNameBytes : storedNameBytes.subarray(0, nulIndex);
    if (nameBytes.byteLength === 0) fail(`member ${index} has an empty name`);
    if (nulIndex !== -1) {
      for (let padding = nulIndex + 1; padding < storedNameBytes.byteLength; padding += 1) {
        if (storedNameBytes[padding] !== 0) fail(`member ${index} name padding is not zero`);
      }
    }
    const storedName = decodeName(nameBytes, `member ${index} name`);
    const offset = readU64(bytes, cursor, `member ${storedName} offset`);
    cursor += 8;
    if (offset % PCK_ALIGNMENT !== 0) fail(`member ${storedName} offset is not ${PCK_ALIGNMENT}-byte aligned`);
    const size = readU64(bytes, cursor, `member ${storedName} size`);
    cursor += 8;
    requireRange(bytes, cursor, 16, `member ${storedName} md5`);
    const md5 = Buffer.from(bytes.subarray(cursor, cursor + 16)).toString("hex");
    cursor += 16;
    const memberFlags = readU32(bytes, cursor, `member ${storedName} flags`);
    cursor += 4;
    if (memberFlags !== 0) fail(`member ${storedName} is encrypted or has unsupported flags`);
    const dataStart = fileBase + offset;
    const dataEnd = dataStart + size;
    if (
      !Number.isSafeInteger(dataStart) ||
      !Number.isSafeInteger(dataEnd) ||
      dataEnd > bytes.byteLength - 4
    ) {
      fail(`member ${storedName} payload is outside the package bounds`);
    }
    entries.push({
      storedName,
      logicalMember: storedName.startsWith("res://") ? storedName : `res://${storedName}`,
      offset,
      size,
      md5,
      dataStart,
      dataEnd,
    });
  }

  const headerEnd = cursor;
  if (fileBase !== align(headerEnd, PCK_ALIGNMENT)) {
    fail(`package file base ${fileBase} does not match the aligned header end`);
  }
  for (let index = headerEnd; index < fileBase; index += 1) {
    if (bytes[index] !== 0) fail(`package header padding byte ${String(index)} is not zero`);
  }

  const logicalNames = new Set<string>();
  for (const entry of entries) {
    if (logicalNames.has(entry.logicalMember)) fail(`duplicate logical member ${entry.logicalMember}`);
    logicalNames.add(entry.logicalMember);
  }
  const populated = entries
    .filter((entry) => entry.size > 0)
    .slice()
    .sort((left, right) => left.dataStart - right.dataStart);
  for (let index = 1; index < populated.length; index += 1) {
    const previous = populated[index - 1];
    const current = populated[index];
    if (previous !== undefined && current !== undefined && current.dataStart < previous.dataEnd) {
      fail(`member payloads overlap at ${current.storedName}`);
    }
  }

  return {
    metadata: {
      formatVersion,
      engineVersion: { major, minor, patch },
      encrypted: false,
    },
    members: entries.map((entry) => {
      const payload = Buffer.from(bytes.subarray(entry.dataStart, entry.dataEnd));
      return {
        storedName: entry.storedName,
        logicalMember: entry.logicalMember,
        offset: entry.offset,
        size: entry.size,
        sha256: createHash("sha256").update(payload).digest("hex"),
        md5: entry.md5,
        bytes: payload,
      };
    }),
  };
}

export async function readIndependentFormat2PckFile(filename: string): Promise<IndependentPck> {
  return readIndependentFormat2Pck(await readFile(filename));
}

// --- owned native execution for the controlled acceptance transaction ---------

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const pckPatchInspectScriptPath = path.join(
  repositoryRoot,
  "native",
  "gdre-pck-inspect.gd",
);

const pckPatchOwnershipHelperPath = path.join(
  repositoryRoot,
  "native",
  "gdre-job-object.ps1",
);

/** Native argument spelling: forward slashes avoid marker/path spelling drift. */
export const nativePath = (value: string): string => value.replaceAll("\\", "/");

const pckPatchRuntimeExecutable = (): string => {
  const configured = process.env.GDRE_MCP_RUNTIME_DIR;
  const directory =
    configured === undefined ? path.join(repositoryRoot, "vendor", "GDRE_tools") : configured;
  if (!isSupportedAbsolutePath(directory)) {
    throw new Error(
      `GDRE_MCP_RUNTIME_DIR must be an absolute supported local path: ${JSON.stringify(configured)}`,
    );
  }
  const executable = path.join(directory, "gdre_tools.exe");
  if (!existsSync(executable)) {
    throw new Error(`GDRE runtime executable is missing: ${executable}`);
  }
  return executable;
};

let ownershipHelperReady: Promise<unknown> | undefined;

const ensureOwnershipHelper = (): Promise<unknown> =>
  (ownershipHelperReady ??= prepareNativeOwnershipHelper(pckPatchOwnershipHelperPath));

export interface OwnedPckStreamOptions {
  /**
   * Observe decoded stream chunks through the existing StreamSink seam. Used to
   * synchronize test-owned cancellation with an observed alive native error,
   * not to alter process execution.
   */
  readonly onStreamText?: (kind: "stdout" | "stderr", text: string) => void;
}

/** Run one fixed argv through the existing owned ProcessRunner and operation storage. */
async function runOwnedPckProcess(
  storage: OperationStorage,
  name: string,
  argv: readonly string[],
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } & OwnedPckStreamOptions = {},
): Promise<ProcessRunResult> {
  await ensureOwnershipHelper();
  const profile = await createFixtureProfile(storage.paths.profile, name);
  const runOptions = {
    executable: pckPatchRuntimeExecutable(),
    argv,
    cwd: profile.cwd,
    env: profile.env,
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: options.signal,
    streamPaths: storage.paths,
    statusPath: path.join(storage.paths.operation, `ownership-${name}.json`),
    helperScriptPath: pckPatchOwnershipHelperPath,
  };
  if (options.onStreamText === undefined) return defaultProcessRunner.run(runOptions);

  // The runner only opens sinks it owns; an observed sink is opened here and
  // closed after the run while delegating every append to the durable files.
  const sink = new DurableFileStreamSink(storage.paths);
  await sink.open();
  const observer: StreamSink = {
    append: async (kind, raw, text) => {
      await sink.append(kind, raw, text);
      options.onStreamText?.(kind, text);
    },
    close: () => sink.close(),
  };
  try {
    return await defaultProcessRunner.run({ ...runOptions, sink: observer });
  } finally {
    await sink.close().catch(() => undefined);
  }
}

export interface OwnedPckCommandResult {
  readonly result: ProcessRunResult;
  readonly operation: OperationPaths;
}

/**
 * Allocate one operation, let the caller build argv from its paths, and run the
 * fixed runtime through the existing owned lifecycle. Stream handles are closed
 * before returning; retained files stay on disk.
 */
export async function runOwnedPckCommand(options: {
  readonly workspace: string;
  readonly name: string;
  readonly buildArgv: (paths: OperationPaths) => readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
} & OwnedPckStreamOptions): Promise<OwnedPckCommandResult> {
  if (!path.isAbsolute(options.workspace)) {
    throw new Error(`owned PCK operation workspace must be absolute: ${options.workspace}`);
  }
  const storage = await OperationStorage.create(options.workspace);
  try {
    const result = await runOwnedPckProcess(
      storage,
      options.name,
      options.buildArgv(storage.paths),
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        onStreamText: options.onStreamText,
      },
    );
    return { result, operation: storage.paths };
  } finally {
    await storage.closeStreams();
  }
}

export interface PckInspectRun {
  readonly result: ProcessRunResult;
  readonly report: Record<string, unknown> | null;
  readonly reportPath: string;
  readonly operation: OperationPaths;
}

/** Run the fixed read-only inspector for one package in its own operation. */
export async function inspectOwnedPck(options: {
  readonly workspace: string;
  readonly packagePath: string;
  readonly name?: string;
  readonly reportPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<PckInspectRun> {
  const name = options.name ?? "inspect";
  let reportPath = options.reportPath ?? "";
  const command = await runOwnedPckCommand({
    workspace: options.workspace,
    name,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    buildArgv: (paths) => {
      reportPath = options.reportPath ?? path.join(paths.operation, `${name}.json`);
      return [
        "--headless",
        "--script",
        nativePath(pckPatchInspectScriptPath),
        "--",
        nativePath(reportPath),
        nativePath(options.packagePath),
      ];
    },
  });
  return {
    result: command.result,
    report: await readPckReport(reportPath),
    reportPath,
    operation: command.operation,
  };
}

export async function readPckReport(reportPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** SHA-256 of an on-disk file, used for original-preservation assertions. */
export const sha256File = async (filename: string): Promise<string> =>
  createHash("sha256").update(await readFile(filename)).digest("hex");
