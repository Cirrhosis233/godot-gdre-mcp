import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const listingExpectedMembers = ["res://hello 空间.txt", "res://project.godot"] as const;
export type ListingExpectedMember = (typeof listingExpectedMembers)[number];
export const listingFixtureContent = {
  project: 'config_version=5\n[application]\nconfig/name="Independently expected listing fixture"\n',
  text: "Controlled listing fixture content.\n",
} as const;

type ZipEntry = readonly [name: string, content: string | Uint8Array];

export interface ListingFixtures {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly importDirectory: string;
  readonly appBundle: string;
  readonly appResourcesDirectory: string;
  readonly appFallbackBundle: string;
  readonly zip: string;
  readonly apk: string;
  readonly xapk: string;
  readonly expectedMembers: readonly ListingExpectedMember[];
  readonly expectedMemberCount: 2;
}

export interface PckFixture {
  readonly path: string;
  readonly format: 0 | 1 | 2 | 3 | 4;
  readonly expectedMembers: readonly ListingExpectedMember[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface CreatePckFixtureOptions {
  readonly runtimeExecutable: string;
  readonly sourceDirectory: string;
  readonly output: string;
  readonly format: 0 | 1 | 2 | 3 | 4;
  readonly engineVersion?: string;
  readonly key?: string;
  /** A fresh, absolute operation/profile working directory; ambient CWD is rejected. */
  readonly cwd: string;
  /** Complete child environment with every profile path explicitly redirected. */
  readonly env: NodeJS.ProcessEnv;
}

const fixtureCreateTimeoutMs = 30_000;
const requiredProfileEnvironment = [
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
  "TEMP",
  "TMP",
  "GDRE_PLUGIN_CACHE_DIR",
] as const;

type RequiredProfileEnvironment = (typeof requiredProfileEnvironment)[number];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Writes an uncompressed ZIP without consulting a shell or a system archiver.
 * The fixture intentionally contains only authored bytes and is independently
 * described by `listingExpectedMembers`.
 */
export async function writeStoredZip(filename: string, entries: readonly ZipEntry[]): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfDirectory = Buffer.alloc(22);
  endOfDirectory.writeUInt32LE(0x06054b50, 0);
  endOfDirectory.writeUInt16LE(entries.length, 8);
  endOfDirectory.writeUInt16LE(entries.length, 10);
  endOfDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfDirectory.writeUInt32LE(offset, 16);
  await writeFile(filename, Buffer.concat([...localParts, centralDirectory, endOfDirectory]), { flag: "wx" });
}

async function writeProjectDirectory(directory: string, marker: ".godot" | ".import"): Promise<void> {
  await mkdir(path.join(directory, marker), { recursive: true });
  await writeFile(path.join(directory, "project.godot"), listingFixtureContent.project, { flag: "wx" });
  await writeFile(path.join(directory, "hello 空间.txt"), listingFixtureContent.text, { flag: "wx" });
}

/**
 * Creates disposable directory/archive fixtures. No runtime output is used to
 * derive the expected member set; all expected values come from authored files.
 * A caller may copy a separately created PCK into the returned app resources
 * directory or ask `createPckFixture` to create one through the fixed runtime.
 */
export async function createListingFixtures(root: string): Promise<ListingFixtures> {
  const sourceDirectory = path.join(root, "project 空间");
  const importDirectory = path.join(root, "project-import 空间");
  const appBundle = path.join(root, "app 空间.app");
  const appResourcesDirectory = path.join(appBundle, "Contents", "Resources");
  const appFallbackBundle = path.join(root, "fallback 空间.app");
  await mkdir(root, { recursive: true });
  await writeProjectDirectory(sourceDirectory, ".godot");
  await writeProjectDirectory(importDirectory, ".import");
  await mkdir(appResourcesDirectory, { recursive: true });
  await mkdir(appFallbackBundle, { recursive: true });

  const zipEntries: readonly ZipEntry[] = [
    ["project.godot", listingFixtureContent.project],
    ["hello 空间.txt", listingFixtureContent.text],
  ];
  const zip = path.join(root, "fixture.zip");
  await writeStoredZip(zip, zipEntries);
  const apk = path.join(root, "fixture.apk");
  await writeStoredZip(apk, [
    ["assets/project.godot", listingFixtureContent.project],
    ["assets/hello 空间.txt", listingFixtureContent.text],
  ]);
  const nestedApk = path.join(root, "xapk-base.apk");
  await writeStoredZip(nestedApk, [
    ["assets/project.godot", listingFixtureContent.project],
    ["assets/hello 空间.txt", listingFixtureContent.text],
  ]);
  const xapk = path.join(root, "fixture.xapk");
  await writeStoredZip(xapk, [
    [
      "manifest.json",
      JSON.stringify({
        split_apks: [
          { id: "base", file: "xapk-base.apk" },
          { id: "installTime", file: "xapk-base.apk" },
        ],
      }),
    ],
    ["xapk-base.apk", await readFile(nestedApk)],
  ]);

  return {
    root,
    sourceDirectory,
    importDirectory,
    appBundle,
    appResourcesDirectory,
    appFallbackBundle,
    zip,
    apk,
    xapk,
    expectedMembers: listingExpectedMembers,
    expectedMemberCount: 2,
  };
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      reject(error);
    });
    child.once("close", (code, signal) => finish(code, signal));
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        const killer = spawn("C:/Windows/System32/taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill());
      } else {
        child.kill();
      }
      // Do not wait indefinitely for a broken fixture process after the tree-kill attempt.
      setTimeout(() => {
        if (!settled) {
          child.kill();
          finish(null, null);
        }
      }, 2_000);
    }, fixtureCreateTimeoutMs);
  });
}

/**
 * Fixture setup only: invokes the provisioned GDRE create command with a
 * fixed, shell-free argv. It is deliberately not a production command adapter.
 */
export async function createPckFixture(options: CreatePckFixtureOptions): Promise<PckFixture> {
  const engineVersion = options.engineVersion ?? "4.4.0";
  if (!path.isAbsolute(options.cwd) || path.resolve(options.cwd) === path.resolve(process.cwd())) {
    throw new Error("GDRE fixture create requires a distinct absolute fresh profile CWD");
  }
  const cwdInfo = await stat(options.cwd).catch(() => null);
  if (cwdInfo === null || !cwdInfo.isDirectory()) {
    throw new Error(`GDRE fixture create profile CWD is not an existing directory: ${options.cwd}`);
  }
  for (const name of requiredProfileEnvironment) {
    const value = options.env[name as RequiredProfileEnvironment];
    if (value === undefined || !path.isAbsolute(value) || value === process.env[name]) {
      throw new Error(`GDRE fixture create requires a fresh absolute ${name} override`);
    }
  }
  const result = await runProcess(
    options.runtimeExecutable,
    [
      "--headless",
      "--no-header",
      "--",
      `--pck-create=${options.sourceDirectory}`,
      `--pck-version=${options.format}`,
      `--pck-engine-version=${engineVersion}`,
      ...(options.key === undefined ? [] : [`--key=${options.key}`]),
      `--output=${options.output}`,
    ],
    { cwd: options.cwd, env: options.env },
  );
  if (result.timedOut) {
    throw new Error(`GDRE fixture create timed out after ${fixtureCreateTimeoutMs} ms: ${options.output}`);
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`GDRE fixture create failed (code=${String(result.code)}, signal=${String(result.signal)}): ${result.stderr || result.stdout}`);
  }
  const outputInfo = await stat(options.output).catch(() => null);
  if (outputInfo === null || !outputInfo.isFile() || outputInfo.size === 0) {
    throw new Error(`GDRE fixture create returned success without a nonempty output: ${options.output}`);
  }
  return {
    path: options.output,
    format: options.format,
    expectedMembers: listingExpectedMembers,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
