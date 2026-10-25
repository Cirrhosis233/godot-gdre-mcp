import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  authorFormat2Pck,
  corruptFirstPckPayloadByte,
  createExtractionInputMatrix,
  listingExtractionFiles,
  type AuthoredExtractionFile,
} from "./support/extraction-input-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ?? path.join(repositoryRoot, "vendor", "GDRE_tools");
const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  GDRE_MCP_CONFIG: configFile,
});

/** Finite client watchdog for these controlled fixture workloads. */
const clientRequestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };

type AnyRecord = Record<string, any>;

interface StartedExtractionClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

interface StartOptions {
  readonly defaults?: Record<string, unknown>;
}

async function startClient(options: StartOptions = {}): Promise<StartedExtractionClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-extract-inputs-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller cwd");
  await mkdir(callerCwd, { recursive: true });
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory,
      targetVersion: "2.8.0-beta.2",
      timeouts: { maxMs: 120_000 },
      defaults: options.defaults ?? {},
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: childEnvironment(configFile),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-21-extraction-inputs-stdio", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedExtractionClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const hashFile = async (file: string): Promise<string> =>
  createHash("sha256").update(await readFile(file)).digest("hex");

async function walk(root: string): Promise<{ readonly files: string[]; readonly directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await visit(root, "");
  return { files, directories };
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

interface SourceSnapshot {
  readonly target: string;
  readonly kind: "file" | "directory";
  readonly digest: string;
}

async function snapshotSource(target: string): Promise<SourceSnapshot> {
  const walked = await walk(target).catch(() => null);
  if (walked === null) {
    return { target, kind: "file", digest: await hashFile(target) };
  }
  const lines: string[] = [];
  for (const directory of [...walked.directories].sort()) lines.push(`d ${directory}`);
  for (const file of [...walked.files].sort()) {
    lines.push(`f ${file} ${await hashFile(path.join(target, ...file.split("/")))}`);
  }
  return {
    target,
    kind: "directory",
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}

async function assertSourcesUnchanged(snapshots: readonly SourceSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    assert.deepEqual(
      await snapshotSource(snapshot.target),
      snapshot,
      `authored source is input only: ${snapshot.target}`,
    );
  }
}

function expectedDirectories(files: readonly AuthoredExtractionFile[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.relative.split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = index === 0 ? parts[0]! : `${prefix}/${parts[index]!}`;
      directories.add(prefix);
    }
  }
  return [...directories].sort();
}

function diagnostic(result: AnyRecord): string {
  return JSON.stringify({
    error: result?.error,
    semantic: result?.semantic,
    process: result?.process,
    stdout: result?.stdout?.text,
    stderr: result?.stderr?.text,
  });
}

async function callExtract(
  client: Client,
  arguments_: AnyRecord,
): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord }> {
  const wire = await client.callTool({ name: "gdre_extract", arguments: arguments_ }, clientRequestOptions) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
}

type VerificationExpectation = "verified" | "not-applicable";

/**
 * Assert one positive extraction through externally observable evidence:
 * destination bytes/hashes, member-set exactness, complete inventory/manifest,
 * and source provenance. The runtime's `gdre_export.log` is administrative and
 * never counted as authored member content.
 */
async function assertPositiveExtraction(options: {
  readonly wire: AnyRecord;
  readonly result: AnyRecord;
  readonly inputPath: string;
  /** Ordered literal inputs emitted as repeated --extract tokens. Defaults to inputPath. */
  readonly inputPaths?: readonly string[];
  readonly expectedFiles: readonly AuthoredExtractionFile[];
  readonly verification: VerificationExpectation;
  readonly outputSource?: "call" | "builtin";
  readonly sessionSource?: "call" | "config" | "builtin";
  /** Ordered session flags emitted immediately after the application separator. */
  readonly sessionArgs?: readonly string[];
  readonly dependencySuffixes?: readonly string[];
  readonly expectedEffectiveOutput?: string;
  readonly representativeContent?: string;
  /**
   * Canonical root where artifact/inventory entries are expected. Defaults to
   * the effective destination display path; an accepted junction destination
   * must inventory its physical target instead of a root link.
   */
  readonly actualArtifactRoot?: string;
}): Promise<void> {
  const { wire, result, expectedFiles } = options;
  assert.equal(wire.isError, false, diagnostic(result));
  assert.equal(result.success, true, diagnostic(result));
  assert.equal(result.commandId, "extract");
  assert.equal(result.status, "succeeded", diagnostic(result));
  assert.equal(result.error, null, diagnostic(result));
  assert.equal(result.process.exitCode, 0, diagnostic(result));
  assert.equal(result.process.signal, null, diagnostic(result));
  assert.equal(typeof result.process.pid, "number");
  assert.equal(result.semantic.status, "succeeded", diagnostic(result));
  assert.equal(result.semantic.rule, "gdre-extract-v1");
  assert.equal(result.semantic.data.totalFiles, expectedFiles.length);
  assert.equal(result.semantic.data.extractedFiles, expectedFiles.length);
  assert.equal(result.semantic.data.checksum, "default");

  const effective = result.paths.effectiveDestination as string;
  assert.ok(path.isAbsolute(effective), "effective destination is absolute");
  const artifactRoot = options.actualArtifactRoot ?? effective;
  assert.equal(result.semantic.data.outputPath, effective);
  if (options.expectedEffectiveOutput !== undefined) {
    assert.equal(effective, options.expectedEffectiveOutput);
  }

  // Exact expected member set plus the administrative runtime log.
  const expectedDirs = expectedDirectories(expectedFiles);
  const destination = await walk(effective);
  assert.deepEqual(
    [...destination.files].sort(),
    [...expectedFiles.map((file) => file.relative), "gdre_export.log"].sort(),
  );
  assert.deepEqual([...destination.directories].sort(), [...expectedDirs]);
  for (const file of expectedFiles) {
    const extracted = await readFile(path.join(effective, ...file.relative.split("/")));
    assert.deepEqual(extracted, file.bytes, `exact bytes for ${file.relative}`);
    assert.equal(createHash("sha256").update(extracted).digest("hex"), file.sha256, file.relative);
  }

  // Complete bounded response plus complete retained inventory.
  const expectedEntryCount = expectedFiles.length + expectedDirs.length + 1;
  assert.equal(result.artifacts.complete, true);
  assert.equal(result.artifacts.truncated, false);
  assert.equal(result.artifacts.count, expectedEntryCount);
  assert.equal((result.artifacts.items as AnyRecord[]).length, expectedEntryCount);
  const itemsByPath = new Map(
    (result.artifacts.items as AnyRecord[]).map((entry) => [entry.path as string, entry]),
  );
  for (const file of expectedFiles) {
    const entry = itemsByPath.get(path.join(artifactRoot, ...file.relative.split("/")));
    assert.ok(entry, file.relative);
    assert.equal(entry.role, "extracted", file.relative);
    assert.equal(entry.bytes, file.size, file.relative);
    assert.equal(entry.sha256, file.sha256, file.relative);
  }
  const logEntry = itemsByPath.get(path.join(artifactRoot, "gdre_export.log"));
  assert.ok(logEntry, "runtime log is inventoried separately");
  assert.equal(logEntry.role, "administrative-log");
  assert.equal(typeof logEntry.bytes, "number");
  assert.equal(String(logEntry.sha256).length, 64);

  const inventory = await readJson(result.paths.artifactInventory);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.errors, []);
  assert.equal(inventory.entries.length, expectedEntryCount);
  const inventoryByPath = new Map(
    (inventory.entries as AnyRecord[]).map((entry) => [entry.path as string, entry]),
  );
  for (const file of expectedFiles) {
    const entry = inventoryByPath.get(path.join(artifactRoot, ...file.relative.split("/")));
    assert.equal(entry?.kind, "file", file.relative);
    assert.equal(entry?.bytes, file.size, file.relative);
    assert.equal(entry?.sha256, file.sha256, file.relative);
    assert.equal(entry?.error, null, file.relative);
  }
  for (const directory of expectedDirs) {
    const entry = inventoryByPath.get(path.join(artifactRoot, ...directory.split("/")));
    assert.equal(entry?.kind, "directory", directory);
    assert.equal(entry?.error, null, directory);
  }
  assert.equal(inventoryByPath.get(path.join(artifactRoot, "gdre_export.log"))?.kind, "file");

  // Raw streams are complete; checksum claims follow the actual source family.
  const rawStdout = await readFile(result.stdout.rawPath);
  assert.equal(result.stdout.complete, true);
  assert.equal(result.stdout.bytes, rawStdout.byteLength);
  const stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(rawStdout);
  assert.ok(stdoutText.includes(`Extracted ${String(expectedFiles.length)} files, no errors detected!`));
  assert.ok(result.semantic.evidence.some((line: string) => line.includes(`Extracted ${String(expectedFiles.length)} files`)));
  if (options.verification === "verified") {
    assert.ok(
      /(?:^|[\r\n])Verified [0-9]+ files, (?:no errors detected!|[0-9]+ files skipped \(MD5 hash entry was empty\))/u.test(stdoutText),
      diagnostic(result),
    );
    assert.ok(result.semantic.evidence.some((line: string) => /^Verified [0-9]+ files/u.test(line)));
  } else {
    assert.equal(/(?:^|[\r\n])Verified [0-9]+ files/u.test(stdoutText), false, "non-PCK source must not claim PCK MD5 verification");
    assert.equal(result.semantic.evidence.some((line: string) => /^Verified [0-9]+ files/u.test(line)), false);
    assert.ok(result.semantic.evidence.some((line: string) => line.includes("non-PCK")));
  }

  // Manifest: exact argv/destination/preflight and complete source graph.
  const manifest = await readJson(result.paths.manifest);
  assert.equal(manifest.state, "succeeded");
  assert.equal(manifest.status, "succeeded");
  assert.equal(manifest.success, true);
  assert.deepEqual(manifest.invocation.argv, [
    "--headless",
    "--no-header",
    "--",
    ...(options.sessionArgs ?? []),
    ...(options.inputPaths ?? [options.inputPath]).map((value) => `--extract=${value}`),
    `--output=${effective}`,
  ]);
  assert.equal(manifest.invocation.cwd, result.paths.operation);
  assert.equal(manifest.process.pid, result.process.pid);
  assert.equal(manifest.process.exitCode, 0);
  assert.equal(manifest.parameterSources.inputs, "call");
  assert.equal(manifest.parameterSources.output, options.outputSource ?? "builtin");
  assert.equal(manifest.parameterSources.session, options.sessionSource ?? "call");
  assert.equal(manifest.paths.effectiveDestination, effective);
  assert.equal(manifest.paths.output, result.paths.output);
  assert.ok((manifest.invocation.inputPaths as AnyRecord[]).some(
    (entry) => entry.role === "input" && pathIdentityEquals(entry.path, options.inputPath),
  ));
  for (const suffix of options.dependencySuffixes ?? []) {
    const dependency = (manifest.invocation.inputPaths as AnyRecord[]).find(
      (entry) => entry.role === "dependency" && String(entry.path).endsWith(suffix),
    );
    assert.ok(dependency, `dependency provenance for ${suffix}`);
    assert.equal(String(dependency.sha256).length, 64);
  }

  const preflight = manifest.preflight as AnyRecord;
  assert.ok(preflight, "internal preflight evidence is retained");
  assert.equal(preflight.semantic.status, "succeeded");
  assert.equal(preflight.process.exitCode, 0);
  const expectedMembers = await readJson(preflight.expectedMembers.path);
  assert.equal(expectedMembers.complete, true);
  assert.deepEqual(
    [...expectedMembers.members].sort(),
    expectedFiles.map((file) => `res://${file.relative}`).sort(),
  );

  if (options.representativeContent !== undefined) {
    assert.equal(
      JSON.stringify(result).includes(options.representativeContent),
      false,
      "extracted content is never inlined in the response",
    );
  }
}

const pathIdentityEquals = (left: string, right: string): boolean =>
  path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();

test("real stdio extracts every assigned input form with independently expected bytes", async (t) => {
  const started = await startClient();
  try {
    const matrix = await createExtractionInputMatrix({
      fixtureRoot: path.join(started.workspace, "fixtures"),
      runtimeExecutable: path.join(runtimeDirectory, "gdre_tools.exe"),
    });

    // Controlled layout preconditions, independent of product output.
    assert.deepEqual((await walk(matrix.markedDirectory)).directories, [".godot"]);
    assert.deepEqual(
      await walk(matrix.appResourcesBundle),
      { files: ["Contents/Resources/resources.pck"], directories: ["Contents", "Contents/Resources"] },
    );
    assert.deepEqual(
      await walk(matrix.appFallbackBundle),
      { files: ["fallback.pck"], directories: [] },
    );
    assert.deepEqual(
      (await walk(matrix.fixtureRoot)).files.filter((file) => file.endsWith(".pck")).length >= 5,
      true,
    );

    interface Case {
      readonly label: string;
      readonly input: string;
      readonly relative: boolean;
      readonly verification: VerificationExpectation;
      readonly sources: readonly string[];
      readonly dependencySuffixes?: readonly string[];
    }

    const cases: readonly Case[] = [
      ...([0, 1, 2, 3, 4] as const).map((format): Case => ({
        label: `unencrypted PCK format ${String(format)}`,
        input: matrix.pcks.get(format)!,
        relative: true,
        verification: "verified",
        sources: [matrix.pcks.get(format)!],
      })),
      { label: "stored ZIP", input: matrix.listing.zip, relative: true, verification: "not-applicable", sources: [matrix.listing.zip] },
      { label: "assets-only APK", input: matrix.listing.apk, relative: true, verification: "not-applicable", sources: [matrix.listing.apk] },
      { label: "XAPK", input: matrix.listing.xapk, relative: false, verification: "not-applicable", sources: [matrix.listing.xapk] },
      { label: "marked source directory", input: matrix.markedDirectory, relative: true, verification: "not-applicable", sources: [matrix.markedDirectory] },
      {
        label: ".app Resources layout",
        input: matrix.appResourcesBundle,
        relative: true,
        verification: "verified",
        sources: [matrix.appResourcesBundle],
        dependencySuffixes: [path.join("Contents", "Resources", "resources.pck")],
      },
      {
        label: ".app root fallback with exactly one pack",
        input: matrix.appFallbackBundle,
        relative: true,
        verification: "verified",
        sources: [matrix.appFallbackBundle],
        dependencySuffixes: ["fallback.pck"],
      },
      {
        label: "executable sidecar dependency",
        input: matrix.sidecarExecutable,
        relative: false,
        verification: "verified",
        sources: [matrix.sidecarExecutable, matrix.sidecarPck],
        dependencySuffixes: ["sidecar 空间.pck"],
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.label, async () => {
        const snapshots = await Promise.all(testCase.sources.map(snapshotSource));
        const absoluteInput = path.resolve(testCase.input);
        const passedInput = testCase.relative
          ? path.relative(started.workspace, absoluteInput)
          : absoluteInput;
        const { wire, result } = await callExtract(started.client, {
          inputs: [{ kind: "path", path: passedInput }],
          session: [],
        });
        await assertPositiveExtraction({
          wire,
          result,
          inputPath: absoluteInput,
          expectedFiles: listingExtractionFiles,
          verification: testCase.verification,
          dependencySuffixes: testCase.dependencySuffixes,
          representativeContent: "Independently expected listing fixture",
        });
        await assertSourcesUnchanged(snapshots);
      });
    }
  } finally {
    await closeClient(started);
  }
});

test("real stdio honors omitted, relative, absolute, space, and Unicode destinations", async (t) => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "authored");
    await mkdir(fixtureRoot, { recursive: true });
    const expectedFiles = await authorFormat2Pck(path.join(fixtureRoot, "单元 空间.pck"), [
      { relative: "project.godot", bytes: Buffer.from("config_version=5\n") },
      { relative: "data/值 空格.txt", bytes: Buffer.from("destination matrix 内容\n", "utf8") },
      { relative: "data/nested/binary.bin", bytes: Buffer.from([0, 1, 0x7f, 0x80, 0xfe, 0xff]) },
    ]);
    const input = path.join(fixtureRoot, "单元 空间.pck");
    const inputSnapshot = await snapshotSource(input);
    const relativeOnly = path.relative(started.workspace, input);

    await t.test("omitted output uses a sibling of the admitted input", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeOnly }],
        session: [],
      });
      const expectedSibling = path.join(
        fixtureRoot,
        `单元 空间-extracted-${path.basename(result.paths.operation!)}`,
      );
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        outputSource: "builtin",
        expectedEffectiveOutput: expectedSibling,
      });
      assert.notEqual(result.paths.effectiveDestination, result.paths.output);
      assert.equal(result.paths.output, path.join(result.paths.operation, "output"));
      assert.deepEqual(
        await readdirSafe(result.paths.output),
        [],
        "internal output stays empty",
      );
    });

    await t.test("relative output with spaces and Unicode resolves under the workspace", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeOnly }],
        output: "results/输出 space",
        session: [],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        outputSource: "call",
        expectedEffectiveOutput: path.join(started.workspace, "results", "输出 space"),
      });
      assert.notEqual(result.paths.effectiveDestination, result.paths.output);
      assert.equal(result.paths.output, path.join(result.paths.operation, "output"));
    });

    await t.test("absolute output outside the workspace is honored exactly", async () => {
      const destination = path.join(started.root, "外部 results", "absolute 空间");
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: input }],
        output: destination,
        session: [],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        outputSource: "call",
        expectedEffectiveOutput: destination,
      });
    });

    await t.test("repeated calls own distinct destinations", async () => {
      const first = await callExtract(started.client, { inputs: [{ kind: "path", path: relativeOnly }], session: [] });
      await assertPositiveExtraction({
        wire: first.wire,
        result: first.result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
      });
      const second = await callExtract(started.client, { inputs: [{ kind: "path", path: relativeOnly }], session: [] });
      await assertPositiveExtraction({
        wire: second.wire,
        result: second.result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
      });
      assert.notEqual(first.result.paths.operation, second.result.paths.operation);
      assert.notEqual(first.result.paths.output, second.result.paths.output);
      assert.notEqual(first.result.paths.effectiveDestination, second.result.paths.effectiveDestination);
      for (const result of [first.result, second.result]) {
        assert.equal(
          result.paths.effectiveDestination,
          path.join(
            fixtureRoot,
            `单元 空间-extracted-${path.basename(result.paths.operation)}`,
          ),
        );
        assert.notEqual(result.paths.effectiveDestination, result.paths.output);
      }
    });

    await assertSourcesUnchanged([inputSnapshot]);
  } finally {
    await closeClient(started);
  }
});

test("real stdio rejects nonempty, file, and overlapping explicit destinations truthfully", async (t) => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "destination conflicts");
    await mkdir(fixtureRoot, { recursive: true });
    await authorFormat2Pck(path.join(fixtureRoot, "conflict input.pck"), [
      { relative: "project.godot", bytes: Buffer.from("config_version=5\n") },
    ]);
    const input = path.join(fixtureRoot, "conflict input.pck");
    const inputSnapshot = await snapshotSource(input);
    const relativeInput = path.relative(started.workspace, input);

    const assertRejectedBeforeProcess = async (
      wire: AnyRecord,
      result: AnyRecord,
      label: string,
      rejectedDestination: string,
    ): Promise<AnyRecord> => {
      assert.equal(wire.isError, true, `${label}: ${diagnostic(result)}`);
      assert.equal(result.success, false, label);
      assert.equal(result.status, "failed", label);
      assert.equal(result.process.pid, null, label);
      assert.equal(result.error.code, "path_unsupported", label);
      assert.ok(result.paths.manifest, label);
      const manifest = await readJson(result.paths.manifest);
      assert.equal(manifest.state, "failed", label);
      assert.equal(manifest.process.pid, null, label);
      assert.equal(manifest.error.code, "path_unsupported", label);
      assert.equal(manifest.paths.effectiveDestination, null, label);
      assert.equal(
        (manifest.effects.writes as string[]).some((value) => pathIdentityEquals(value, rejectedDestination)),
        false,
        `${label}: rejected destination is not a planned write`,
      );
      return manifest;
    };

    await t.test("nonempty destination is rejected without touching its contents", async () => {
      const destination = path.join(started.workspace, "occupied target");
      await mkdir(destination, { recursive: true });
      const sentinel = path.join(destination, "sentinel.txt");
      await writeFile(sentinel, "pre-existing\n", "utf8");
      const before = await snapshotSource(destination);

      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeInput }],
        output: "occupied target",
        session: [],
      });
      await assertRejectedBeforeProcess(wire, result, "nonempty destination", destination);
      await assertSourcesUnchanged([before]);
      assert.deepEqual((await walk(destination)).files, ["sentinel.txt"]);
    });

    await t.test("existing file destination is rejected", async () => {
      const destination = path.join(started.workspace, "target is a file");
      await writeFile(destination, "not a directory\n", "utf8");
      const before = await snapshotSource(destination);
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeInput }],
        output: "target is a file",
        session: [],
      });
      await assertRejectedBeforeProcess(wire, result, "file destination", destination);
      await assertSourcesUnchanged([before]);
    });

    await t.test("destination overlapping the source directory is rejected", async () => {
      const source = path.join(started.workspace, "source project");
      await mkdir(path.join(source, ".godot"), { recursive: true });
      await writeFile(path.join(source, "project.godot"), "config_version=5\n", "utf8");
      const sourceBefore = await snapshotSource(source);
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: "source project" }],
        output: "source project/extracted",
        session: [],
      });
      await assertRejectedBeforeProcess(wire, result, "overlapping destination", path.join(source, "extracted"));
      await assertSourcesUnchanged([sourceBefore]);
      assert.equal(
        await walk(path.join(source, "extracted")).then(() => true).catch(() => false),
        false,
        "overlapping destination is never created",
      );
    });

    await assertSourcesUnchanged([inputSnapshot]);
  } finally {
    await closeClient(started);
  }
});

test("real stdio preserves literal and glob ordering for disjoint multi-input packages", async (t) => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "multi input");
    await mkdir(fixtureRoot, { recursive: true });
    const alphaMembers = [
      { relative: "alpha/one.txt", bytes: Buffer.from("alpha one\n", "utf8") },
      { relative: "alpha/共享 空间.bin", bytes: Buffer.from([0x00, 0x41, 0x42, 0xff]) },
    ] as const;
    const betaMembers = [
      { relative: "beta/two.txt", bytes: Buffer.from("beta two\n", "utf8") },
      { relative: "beta/二.bin", bytes: Buffer.from([0x10, 0x20, 0x30, 0x00]) },
    ] as const;
    const alpha = path.join(fixtureRoot, "alpha.pck");
    const beta = path.join(fixtureRoot, "beta.pck");
    const alphaFiles = await authorFormat2Pck(alpha, alphaMembers);
    const betaFiles = await authorFormat2Pck(beta, betaMembers);
    const expectedFiles = [...alphaFiles, ...betaFiles];
    const snapshots = await Promise.all([snapshotSource(alpha), snapshotSource(beta)]);

    await t.test("literal multi-input preserves supplied order and disjoint members", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [
          { kind: "path", path: "multi input/beta.pck" },
          { kind: "path", path: "multi input/alpha.pck" },
        ],
        session: [],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: beta,
        inputPaths: [beta, alpha],
        expectedFiles,
        verification: "verified",
      });
      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(
        (manifest.invocation.argv as string[]).filter((token) => token.startsWith("--extract=")),
        [`--extract=${beta}`, `--extract=${alpha}`],
        "literal input order is not rewritten",
      );
      assert.deepEqual(manifest.requestedParameters.inputs, [
        { kind: "path", path: "multi input/beta.pck" },
        { kind: "path", path: "multi input/alpha.pck" },
      ]);
    });

    await t.test("glob expansion is ordered and emits absolute literal inputs", async () => {
      const globRoot = path.join(started.workspace, "glob packs");
      await mkdir(globRoot, { recursive: true });
      const packOne = path.join(globRoot, "pack-1.pck");
      const packTwo = path.join(globRoot, "pack-2.pck");
      await writeFile(packOne, await readFile(alpha));
      await writeFile(packTwo, await readFile(beta));
      const globSnapshots = await Promise.all([snapshotSource(packOne), snapshotSource(packTwo)]);

      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "glob", pattern: "glob packs/*.pck" }],
        session: [],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: packOne,
        inputPaths: [packOne, packTwo],
        expectedFiles,
        verification: "verified",
      });
      const manifest = await readJson(result.paths.manifest);
      const extracts = (manifest.invocation.argv as string[])
        .filter((token) => token.startsWith("--extract="))
        .map((token) => token.slice("--extract=".length));
      assert.deepEqual(extracts.map((value) => path.basename(value)), ["pack-1.pck", "pack-2.pck"]);
      assert.equal(extracts.every((value) => path.isAbsolute(value)), true);
      assert.deepEqual(
        (manifest.invocation.inputPaths as AnyRecord[]).filter((entry) => entry.role === "input").map((entry) => entry.path),
        [packOne, packTwo],
      );
      await assertSourcesUnchanged(globSnapshots);
    });

    await assertSourcesUnchanged(snapshots);
  } finally {
    await closeClient(started);
  }
});

test("real stdio applies configured session defaults and replaces them with an explicit empty list", async (t) => {
  const configuredSession = [{ kind: "multithreading", disabled: false }] as const;
  const started = await startClient({ defaults: { extract: { session: configuredSession } } });
  try {
    const fixtureRoot = path.join(started.workspace, "session");
    await mkdir(fixtureRoot, { recursive: true });
    const expectedFiles = await authorFormat2Pck(path.join(fixtureRoot, "session.pck"), [
      { relative: "project.godot", bytes: Buffer.from("config_version=5\n") },
    ]);
    const input = path.join(fixtureRoot, "session.pck");
    const relativeInput = path.relative(started.workspace, input);
    const snapshot = await snapshotSource(input);

    await t.test("omitted session uses the configured default", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeInput }],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        sessionSource: "config",
        sessionArgs: ["--disable-multithreading=false"],
      });
      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(manifest.session, [...configuredSession]);
    });

    await t.test("explicit empty session replaces the configured default", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeInput }],
        session: [],
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        sessionSource: "call",
      });
      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(manifest.session, []);
      assert.equal(
        (manifest.invocation.argv as string[]).some((token) => token.startsWith("--disable-multithreading")),
        false,
      );
    });

    await t.test("ordered session actions are emitted in order", async () => {
      const session = [
        { kind: "multithreading", disabled: true },
        { kind: "multithreading", disabled: false },
      ];
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: relativeInput }],
        session,
      });
      await assertPositiveExtraction({
        wire,
        result,
        inputPath: input,
        expectedFiles,
        verification: "verified",
        sessionSource: "call",
        sessionArgs: ["--disable-multithreading=true", "--disable-multithreading=false"],
      });
      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(manifest.session, session);
    });

    await assertSourcesUnchanged([snapshot]);
  } finally {
    await closeClient(started);
  }
});

test("real stdio rejects deferred extraction fields through discovery and SDK schema validation", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "deferred");
    await mkdir(fixtureRoot, { recursive: true });
    await authorFormat2Pck(path.join(fixtureRoot, "deferred.pck"), [
      { relative: "project.godot", bytes: Buffer.from("config_version=5\n") },
    ]);
    const relativeInput = "deferred/deferred.pck";

    const tools = (await started.client.listTools()).tools;
    const extractTool = tools.find((tool) => tool.name === "gdre_extract");
    assert.ok(extractTool, "gdre_extract is discoverable");
    assert.deepEqual(extractTool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    const schema = extractTool.inputSchema as AnyRecord;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties as AnyRecord).sort(),
      ["exclude", "include", "inputs", "output", "selection", "session", "timeoutMs", "workspace"],
    );
    for (const deferred of ["key", "checksum"]) {
      assert.equal(Object.hasOwn(schema.properties as AnyRecord, deferred), false, `${deferred} is deferred`);
    }

    const operationsDirectory = path.join(started.workspace, ".gdre", "operations");
    const before = await readdirSafe(operationsDirectory);
    const deferredCalls: readonly AnyRecord[] = [
      { checksum: "skip" },
      { key: "0123456789abcdef".repeat(4) },
    ];
    for (const deferred of deferredCalls) {
      const wire = await started.client.callTool({
        name: "gdre_extract",
        arguments: { inputs: [{ kind: "path", path: relativeInput }], ...deferred },
      }, clientRequestOptions) as AnyRecord;
      assert.equal(wire.isError, true, JSON.stringify(deferred));
      assert.equal(wire.structuredContent, undefined, JSON.stringify(deferred));
    }
    assert.deepEqual(await readdirSafe(operationsDirectory), before);
  } finally {
    await closeClient(started);
  }
});

test("real stdio fails a checksum-corrupt PCK through default verification evidence", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "checksum");
    await mkdir(fixtureRoot, { recursive: true });
    const pck = path.join(fixtureRoot, "checksum corrupt.pck");
    await authorFormat2Pck(pck, [
      {
        relative: "project.godot",
        bytes: Buffer.from('config_version=5\n[application]\nconfig/name="checksum fixture"\n'),
      },
      { relative: "data/payload.bin", bytes: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) },
    ]);
    await corruptFirstPckPayloadByte(pck);
    const before = await snapshotSource(pck);

    const { wire, result } = await callExtract(started.client, {
      inputs: [{ kind: "path", path: "checksum/checksum corrupt.pck" }],
      session: [],
    });

    // The package loads and lists, but the actual extraction fails checksum
    // verification under the default (no-override) policy.
    assert.equal(wire.isError, true, diagnostic(result));
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.commandId, "extract");
    assert.equal(typeof result.process.pid, "number");
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.process.signal, null);
    assert.notEqual(result.error, null);
    assert.equal(result.error.code, "process_failed");
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.semantic.data, null);

    const effective = result.paths.effectiveDestination as string;
    assert.ok(path.isAbsolute(effective));
    const destination = await walk(effective);
    assert.deepEqual(destination.files, ["gdre_export.log"], "no member is reported as extracted");
    assert.deepEqual(destination.directories, []);

    // The adapter does not inventory/hash a destination after a known process failure.
    // The independent test inspection above still observes the retained administrative log.
    assert.equal(result.artifacts.complete, false);
    assert.equal(result.artifacts.count, 0);
    assert.deepEqual(result.artifacts.items, []);
    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);

    // Raw process evidence retains the runtime's checksum diagnostics.
    const rawStdout = await readFile(result.stdout.rawPath);
    const rawStderr = await readFile(result.stderr.rawPath);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stderr.complete, true);
    assert.equal(result.stdout.bytes, rawStdout.byteLength);
    assert.equal(result.stderr.bytes, rawStderr.byteLength);
    const stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(rawStdout);
    const stderrText = new TextDecoder("utf-8", { fatal: true }).decode(rawStderr);
    assert.match(stdoutText, /MD5 checksum failed|Checksum failed/iu);
    assert.match(stdoutText, /failed to extract PAK file|not exporting assets/iu);
    assert.match(stderrText, /Checksum failed for res:\/\/project\.godot/u);
    assert.match(stderrText, /At least one error was detected/u);
    assert.equal(stdoutText.includes("Extracted 2 files"), false);
    assert.equal(stdoutText.includes("Verified 2 files"), false);

    // Manifest keeps the actual extraction invocation and default policy.
    const manifest = await readJson(result.paths.manifest);
    assert.equal(manifest.state, "failed");
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.success, false);
    assert.equal(manifest.error.code, result.error.code);
    assert.equal(manifest.process.pid, result.process.pid);
    assert.equal(manifest.process.exitCode, 1);
    assert.equal(manifest.process.signal, null);
    assert.deepEqual(manifest.invocation.argv, [
      "--headless",
      "--no-header",
      "--",
      `--extract=${pck}`,
      `--output=${effective}`,
    ]);
    for (const override of ["--skip-checksum-check", "--ignore-checksum-errors"]) {
      assert.equal((manifest.invocation.argv as string[]).includes(override), false, override);
    }
    const preflight = manifest.preflight as AnyRecord;
    assert.equal(preflight.semantic.status, "succeeded");
    assert.equal(preflight.expectedMembers.count, 2);
    assert.equal(preflight.process.exitCode, 0);

    await assertSourcesUnchanged([before]);
  } finally {
    await closeClient(started);
  }
});

test("real stdio extracts through an explicit junction destination with canonical inventory", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "junction input");
    await mkdir(fixtureRoot, { recursive: true });
    const expectedFiles = await authorFormat2Pck(path.join(fixtureRoot, "junction.pck"), [
      { relative: "project.godot", bytes: Buffer.from('config_version=5\nconfig/name="junction fixture"\n') },
      { relative: "data/nested 空间.bin", bytes: Buffer.from([0x00, 0x10, 0x20, 0x7f, 0x80, 0xff]) },
    ]);
    const input = path.join(fixtureRoot, "junction.pck");
    const snapshot = await snapshotSource(input);

    // The explicit destination is the junction itself, pointing at a fresh
    // empty physical directory. The alias is an accepted display path.
    const physical = path.join(started.root, "physical output");
    await mkdir(physical);
    const junction = path.join(started.root, "junction output");
    await symlink(physical, junction, "junction");
    assert.equal((await lstat(junction)).isSymbolicLink(), true, "fixture is a junction");
    const canonicalPhysical = await realpath(physical);

    const { wire, result } = await callExtract(started.client, {
      inputs: [{ kind: "path", path: input }],
      output: junction,
      session: [],
    });
    await assertPositiveExtraction({
      wire,
      result,
      inputPath: input,
      expectedFiles,
      verification: "verified",
      outputSource: "call",
      expectedEffectiveOutput: junction,
      actualArtifactRoot: canonicalPhysical,
    });

    // Accepted display path is preserved in the result and CLI argv; the owned
    // operation output remains a separate empty directory.
    assert.equal(result.paths.effectiveDestination, junction);
    assert.equal(result.paths.output, path.join(result.paths.operation, "output"));
    assert.notEqual(result.paths.output, junction);
    assert.deepEqual(await walk(result.paths.output), { files: [], directories: [] });
    const manifest = await readJson(result.paths.manifest);
    assert.equal(manifest.paths.effectiveDestination, junction);
    assert.deepEqual((manifest.invocation.argv as string[]).slice(-2), [
      `--extract=${input}`,
      `--output=${junction}`,
    ]);

    // Exact physical member set and bytes, independent of the alias display.
    const physicalWalk = await walk(canonicalPhysical);
    assert.deepEqual(
      [...physicalWalk.files].sort(),
      [...expectedFiles.map((file) => file.relative), "gdre_export.log"].sort(),
    );
    assert.deepEqual([...physicalWalk.directories].sort(), expectedDirectories(expectedFiles));
    for (const file of expectedFiles) {
      const extracted = await readFile(path.join(canonicalPhysical, ...file.relative.split("/")));
      assert.deepEqual(extracted, file.bytes, file.relative);
      assert.equal(createHash("sha256").update(extracted).digest("hex"), file.sha256, file.relative);
    }

    // The retained inventory is canonical physical entries with complete
    // hashes, never a single alias-root link entry.
    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.complete, true);
    assert.deepEqual(inventory.errors, []);
    const entries = inventory.entries as AnyRecord[];
    const physicalPrefix = `${path.normalize(canonicalPhysical).toLowerCase()}${path.sep}`;
    assert.equal(entries.some((entry) => entry.kind === "link"), false);
    assert.equal(entries.some((entry) => pathIdentityEquals(entry.path, junction)), false);
    for (const entry of entries) {
      assert.ok(
        path.normalize(entry.path as string).toLowerCase().startsWith(physicalPrefix),
        `inventory entry is canonical physical: ${String(entry.path)}`,
      );
    }
    const inventoryByPath = new Map(entries.map((entry) => [entry.path as string, entry]));
    for (const file of expectedFiles) {
      const entry = inventoryByPath.get(path.join(canonicalPhysical, ...file.relative.split("/")));
      assert.equal(entry?.kind, "file", file.relative);
      assert.equal(entry?.role, "extracted", file.relative);
      assert.equal(entry?.bytes, file.size, file.relative);
      assert.equal(entry?.sha256, file.sha256, file.relative);
    }
    const logEntry = inventoryByPath.get(path.join(canonicalPhysical, "gdre_export.log"));
    assert.equal(logEntry?.kind, "file");
    assert.equal(logEntry?.role, "administrative-log");
    assert.equal(String(logEntry?.sha256).length, 64);
    for (const item of result.artifacts.items as AnyRecord[]) {
      assert.ok(
        path.normalize(item.path as string).toLowerCase().startsWith(physicalPrefix),
        `bounded artifact item is canonical physical: ${String(item.path)}`,
      );
    }

    await assertSourcesUnchanged([snapshot]);
  } finally {
    await closeClient(started);
  }
});

test("real stdio retains truthful failure evidence for missing and corrupt inputs", async (t) => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "failures");
    await mkdir(fixtureRoot, { recursive: true });

    await t.test("missing input fails before any extraction process", async () => {
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: "failures/missing input.pck" }],
        session: [],
      });
      assert.equal(wire.isError, true, diagnostic(result));
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.process.pid, null);
      assert.equal(result.error.code, "path_unsupported");
      assert.equal(result.semantic.status, "not_evaluated");
      assert.ok(result.paths.manifest, "failure evidence is retained");
      const manifest = await readJson(result.paths.manifest);
      assert.equal(manifest.state, "failed");
      assert.equal(manifest.process.pid, null);
      assert.equal(manifest.error.code, "path_unsupported");
      assert.deepEqual(await walk(result.paths.output).catch(() => ({ files: [], directories: [] })), {
        files: [],
        directories: [],
      });
    });

    await t.test("corrupt input retains failed preflight evidence and launches no extraction", async () => {
      const corrupt = path.join(fixtureRoot, "corrupt.pck");
      await writeFile(corrupt, "this is not a PCK package\n", "utf8");
      const before = await snapshotSource(corrupt);
      const { wire, result } = await callExtract(started.client, {
        inputs: [{ kind: "path", path: "failures/corrupt.pck" }],
        session: [],
      });
      assert.equal(wire.isError, true, diagnostic(result));
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.process.pid, null, "no primary extraction was launched");
      assert.notEqual(result.error.code, "path_unsupported");
      assert.notEqual(result.semantic.status, "succeeded");
      assert.ok(result.paths.manifest);

      const manifest = await readJson(result.paths.manifest);
      assert.equal(manifest.state, "failed");
      assert.equal(manifest.process.pid, null);
      assert.equal(manifest.error.code, result.error.code);
      const preflight = manifest.preflight as AnyRecord;
      assert.ok(preflight, "failed preflight evidence is retained");
      assert.equal(typeof preflight.process.pid, "number");
      assert.notEqual(preflight.semantic.status, "succeeded");
      const rawPreflightStdout = await readFile(preflight.stdout.rawPath);
      const rawPreflightStderr = await readFile(preflight.stderr.rawPath);
      assert.equal(preflight.stdout.complete, true);
      assert.equal(preflight.stderr.complete, true);
      assert.equal(preflight.stdout.bytes, rawPreflightStdout.byteLength);
      assert.equal(preflight.stderr.bytes, rawPreflightStderr.byteLength);
      const preflightText = new TextDecoder("utf-8", { fatal: true }).decode(rawPreflightStdout);
      assert.match(preflightText, /failed|error|cannot|open/iu);

      assert.deepEqual(
        await walk(result.paths.effectiveDestination ?? result.paths.output).catch(() => ({ files: [], directories: [] })),
        { files: [], directories: [] },
        "no extracted members are claimed",
      );
      await assertSourcesUnchanged([before]);
    });
  } finally {
    await closeClient(started);
  }
});

test("real stdio caps bounded artifact items while retaining the complete 40-member inventory", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.workspace, "large");
    await mkdir(fixtureRoot, { recursive: true });
    const members = Array.from({ length: 40 }, (_, index) => ({
      relative: `member-${String(index).padStart(2, "0")}-空间.txt`,
      bytes: Buffer.from(`member ${String(index)}\n`, "utf8"),
    }));
    const expectedFiles = await authorFormat2Pck(path.join(fixtureRoot, "40 members.pck"), members);
    const input = path.join(fixtureRoot, "40 members.pck");
    const snapshot = await snapshotSource(input);

    const { wire, result } = await callExtract(started.client, {
      inputs: [{ kind: "path", path: "large/40 members.pck" }],
      session: [],
    });
    assert.equal(wire.isError, false, diagnostic(result));
    assert.equal(result.success, true, diagnostic(result));
    assert.equal(result.status, "succeeded");
    assert.equal(result.semantic.status, "succeeded");
    assert.equal(result.semantic.data.totalFiles, 40);
    assert.equal(result.semantic.data.extractedFiles, 40);

    const effective = result.paths.effectiveDestination as string;
    const destination = await walk(effective);
    assert.deepEqual(
      [...destination.files].sort(),
      [...expectedFiles.map((file) => file.relative), "gdre_export.log"].sort(),
    );
    for (const file of expectedFiles) {
      assert.deepEqual(
        await readFile(path.join(effective, ...file.relative.split("/"))),
        file.bytes,
        file.relative,
      );
    }

    assert.equal(result.artifacts.complete, true);
    assert.equal(result.artifacts.truncated, true);
    assert.equal(result.artifacts.count, 41);
    assert.equal((result.artifacts.items as AnyRecord[]).length, 32);
    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, 41);
    const inventoryByPath = new Map(
      (inventory.entries as AnyRecord[]).map((entry) => [entry.path as string, entry]),
    );
    for (const file of expectedFiles) {
      const entry = inventoryByPath.get(path.join(effective, ...file.relative.split("/")));
      assert.equal(entry?.bytes, file.size, file.relative);
      assert.equal(entry?.sha256, file.sha256, file.relative);
    }
    assert.equal(inventoryByPath.has(path.join(effective, "gdre_export.log")), true);

    const rawStdout = await readFile(result.stdout.rawPath, "utf8");
    assert.ok(rawStdout.includes("Verified 40 files, no errors detected!"));
    assert.ok(rawStdout.includes("Extracted 40 files, no errors detected!"));
    const manifest = await readJson(result.paths.manifest);
    assert.equal(manifest.state, "succeeded");
    assert.deepEqual(manifest.invocation.argv, [
      "--headless",
      "--no-header",
      "--",
      `--extract=${input}`,
      `--output=${effective}`,
    ]);
    const preflightMembers = await readJson(manifest.preflight.expectedMembers.path);
    assert.equal(preflightMembers.count, 40);
    assert.equal(preflightMembers.complete, true);
    await assertSourcesUnchanged([snapshot]);
  } finally {
    await closeClient(started);
  }
});
