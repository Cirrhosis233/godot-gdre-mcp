import assert from "node:assert/strict";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createListingFixtures,
  createPckFixture,
  listingExpectedMembers,
} from "./support/listing-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory = process.env.GDRE_MCP_RUNTIME_DIR ?? path.join(repositoryRoot, "vendor", "GDRE_tools");
const listingKey = "0123456789abcdef".repeat(4);
const clientRequestOptions = { timeout: 120_000, maxTotalTimeout: 120_000 };

type AnyRecord = Record<string, any>;

interface StartedListingClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

interface StartOptions {
  readonly runtimeDirectory?: string;
  readonly targetVersion?: string;
  readonly defaults?: Record<string, unknown>;
}

const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  GDRE_MCP_CONFIG: configFile,
});

async function startClient(options: StartOptions = {}): Promise<StartedListingClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-stdio-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller cwd");
  await mkdir(callerCwd, { recursive: true });
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory: options.runtimeDirectory ?? runtimeDirectory,
      targetVersion: options.targetVersion ?? "2.8.0-beta.2",
      timeouts: { maxMs: 3_600_000 },
      defaults: options.defaults ?? {},
      settings: {},
    }),
    "utf8",
  );
  const environment = childEnvironment(configFile);
  // An explicitly selected test runtime must not inherit the outer suite's override.
  if (options.runtimeDirectory !== undefined) delete environment.GDRE_MCP_RUNTIME_DIR;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-05-listing-stdio", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedListingClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

async function readJson(file: string): Promise<AnyRecord> {
  return JSON.parse(await readFile(file, "utf8")) as AnyRecord;
}

async function createSetupProfile(root: string, name: string): Promise<{ readonly cwd: string; readonly env: NodeJS.ProcessEnv }> {
  const profile = path.join(root, "setup-profiles", name);
  const values = {
    APPDATA: path.join(profile, "appdata"),
    LOCALAPPDATA: path.join(profile, "localappdata"),
    USERPROFILE: path.join(profile, "userprofile"),
    HOME: path.join(profile, "home"),
    TEMP: path.join(profile, "temp"),
    TMP: path.join(profile, "temp"),
    GDRE_PLUGIN_CACHE_DIR: path.join(profile, "plugin-cache"),
  };
  const cwd = path.join(profile, "cwd");
  await Promise.all([...Object.values(values), cwd].map((directory) => mkdir(directory, { recursive: true })));
  const configDirectory = path.join(values.APPDATA, "Godot", "app_userdata", "Godot RE Tools");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "gdre_settings.cfg"), [
    "[General]",
    "download_plugins=false",
    "execute_visual_shader_node_scripts=false",
    "delete_auto_converted_files=false",
    "force_single_threaded=false",
    "[Recovery]",
    "clear_output_dir_except_git_before_full_recovery=false",
    "git/create_git_repo=false",
    "git/add_imports_to_git_repo=false",
    "[CSharp]",
    "compile_after_decompile=false",
    "verify_nuget_package_is_from_nuget_org=false",
    "automatically_search_workshop_dependencies=false",
    "copy_out_of_tree_references=false",
    "",
  ].join("\n"), { flag: "wx" });
  return {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...values,
    },
  };
}

async function createPck(
  started: StartedListingClient,
  sourceDirectory: string,
  output: string,
  format: 0 | 1 | 2 | 3 | 4,
  key?: string,
): Promise<void> {
  const profile = await createSetupProfile(started.root, `create-${path.basename(output, ".pck")}`);
  await createPckFixture({
    runtimeExecutable: path.join(runtimeDirectory, "gdre_tools.exe"),
    sourceDirectory,
    output,
    format,
    key,
    cwd: profile.cwd,
    env: profile.env,
  });
}

async function callListing(client: Client, arguments_: AnyRecord): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord }> {
  const wire = await client.callTool({ name: "gdre_list_files", arguments: arguments_ }, clientRequestOptions) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
}

function assertTwoMemberSuccess(result: AnyRecord, label = ""): void {
  assert.equal(result.success, true, `${label}: ${JSON.stringify({ error: result.error, semantic: result.semantic, process: result.process, stdout: result.stdout?.text, stderr: result.stderr?.text })}`);
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.process.signal, null);
  assert.equal(result.semantic.status, "succeeded");
  assert.equal(result.semantic.data.totalFiles, 2);
  assert.deepEqual([...result.semantic.data.files].sort(), [...listingExpectedMembers].sort());
  assert.equal(result.semantic.data.truncated, false);
  assert.equal(result.semantic.data.stdoutPath, result.stdout.rawPath);
  assert.equal(result.artifacts.count, 0);
  assert.deepEqual(result.artifacts.items, []);
  assert.equal(result.artifacts.complete, true);
  assert.equal(result.persistence.state, "complete");
}

function listArgv(manifest: AnyRecord): string[] {
  return manifest.invocation.argv as string[];
}

async function assertManifestAndLogs(result: AnyRecord): Promise<AnyRecord> {
  assert.ok(result.paths.manifest);
  assert.ok(result.paths.artifactInventory);
  const manifest = await readJson(result.paths.manifest);
  assert.equal(manifest.state, result.status);
  assert.equal(manifest.invocation.cwd, result.paths.operation);
  assert.equal(manifest.invocation.environmentProfile.root, path.join(result.paths.operation, "profile"));
  assert.equal(manifest.persistence.state, "complete");
  assert.equal(typeof manifest.invocation.environmentProfile.configFile, "string");
  assert.equal((await readFile(result.stdout.rawPath, "utf8")).length > 0, true);
  return manifest;
}

test("real stdio discovers registered tools and lists accepted authored fixture families", async () => {
  const started = await startClient({
    targetVersion: "2.8.0-beta.1",
    defaults: {
      "list-files": {
        timeoutMs: 10_000,
        session: [{ kind: "multithreading", disabled: false }],
      },
    },
  });
  try {
    const fixtureRoot = path.join(started.root, "fixtures");
    const fixtures = await createListingFixtures(fixtureRoot);
    const pcks = new Map<number, string>();
    for (const format of [0, 1, 2, 3, 4] as const) {
      const output = path.join(fixtureRoot, `format-${String(format)}.pck`);
      await createPck(started, fixtures.sourceDirectory, output, format);
      pcks.set(format, output);
    }
    const encrypted = path.join(fixtureRoot, "encrypted.pck");
    await createPck(started, fixtures.sourceDirectory, encrypted, 2, listingKey);
    const encryptedPositive = await callListing(started.client, {
      inputs: [{ kind: "path", path: encrypted }],
      key: listingKey,
      session: [],
    });
    assert.equal(encryptedPositive.wire.isError, false);
    assertTwoMemberSuccess(encryptedPositive.result);
    assert.equal(JSON.stringify(encryptedPositive.result).includes(listingKey), false);
    const encryptedManifest = await assertManifestAndLogs(encryptedPositive.result);
    assert.deepEqual(encryptedManifest.requestedParameters.key, { redacted: true });
    assert.deepEqual(encryptedManifest.effectiveParameters.key, { redacted: true });
    assert.equal(encryptedManifest.invocation.argv.at(-1), "--key=<redacted>");
    assert.equal(encryptedManifest.process.exitCode, 0);

    const markedProject = path.join(fixtureRoot, "project marked");
    const markedImport = path.join(fixtureRoot, "project-import marked");
    await cp(fixtures.sourceDirectory, markedProject, { recursive: true });
    await cp(fixtures.importDirectory, markedImport, { recursive: true });
    const directorySentinel = path.join(markedProject, "hello 空间.txt");
    const directorySentinelBefore = createHash("sha256").update(await readFile(directorySentinel)).digest("hex");
    const appBundle = path.join(fixtureRoot, "app bundle.app");
    await mkdir(path.join(appBundle, "Contents", "Resources"), { recursive: true });
    await copyFile(pcks.get(2)!, path.join(appBundle, "Contents", "Resources", "app bundle.pck"));
    const fallbackBundle = path.join(fixtureRoot, "fallback bundle.app");
    await mkdir(fallbackBundle, { recursive: true });
    await copyFile(pcks.get(2)!, path.join(fallbackBundle, "fallback bundle.pck"));
    const sidecarExe = path.join(fixtureRoot, "sidecar 空间.exe");
    await copyFile(process.execPath, sidecarExe);
    const sidecarPck = path.join(fixtureRoot, "sidecar 空间.pck");
    await copyFile(pcks.get(2)!, sidecarPck);
    const workspacePck = path.join(started.workspace, "pack = O'Reilly 空间.pck");
    await copyFile(pcks.get(2)!, workspacePck);
    const externalDirectory = path.join(started.root, "external");
    await mkdir(externalDirectory, { recursive: true });
    const externalPck = path.join(externalDirectory, "outside = O'Reilly.pck");
    await copyFile(pcks.get(2)!, externalPck);
    const globDirectory = path.join(started.workspace, "packs");
    await mkdir(path.join(globDirectory, "nested"), { recursive: true });
    await copyFile(pcks.get(0)!, path.join(globDirectory, "format-0.pck"));
    await copyFile(pcks.get(1)!, path.join(globDirectory, "format-1.pck"));
    await copyFile(pcks.get(2)!, path.join(globDirectory, "nested", "format-2.pck"));

    const tools = (await started.client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["gdre_export_resources", "gdre_extract", "gdre_list_files", "gdre_patch_translations", "gdre_pck_patch", "gdre_version"]);
    const listingTool = tools.find((tool) => tool.name === "gdre_list_files");
    assert.ok(listingTool);
    assert.deepEqual(listingTool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(listingTool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(listingTool.inputSchema.properties ?? {}).sort(), ["inputs", "key", "session", "timeoutMs", "workspace"]);

    for (const input of pcks.values()) {
      const { wire, result } = await callListing(started.client, { inputs: [{ kind: "path", path: input }], session: [] });
      assert.equal(wire.isError, false);
      assertTwoMemberSuccess(result);
      const manifest = await assertManifestAndLogs(result);
      assert.deepEqual(listArgv(manifest), ["--headless", "--no-header", "--", `--list-files=${input}`]);
      assert.equal(manifest.process.exitCode, 0);
    }

    const relative = await callListing(started.client, { inputs: [{ kind: "path", path: path.basename(workspacePck) }], session: [] });
    assertTwoMemberSuccess(relative.result);
    assert.equal(relative.result.runtime.comparison, "mismatch");
    assert.ok(relative.result.runtime.warnings.some((warning: string) => warning.includes("does not match target")));
    const relativeManifest = await assertManifestAndLogs(relative.result);
    assert.deepEqual(listArgv(relativeManifest), ["--headless", "--no-header", "--", `--list-files=${workspacePck}`]);

    const absolute = await callListing(started.client, { inputs: [{ kind: "path", path: externalPck }], session: [] });
    assertTwoMemberSuccess(absolute.result);
    const absoluteManifest = await assertManifestAndLogs(absolute.result);
    assert.deepEqual(listArgv(absoluteManifest), ["--headless", "--no-header", "--", `--list-files=${externalPck}`]);

    for (const input of [fixtures.zip, fixtures.apk, markedProject, markedImport, appBundle, fallbackBundle, sidecarExe, fixtures.xapk]) {
      const call = await callListing(started.client, { inputs: [{ kind: "path", path: input }] });
      assertTwoMemberSuccess(call.result, input);
      const manifest = await assertManifestAndLogs(call.result);
      const paths = manifest.invocation.inputPaths as AnyRecord[];
      assert.ok(paths.length >= 1);
      if (input === sidecarExe) {
        const dependencies = paths.filter((entry) => entry.role === "dependency");
        assert.equal(dependencies.length, 1);
        assert.ok(String(dependencies[0]?.path).endsWith("sidecar 空间.pck"));
        assert.equal(String(dependencies[0]?.sha256).length, 64);
        assert.equal(typeof dependencies[0]?.fileId, "string");
      }
      if (input === appBundle || input === fallbackBundle) {
        assert.ok(paths.some((entry) => entry.role === "dependency"));
        assert.ok(paths.filter((entry) => entry.role === "dependency").every((entry) => typeof entry.sha256 === "string"));
      }
    }
    assert.equal(createHash("sha256").update(await readFile(directorySentinel)).digest("hex"), directorySentinelBefore);

    const overlay = await callListing(started.client, {
      inputs: [
        { kind: "path", path: pcks.get(2)! },
        { kind: "path", path: fixtures.zip },
      ],
      session: [],
    });
    assertTwoMemberSuccess(overlay.result);
    const overlayManifest = await assertManifestAndLogs(overlay.result);
    assert.deepEqual(listArgv(overlayManifest), [
      "--headless",
      "--no-header",
      "--",
      `--list-files=${pcks.get(2)!}`,
      `--list-files=${fixtures.zip}`,
    ]);

    const globCalls = ["packs/*.pck", "packs/format-?.pck", "packs/**/*.pck"];
    for (const pattern of globCalls) {
      const glob = await callListing(started.client, { inputs: [{ kind: "glob", pattern }] });
      assertTwoMemberSuccess(glob.result);
      const manifest = await assertManifestAndLogs(glob.result);
      const emitted = listArgv(manifest).filter((token) => token.startsWith("--list-files="));
      assert.ok(emitted.length >= (pattern.includes("**") ? 3 : 2));
      assert.ok(emitted.every((token) => path.isAbsolute(token.slice("--list-files=".length))));
    }

    const session = await callListing(started.client, {
      inputs: [{ kind: "path", path: pcks.get(2)! }],
      session: [
        { kind: "multithreading", disabled: true },
        { kind: "multithreading", disabled: false },
      ],
      key: listingKey,
    });
    assertTwoMemberSuccess(session.result);
    assert.equal(JSON.stringify(session.result).includes(listingKey), false);
    const sessionManifest = await assertManifestAndLogs(session.result);
    assert.deepEqual(listArgv(sessionManifest).slice(0, 7), [
      "--headless",
      "--no-header",
      "--",
      "--disable-multithreading=true",
      "--disable-multithreading=false",
      `--list-files=${pcks.get(2)!}`,
      "--key=<redacted>",
    ]);
    assert.deepEqual(sessionManifest.session, [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ]);

    const defaultSession = await callListing(started.client, { inputs: [{ kind: "path", path: pcks.get(2)! }] });
    assertTwoMemberSuccess(defaultSession.result);
    const defaultManifest = await assertManifestAndLogs(defaultSession.result);
    assert.ok(listArgv(defaultManifest).includes("--disable-multithreading=false"));
    const clearSession = await callListing(started.client, { inputs: [{ kind: "path", path: pcks.get(2)! }], session: [] });
    assertTwoMemberSuccess(clearSession.result);
    const clearManifest = await assertManifestAndLogs(clearSession.result);
    assert.equal(listArgv(clearManifest).some((token) => token.startsWith("--disable-multithreading")), false);
  } finally {
    await closeClient(started);
  }
});

test("real stdio expands safe workspace-junction glob prefixes", async () => {
  const started = await startClient();
  try {
    const fixtures = await createListingFixtures(path.join(started.root, "alias fixtures"));
    const physicalWorkspace = path.join(started.root, "physical workspace");
    const workspaceAlias = path.join(started.root, "workspace junction");
    await mkdir(path.join(physicalWorkspace, "packs", "nested"), { recursive: true });
    await symlink(physicalWorkspace, workspaceAlias, "junction");
    await copyFile(fixtures.zip, path.join(physicalWorkspace, "packs", "format-0.zip"));
    await copyFile(fixtures.zip, path.join(physicalWorkspace, "packs", "nested", "format-1.zip"));
    for (const pattern of ["packs/*.zip", "packs/format-?.zip", "packs/**/*.zip", path.join(workspaceAlias, "packs", "*.zip")]) {
      const call = await callListing(started.client, {
        workspace: workspaceAlias,
        inputs: [{ kind: "glob", pattern }],
        session: [],
      });
      assertTwoMemberSuccess(call.result, pattern);
      const manifest = await assertManifestAndLogs(call.result);
      assert.equal(call.result.paths.workspace, workspaceAlias);
      assert.deepEqual(
        listArgv(manifest).filter((token) => token.startsWith("--list-files=")).map((token) => path.basename(token.slice("--list-files=".length))),
        pattern.includes("**") ? ["format-0.zip", "format-1.zip"] : ["format-0.zip"],
      );
      const physicalPrefix = `${path.normalize(physicalWorkspace).toLowerCase()}${path.sep}`;
      assert.ok(manifest.invocation.inputPaths.every((entry: AnyRecord) => path.normalize(entry.realPath).toLowerCase().startsWith(physicalPrefix)));
    }
  } finally {
    await closeClient(started);
  }
});

test("real stdio preserves complete bounded large-list evidence and empty artifacts", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.root, "large-fixture");
    const source = path.join(fixtureRoot, "large project 空间");
    await mkdir(path.join(source, ".godot"), { recursive: true });
    await writeFile(path.join(source, "project.godot"), "config_version=5\n", "utf8");
    const expected = [] as string[];
    for (let index = 0; index < 220; index += 1) {
      const name = `member-${String(index).padStart(3, "0")}-${"空间😀".repeat(8)}.txt`;
      await writeFile(path.join(source, name), `member-${String(index)}\n`, "utf8");
      expected.push(`res://${name}`);
    }
    const largePck = path.join(fixtureRoot, "large.pck");
    await mkdir(fixtureRoot, { recursive: true });
    const profile = await createSetupProfile(started.root, "create-large");
    await createPckFixture({
      runtimeExecutable: path.join(runtimeDirectory, "gdre_tools.exe"),
      sourceDirectory: source,
      output: largePck,
      format: 2,
      cwd: profile.cwd,
      env: profile.env,
    });
    const largePckBefore = createHash("sha256").update(await readFile(largePck)).digest("hex");
    const call = await callListing(started.client, { inputs: [{ kind: "path", path: largePck }] });
    assert.equal(call.wire.isError, false);
    const result = call.result;
    assert.equal(result.success, true);
    assert.equal(result.semantic.status, "succeeded");
    assert.equal(result.semantic.data.totalFiles, expected.length + 1);
    assert.equal(result.semantic.data.files.length, 32);
    assert.equal(result.semantic.data.truncated, true);
    assert.equal(result.semantic.data.stdoutPath, result.stdout.rawPath);
    assert.equal(result.stdout.truncated, true);
    assert.equal(result.stdout.complete, true);
    const rawBuffer = await readFile(result.stdout.rawPath);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer);
    assert.equal(Buffer.byteLength(raw, "utf8"), result.stdout.bytes);
    assert.ok(result.stdout.bytes > 8_192);
    assert.equal(raw.includes("�"), false);
    const allExpectedMembers = new Set(["res://project.godot", ...expected]);
    assert.ok(result.semantic.data.files.every((file: string) => allExpectedMembers.has(file)));
    assert.equal(raw.split(/\r?\n/u).filter((line) => line.startsWith("res://")).sort().join("\n"), ["res://project.godot", ...expected].sort().join("\n"));
    assert.equal(Buffer.byteLength(result.stdout.text, "utf8") <= 8_192, true);
    assert.equal(result.stdout.text.includes("�"), false);
    assert.equal(result.artifacts.count, 0);
    assert.deepEqual(result.artifacts.items, []);
    const manifest = await assertManifestAndLogs(result);
    assert.equal(manifest.process.exitCode, 0);
    assert.equal(manifest.recordVersion, 2);
    assert.equal("events" in manifest, false);
    assert.equal(manifest.stdout.bytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(createHash("sha256").update(await readFile(largePck)).digest("hex"), largePckBefore);
    const artifacts = await readJson(result.paths.artifactInventory);
    assert.deepEqual(artifacts.entries, []);
    assert.equal(artifacts.complete, true);
  } finally {
    await closeClient(started);
  }
});

test("real stdio persists semantic failures and rejects malformed/no-match/duplicate calls", async () => {
  const started = await startClient();
  try {
    const fixtureRoot = path.join(started.root, "fixtures");
    const fixtures = await createListingFixtures(fixtureRoot);
    const profile = await createSetupProfile(started.root, "create-negative");
    const pck = path.join(fixtureRoot, "encrypted.pck");
    await createPckFixture({ runtimeExecutable: path.join(runtimeDirectory, "gdre_tools.exe"), sourceDirectory: fixtures.sourceDirectory, output: pck, format: 2, key: listingKey, cwd: profile.cwd, env: profile.env });
    const duplicateInput = path.join(started.workspace, "duplicate.pck");
    await copyFile(pck, duplicateInput);

    const wrongKeyValue = "FEDCBA9876543210".repeat(4);
    const wrongKey = await callListing(started.client, { inputs: [{ kind: "path", path: pck }], key: wrongKeyValue });
    assert.equal(wrongKey.wire.isError, true);
    assert.equal(wrongKey.result.success, false);
    assert.notEqual(wrongKey.result.semantic.status, "succeeded");
    assert.equal(wrongKey.result.process.exitCode, 0);
    assert.notEqual(wrongKey.result.process.pid, null);
    const wrongKeySerialized = JSON.stringify(wrongKey.result);
    assert.equal(wrongKeySerialized.includes(wrongKeyValue), false);
    assert.equal(wrongKeySerialized.includes(wrongKeyValue.toLowerCase()), false);
    const wrongKeyManifest = await assertManifestAndLogs(wrongKey.result);
    assert.deepEqual(wrongKeyManifest.requestedParameters.key, { redacted: true });
    assert.deepEqual(wrongKeyManifest.effectiveParameters.key, { redacted: true });
    assert.equal(wrongKeyManifest.invocation.argv.at(-1), "--key=<redacted>");
    assert.equal(JSON.stringify(wrongKeyManifest).includes(wrongKeyValue), false);
    assert.equal(JSON.stringify(wrongKeyManifest).includes(wrongKeyValue.toLowerCase()), false);

    const missingHostPath = path.join(started.workspace, "missing host.pck");
    const missingHost = await callListing(started.client, { inputs: [{ kind: "path", path: path.basename(missingHostPath) }] });
    assert.equal(missingHost.wire.isError, true);
    assert.equal(missingHost.result.success, false);
    assert.equal(missingHost.result.process.pid, null);
    assert.ok(missingHost.result.paths.manifest);
    assert.equal((await readJson(missingHost.result.paths.manifest)).process.pid, null);

    const corruptPath = path.join(started.workspace, "corrupt.pck");
    await writeFile(corruptPath, "not a valid PCK", "utf8");
    const corrupt = await callListing(started.client, { inputs: [{ kind: "path", path: path.basename(corruptPath) }] });
    assert.equal(corrupt.wire.isError, true);
    assert.equal(corrupt.result.success, false);
    assert.notEqual(corrupt.result.process.pid, null);
    assert.equal(corrupt.result.process.exitCode, 0);
    assert.ok(`${corrupt.result.stdout.text}\n${corrupt.result.stderr.text}`.match(/failed|error|cannot|open/iu));
    const corruptManifest = await assertManifestAndLogs(corrupt.result);
    assert.equal(corruptManifest.process.exitCode, 0);

    const noMatch = await callListing(started.client, { inputs: [{ kind: "glob", pattern: "missing-*.pck" }] });
    assert.equal(noMatch.wire.isError, true);
    assert.equal(noMatch.result.success, false);
    assert.equal(noMatch.result.process.pid, null);
    assert.ok(noMatch.result.paths.manifest);
    const noMatchManifest = await readJson(noMatch.result.paths.manifest);
    assert.equal(noMatchManifest.process.pid, null);

    const duplicate = await callListing(started.client, { inputs: [
      { kind: "path", path: "duplicate.pck" },
      { kind: "path", path: "./duplicate.pck" },
    ] });
    assert.equal(duplicate.wire.isError, true);
    assert.equal(duplicate.result.success, false);
    assert.equal(duplicate.result.process.pid, null);
    assert.ok(duplicate.result.paths.manifest);

    const operationsBeforeMalformed = await readdirSafe(path.join(started.workspace, ".gdre", "operations"));
    const malformed = await started.client.callTool({ name: "gdre_list_files", arguments: { inputs: [{ kind: "path", path: "x.pck" }], output: "ignored" } }, clientRequestOptions) as AnyRecord;
    assert.equal(malformed.isError, true);
    assert.equal(malformed.structuredContent, undefined);
    const operationsAfterMalformed = await readdirSafe(path.join(started.workspace, ".gdre", "operations"));
    assert.deepEqual(operationsAfterMalformed, operationsBeforeMalformed);
  } finally {
    await closeClient(started);
  }
});

test("real stdio keeps registered tools discoverable when the runtime is unavailable", async () => {
  const started = await startClient({ runtimeDirectory: path.join(os.tmpdir(), `gdre-mcp-list-missing-${Date.now()}`) });
  try {
    await mkdir(started.workspace, { recursive: true });
    const knownInput = path.join(runtimeDirectory, "gdre_tools.pck");
    const tools = await started.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["gdre_export_resources", "gdre_extract", "gdre_list_files", "gdre_patch_translations", "gdre_pck_patch", "gdre_version"]);
    const call = await callListing(started.client, { inputs: [{ kind: "path", path: knownInput }] });
    assert.equal(call.wire.isError, true);
    assert.equal(call.result.success, false);
    assert.equal(call.result.error.code, "runtime_unavailable");
    assert.equal(call.result.process.pid, null);
    assert.ok(call.result.paths.manifest);
    const manifest = await readJson(call.result.paths.manifest);
    assert.equal(manifest.process.pid, null);
    assert.equal(call.result.persistence.state, "complete");
  } finally {
    await closeClient(started);
  }
});

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return [];
  }
}
