import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat as statPath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import { AtomicJsonWriter, type JsonWriter } from "../src/storage.js";
import { prepareListingInputs, revalidateListingInputs, type ListingDirectoryInspector } from "../src/listing-paths.js";
import type { LoadedConfig } from "../src/config.js";
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner, StreamSummaryValue } from "../src/process.js";
import type { RuntimeManager } from "../src/runtime.js";
import type { RuntimeState } from "../src/types.js";

const key = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
const listOutput = (inputs: string | readonly string[], directoryInputs: readonly string[] = []): string => {
  const values = typeof inputs === "string" ? [inputs] : [...inputs];
  const directories = new Set(directoryInputs);
  return [
    `Input files: [${values.map((input) => `"${input}"`).join(", ")}]`,
    "GDRE Tools v2.8.0-beta.2",
    "Windows 10.0.26100, headless",
    ...values.map((input) => `${directories.has(input) ? "Opening directory" : "Opening file"}: ${input}`),
    "",
    "Contents:",
    "res://hello 空间.txt",
    "res://project.godot",
    "",
    "Total files: 2",
    "",
  ].join("\n");
};

const stream = (options: ProcessRunOptions, kind: "stdout" | "stderr", text: string): StreamSummaryValue => ({
  bytes: Buffer.byteLength(text, "utf8"),
  text,
  truncated: false,
  utf8Valid: true,
  rawPath: kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath: kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete: true,
});

const runtimeState = (root: string): RuntimeState => ({
  health: "ready",
  registryVersion: "2.8.0-beta.2",
  targetVersion: "2.8.0-beta.2",
  actualVersion: "2.8.0-beta.2",
  comparison: "match",
  executable: path.join(root, "runtime", "gdre_tools.exe"),
  companions: [
    { path: path.join(root, "runtime", "gdre_tools.exe"), present: true, sha256: "a".repeat(64) },
    { path: path.join(root, "runtime", "gdre_tools.pck"), present: true, sha256: "b".repeat(64) },
    { path: path.join(root, "runtime", "GodotMonoDecompNativeAOT.dll"), present: true, sha256: "c".repeat(64) },
  ],
  exeSha256: "a".repeat(64),
  baselineHashesMatch: true,
  checkedAt: new Date().toISOString(),
  evidencePath: null,
  probe: {
    exitCode: 1,
    signal: null,
    stdout: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    stderr: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    error: null,
  },
  warnings: [],
});

const makeConfig = (
  root: string,
  defaults: LoadedConfig["defaults"] = {},
  settings: LoadedConfig["settings"] = [],
): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults,
  settings,
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: Object.keys(defaults).length === 0 ? "builtin" : "config",
    settings: settings.length === 0 ? "builtin" : "config",
  },
});

const assertDurableListingFailure = async (result: Awaited<ReturnType<ExecutionImpl["execute"]>>): Promise<void> => {
  assert.ok(result.paths.operation);
  assert.ok(result.paths.manifest);
  const manifest = JSON.parse(await readFile(result.paths.manifest, "utf8")) as Record<string, any>;
  assert.equal(manifest.status, result.status);
  assert.equal(manifest.error?.code, result.error?.code);
  assert.equal(manifest.process.pid, null);
  assert.equal(manifest.process.exitCode, null);
};
const openFakeExecution = (
  root: string,
  config: LoadedConfig,
  observed: { options?: ProcessRunOptions; runRemaining?: number },
  runFailure?: Error,
  listingInspector?: ListingDirectoryInspector,
  outputFactory?: (inputs: readonly string[]) => string,
  writer?: JsonWriter,
  beforeRun?: (runNumber: number) => Promise<void>,
): ExecutionImpl => {
  const state = runtimeState(root);
  const manager = { state, refreshIfChanged: async (): Promise<RuntimeState> => state } as unknown as RuntimeManager;
  let runNumber = 0;
  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      runNumber += 1;
      observed.options = options;
      observed.runRemaining = options.deadlineMono === undefined ? undefined : options.deadlineMono - performance.now();
      await beforeRun?.(runNumber);
      if (runFailure !== undefined) throw runFailure;
      const inputs = options.argv
        .filter((value) => value.startsWith("--list-files="))
        .map((value) => value.slice("--list-files=".length));
      const directoryInputs: string[] = [];
      for (const input of inputs) {
        if ((await statPath(input)).isDirectory()) directoryInputs.push(input);
      }
      const output = outputFactory?.(inputs) ?? listOutput(inputs.length === 1 ? inputs[0]! : inputs, directoryInputs);
      await options.sink?.append("stdout", Buffer.from(output, "utf8"), output);
      await options.sink?.append("stderr", Buffer.alloc(0), "");
      await options.sink?.close();
      return {
        pid: null,
        exitCode: 0,
        signal: null,
        spawnError: null,
        timedOut: false,
        trigger: null,
        exitObserved: true,
        spawnedAt: new Date().toISOString(),
        spawnedAtMono: 1,
        exitedAt: new Date().toISOString(),
        exitedAtMono: 2,
        stdout: stream(options, "stdout", output),
        stderr: stream(options, "stderr", ""),
        stdoutText: output,
        stderrText: "",
        ownership: null,
        cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
        captureError: null,
        storageError: null,
        error: null,
      };
    },
  };
  return new ExecutionImpl(config, manager, { processRunner: runner, listingInspector, writer });
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("listing execution persists resolved inputs, profile controls, redaction, and complete semantic evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-execution-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const input = path.join(workspace, `pack = ${key}.pck`);
  await writeFile(input, "authored input", "utf8");
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root, {
    "list-files": {
      timeoutMs: 900,
      session: [{ kind: "multithreading", disabled: true }],
    },
  }), observed);
  try {
    const result = await execution.execute("list-files", {
      inputs: [{ kind: "path", path: `pack = ${key}.pck` }],
      key,
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    assert.equal(result.commandId, "list-files");
    assert.equal(JSON.stringify(result).includes(key), false);
    const rawStdout = await readFile(result.stdout.textPath!, "utf8");
    assert.equal(rawStdout, listOutput(input));
    assert.deepEqual(result.semantic.data && "files" in result.semantic.data ? result.semantic.data.files : null, ["res://hello 空间.txt", "res://project.godot"]);
    assert.equal(result.semantic.data && "stdoutPath" in result.semantic.data ? result.semantic.data.stdoutPath : null, result.stdout.rawPath);
    assert.ok(observed.options);
    assert.deepEqual(observed.options?.argv.slice(0, 6), [
      "--headless",
      "--no-header",
      "--",
      "--disable-multithreading=true",
      `--list-files=${input}`,
      `--key=${key.toLowerCase()}`,
    ]);
    assert.equal(observed.options?.timeoutMs, undefined);
    assert.equal(observed.options?.deadlineMono, undefined);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(JSON.stringify(manifest).includes(key), false);
    assert.deepEqual(manifest.requestedParameters.key, { redacted: true });
    assert.equal(manifest.parameterSources.timeoutMs, "config");
    assert.equal(manifest.parameterSources.session, "config");
    assert.equal(manifest.invocation.inputPaths[0].path, input.replace(key, "<redacted>"));
    assert.equal(manifest.invocation.inputPaths[0].realPath, input.replace(key, "<redacted>"));
    assert.equal(manifest.invocation.inputPaths[0].identity, input.replace(key, "<redacted>").replaceAll("\\", "/").toLowerCase());
    assert.equal(manifest.invocation.inputPaths[0].kind, "file");
    assert.equal(manifest.invocation.inputPaths[0].bytes, Buffer.byteLength("authored input", "utf8"));
    assert.equal(typeof manifest.invocation.inputPaths[0].mtimeNs, "string");
    assert.equal(typeof manifest.invocation.inputPaths[0].fileId, "string");
    assert.equal(manifest.invocation.inputPaths[0].sha256.length, 64);
    assert.ok(manifest.effects.reads.includes(input.replace(key, "<redacted>")));
    const profile = manifest.invocation.environmentProfile;
    assert.ok(profile.userData.endsWith(path.join("Godot", "app_userdata", "Godot RE Tools")));
    const profileConfig = await readFile(manifest.invocation.environmentProfile.configFile, "utf8");
    assert.equal(profileConfig.includes("\\n"), false);
    const profileLines = new Set(profileConfig.split(/\r?\n/u));
    for (const line of [
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
    ]) assert.equal(profileLines.has(line), true, line);
    const artifacts = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.deepEqual(artifacts.entries, []);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("listing execution expands case-insensitive Unicode globs in ordinal identity order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-glob-order-"));
  const workspace = path.join(root, "workspace");
  const packs = path.join(workspace, "packs");
  await mkdir(packs, { recursive: true });
  for (const name of ["b.pck", "A.pck", "é.pck", "İ.pck", "空.pck"]) await writeFile(path.join(packs, name), name, "utf8");
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed);
  try {
    const result = await execution.execute("list-files", {
      inputs: [{ kind: "glob", pattern: "PACKS/*.PCK" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    const listed = observed.options?.argv
      .filter((value) => value.startsWith("--list-files="))
      .map((value) => path.basename(value.slice("--list-files=".length)));
    assert.deepEqual(listed, ["A.pck", "b.pck", "İ.pck", "é.pck", "空.pck"]);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
test("literal directory junction aliases use the canonical target and reject retargeting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-root-alias-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source");
  const other = path.join(root, "other");
  const alias = path.join(workspace, "alias");
  await mkdir(workspace, { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(path.join(source, "pack.pck"), "source", "utf8");
  await writeFile(path.join(other, "other.pck"), "other", "utf8");
  await symlink(source, alias, "junction");
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed);
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "alias" }] }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.invocation.inputPaths[0].path, alias);
    assert.equal(manifest.invocation.inputPaths[0].realPath, source);
    const duplicate = await execution.execute("list-files", { inputs: [
      { kind: "path", path: "alias" },
      { kind: "path", path: "source" },
    ] }, { signal: new AbortController().signal });
    assert.equal(duplicate.error?.code, "path_unsupported");

    const prepared = await prepareListingInputs(workspace, { inputs: [{ kind: "path", path: "alias" }] });
    for (const pattern of ["alias/*.pck", "alias/????.pck", "alias/**/*.pck", path.join(alias, "*.pck")]) {
      const globResult = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern }] }, { signal: new AbortController().signal });
      assert.equal(globResult.success, true, pattern);
    }
    await unlink(alias);
    await symlink(other, alias, "junction");
    await assert.rejects(revalidateListingInputs(prepared));
    await unlink(alias);
    await symlink(source, alias, "junction");
    const nested = path.join(source, "nested");
    await symlink(other, nested, "junction");
    const nestedGlob = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "alias/**/*.pck" }] }, { signal: new AbortController().signal });
    assert.equal(nestedGlob.error?.code, "path_unsupported");
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
test("listing execution projects canonical external fingerprints separately from argv spelling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-external-fingerprint-"));
  try {
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    await mkdir(workspace, { recursive: true });
    await mkdir(external, { recursive: true });
    const file = path.join(external, "outside.pck");
    await writeFile(file, "outside", "utf8");
    const execution = openFakeExecution(root, makeConfig(root), {});
    try {
      const result = await execution.execute("list-files", {
        inputs: [{ kind: "path", path: file }],
      }, { signal: new AbortController().signal });
      assert.equal(result.success, true);
      const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
      assert.equal(manifest.invocation.inputPaths[0].path, file);
      assert.equal(manifest.invocation.inputPaths[0].realPath, file);
      assert.equal(manifest.invocation.inputPaths[0].identity, file.replaceAll("\\", "/").toLowerCase());
      assert.equal(manifest.invocation.inputPaths[0].role, "input");
    } finally {
      await execution.close("shutdown");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("listing execution fails closed on uncertain case or reparse directory classification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-inspection-failure-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const inspectors: readonly ListingDirectoryInspector[] = [
    {
      async inspect(directories) {
        return new Map(directories.map((directory) => [directory, { caseSensitive: true, reparsePoint: false }]));
      },
    },
    {
      async inspect(directories) {
        return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: true }]));
      },
    },
    {
      async inspect() {
        throw new Error("attribute boundary failed");
      },
    },
  ];
  try {
    for (const inspector of inspectors) {
      const execution = openFakeExecution(root, makeConfig(root), {}, undefined, inspector);
      try {
        const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
        assert.equal(result.success, false);
        assert.equal(result.error?.code, "path_unsupported");
        await assertDurableListingFailure(result);
      } finally {
        await execution.close("shutdown");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("generated profile is consumed by GDREConfig as typed false booleans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-profile-readback-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const script = path.join(root, "readback.gd");
  await writeFile(script, [
    "extends SceneTree",
    "func _init() -> void:",
    " var keys = [\"General/download_plugins\", \"General/execute_visual_shader_node_scripts\", \"General/delete_auto_converted_files\", \"General/force_single_threaded\", \"Recovery/clear_output_dir_except_git_before_full_recovery\", \"Recovery/git/create_git_repo\", \"Recovery/git/add_imports_to_git_repo\", \"CSharp/compile_after_decompile\", \"CSharp/verify_nuget_package_is_from_nuget_org\", \"CSharp/automatically_search_workshop_dependencies\", \"CSharp/copy_out_of_tree_references\"]",
    " var report = {}",
    " var config = Engine.get_singleton(\"GDREConfig\")",
    " for key in keys:",
    "  var value = config.get_setting(key, null)",
    "  report[key] = {\"type\": typeof(value), \"value\": value}",
    " print(\"GDRE_GENERATED_PROFILE=\" + JSON.stringify(report))",
    " quit(0)",
    "",
  ].join("\n"), "utf8");
  const actualRuntime = path.join(process.env.GDRE_MCP_RUNTIME_DIR ?? path.resolve("vendor", "GDRE_tools"), "gdre_tools.exe");
  const baseState = runtimeState(root);
  const managerState = { ...baseState, executable: actualRuntime };
  const manager = { state: managerState, refreshIfChanged: async (): Promise<RuntimeState> => managerState } as unknown as RuntimeManager;
  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      const child = spawn(options.executable, ["--headless", "--no-header", "--script", script], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      const [code, signal] = await new Promise<[number | null, string | null]>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      await options.sink?.append("stdout", out, out.toString("utf8"));
      await options.sink?.append("stderr", err, err.toString("utf8"));
      await options.sink?.close();
      const now = new Date().toISOString();
      return {
        pid: null,
        exitCode: code,
        signal,
        spawnError: null,
        timedOut: false,
        trigger: null,
        exitObserved: true,
        spawnedAt: now,
        spawnedAtMono: 1,
        exitedAt: now,
        exitedAtMono: 2,
        stdout: { bytes: out.byteLength, text: out.toString("utf8"), truncated: false, utf8Valid: true, rawPath: options.streamPaths.stdoutBin, textPath: options.streamPaths.stdoutText, complete: true },
        stderr: { bytes: err.byteLength, text: err.toString("utf8"), truncated: false, utf8Valid: true, rawPath: options.streamPaths.stderrBin, textPath: options.streamPaths.stderrText, complete: true },
        stdoutText: out.toString("utf8"),
        stderrText: err.toString("utf8"),
        ownership: null,
        cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
        captureError: null,
        storageError: null,
        error: null,
      };
    },
  };
  const execution = new ExecutionImpl(makeConfig(root), manager, { processRunner: runner });
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
    const marker = "GDRE_GENERATED_PROFILE=";
    const reportLine = result.stdout.text.split(/\r?\n/u).find((line) => line.startsWith(marker));
    assert.ok(reportLine);
    const report = JSON.parse(reportLine.slice(marker.length)) as Record<string, { type: number; value: boolean }>;
    for (const [name, value] of Object.entries(report)) {
      assert.equal(value.type, 1, name);
      assert.equal(value.value, false, name);
    }
    assert.equal(Object.keys(report).length, 11);
    const readbackEvidence = path.join(root, "gdre-generated-profile-readback.json");
    await writeFile(readbackEvidence, JSON.stringify(report, null, 2), "utf8");
    if (process.env.GDRE_C1_KEEP_PROFILE === "1") process.stdout.write(`C1_PROFILE_READBACK=${readbackEvidence}\n`);
    assert.equal(result.paths.operation !== null, true);
    const generated = path.join(result.paths.operation!, "profile", "appdata", "Godot", "app_userdata", "Godot RE Tools", "gdre_settings.cfg");
    assert.equal((await readFile(generated, "utf8")).includes("\\n"), false);
  } finally {
    await execution.close("shutdown");
    if (process.env.GDRE_C1_KEEP_PROFILE !== "1") await rm(root, { recursive: true, force: true });
  }
});

test("list key secrets are redacted from prelaunch missing-input errors before bounding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-secret-error-"));
  await mkdir(path.join(root, "workspace"), { recursive: true });
  const longName = `${"x".repeat(1_980)}${key}.pck`;
  const execution = openFakeExecution(root, makeConfig(root), {});
  try {
    const result = await execution.execute("list-files", {
      inputs: [{ kind: "path", path: longName }],
      key,
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    await assertDurableListingFailure(result);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(key), false);
    assert.equal(serialized.includes(key.slice(0, 8)), false);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("list key secrets are redacted from process errors before the 2048-byte bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-secret-process-error-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const processError = new Error(`${"x".repeat(1_980)}${key}${"y".repeat(32)}`);
  const execution = openFakeExecution(root, makeConfig(root), {}, processError);
  try {
    const result = await execution.execute("list-files", {
      inputs: [{ kind: "path", path: "pack.pck" }],
      key,
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "process_failed");
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(result).includes(key.slice(0, 8)), false);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, unknown>;
    assert.equal(JSON.stringify(manifest).includes(key), false);
    assert.equal(JSON.stringify(manifest).includes(key.slice(0, 8)), false);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
test("explicit empty listing session replaces configured multithreading defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-session-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root, {
    "list-files": { timeoutMs: 800, session: [{ kind: "multithreading", disabled: true }] },
  }), observed);
  try {
    const result = await execution.execute("list-files", {
      inputs: [{ kind: "path", path: "pack.pck" }],
      session: [],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    assert.equal(observed.options?.argv.some((value) => value.startsWith("--disable-multithreading")), false);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.session, []);
    assert.equal(manifest.parameterSources.session, "call");
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("nonempty configured application settings reject list-files before operation allocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-settings-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const execution = openFakeExecution(root, makeConfig(root, {}, [{ key: "General/example", type: "boolean", value: true }]), {});
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "validation_failed");
    assert.equal(result.paths.operation, null);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("listing execution expands ordered globs and rejects aliases, no-match, and metadata overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-paths-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "packs"), { recursive: true });
    await writeFile(path.join(workspace, "packs", "b.pck"), "b", "utf8");
    await writeFile(path.join(workspace, "packs", "a.pck"), "a", "utf8");
    const observed: { options?: ProcessRunOptions } = {};
    const execution = openFakeExecution(root, makeConfig(root), observed);
    try {
      const expanded = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "packs/*.pck" }] }, { signal: new AbortController().signal });
      assert.equal(expanded.success, true);
      assert.deepEqual(observed.options?.argv.filter((value) => value.startsWith("--list-files=")).map((value) => path.basename(value.slice("--list-files=".length))), ["a.pck", "b.pck"]);

      const literalPunctuation = path.join(workspace, "packs", "file(1)+!x.pck");
      await writeFile(literalPunctuation, "literal", "utf8");
      const punctuation = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "packs/file(1)+!?.pck" }] }, { signal: new AbortController().signal });
      assert.equal(punctuation.success, true);
      const extglob = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "packs/file!(*).pck" }] }, { signal: new AbortController().signal });
      assert.equal(extglob.error?.code, "path_unsupported");
      await assertDurableListingFailure(extglob);

      const noMatch = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "packs/missing-*.pck" }] }, { signal: new AbortController().signal });
      assert.equal(noMatch.error?.code, "path_unsupported");
      await assertDurableListingFailure(noMatch);

      const duplicate = await execution.execute("list-files", { inputs: [
        { kind: "path", path: "packs/a.pck" },
        { kind: "path", path: "packs/./a.pck" },
      ] }, { signal: new AbortController().signal });
      assert.equal(duplicate.error?.code, "path_unsupported");
      await assertDurableListingFailure(duplicate);
      await mkdir(path.join(workspace, ".gdre", "operations"), { recursive: true });
      const recursiveMetadata = await execution.execute("list-files", { inputs: [{ kind: "glob", pattern: "**/*.pck" }] }, { signal: new AbortController().signal });
      assert.equal(recursiveMetadata.error?.code, "path_unsupported");
      await assertDurableListingFailure(recursiveMetadata);
      const metadata = await execution.execute("list-files", { inputs: [{ kind: "path", path: ".gdre" }] }, { signal: new AbortController().signal });
      assert.equal(metadata.error?.code, "path_unsupported");
      await assertDurableListingFailure(metadata);
    } finally {
      await execution.close("shutdown");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listing preparation records trusted sidecar and app resource dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-dependencies-"));
  try {
    const workspace = path.join(root, "workspace");
    const app = path.join(workspace, "game.app");
    await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(workspace, "game.exe"), "exe", "utf8");
    await writeFile(path.join(workspace, "game.pck"), "sidecar", "utf8");
    await writeFile(path.join(app, "Contents", "Resources", "game.pck"), "app resource", "utf8");
    const sidecar = await prepareListingInputs(workspace, { inputs: [{ kind: "path", path: "game.exe" }] });
    assert.deepEqual(sidecar.fingerprints.map((entry) => entry.role), ["input", "dependency"]);
    const appPreparation = await prepareListingInputs(workspace, { inputs: [{ kind: "path", path: "game.app" }] });
    assert.deepEqual(appPreparation.fingerprints.map((entry) => entry.role), ["input", "dependency"]);
    assert.ok(appPreparation.fingerprints.some((entry) => entry.path.endsWith(path.join("Contents", "Resources", "game.pck"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("listing execution corroborates only selected sidecar and app PCK loads while retaining full fingerprints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-selected-loads-"));
  try {
    const workspace = path.join(root, "workspace");
    const app = path.join(workspace, "game.app");
    const resources = path.join(app, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(workspace, "game.exe"), "exe", "utf8");
    const sidecar = path.join(workspace, "game.pck");
    await writeFile(sidecar, "sidecar", "utf8");
    const appPck = path.join(resources, "game.pck");
    await writeFile(appPck, "app", "utf8");
    const outputFactory = (inputs: readonly string[]): string => {
      const primary = inputs[0]!;
      return listOutput(primary.toLowerCase().endsWith(".exe") ? sidecar : appPck);
    };
    const execution = openFakeExecution(root, makeConfig(root), {}, undefined, undefined, outputFactory);
    try {
      const sidecarResult = await execution.execute("list-files", { inputs: [{ kind: "path", path: "game.exe" }] }, { signal: new AbortController().signal });
      assert.equal(sidecarResult.success, true);
      const sidecarManifest = JSON.parse(await readFile(sidecarResult.paths.manifest!, "utf8")) as Record<string, any>;
      assert.deepEqual(sidecarManifest.invocation.inputPaths.map((value: any) => value.role), ["input", "dependency"]);
      assert.equal(sidecarManifest.invocation.inputPaths.length, 2);

      const appResult = await execution.execute("list-files", { inputs: [{ kind: "path", path: "game.app" }] }, { signal: new AbortController().signal });
      assert.equal(appResult.success, true);
      const appManifest = JSON.parse(await readFile(appResult.paths.manifest!, "utf8")) as Record<string, any>;
      assert.deepEqual(appManifest.invocation.inputPaths.map((value: any) => value.role), ["input", "dependency"]);
      assert.equal(appManifest.invocation.inputPaths.length, 2);
    } finally {
      await execution.close("shutdown");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("listing preparation rejects dependency graph mutation and ambiguous app packs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-graph-mutation-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const exe = path.join(workspace, "game.exe");
    const sidecar = path.join(workspace, "game.pck");
    await writeFile(exe, "exe", "utf8");
    await writeFile(sidecar, "sidecar", "utf8");
    const prepared = await prepareListingInputs(workspace, { inputs: [{ kind: "path", path: "game.exe" }] });
    await writeFile(sidecar, "changed sidecar", "utf8");
    await assert.rejects(revalidateListingInputs(prepared));

    const app = path.join(workspace, "ambiguous.app", "Contents", "Resources");
    await mkdir(app, { recursive: true });
    await writeFile(path.join(app, "one.pck"), "one", "utf8");
    await writeFile(path.join(app, "two.pck"), "two", "utf8");
    await assert.rejects(prepareListingInputs(workspace, { inputs: [{ kind: "path", path: "ambiguous.app" }] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("listing preparation cancellation persists a terminal record and retry has no stale ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-prep-cancel-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  let calls = 0;
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const inspector: ListingDirectoryInspector = {
    async inspect(directories, signal) {
      calls += 1;
      if (calls === 1) {
        enteredResolve?.();
        await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      }
      return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
    },
  };
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed, undefined, inspector);
  try {
    const request = new AbortController();
    const pending = execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: request.signal });
    await entered;
    request.abort("cancelled");
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error?.code, "cancelled");
    await assertDurableListingFailure(cancelled);
    const retry = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
    assert.equal(retry.success, true);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("listing close waits for preparation cancellation and never launches a child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-prep-close-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const inspector: ListingDirectoryInspector = {
    async inspect(directories, signal) {
      enteredResolve?.();
      await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("shutdown")), { once: true }));
      return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
    },
  };
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed, undefined, inspector);
  try {
    const pending = execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
    await entered;
    const closing = execution.close("shutdown");
    const result = await pending;
    await closing;
    assert.equal(result.status, "interrupted");
    assert.equal(result.error?.code, "shutdown");
    assert.equal(observed.options, undefined);
    await assertDurableListingFailure(result);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("slow listing preparation has no implicit deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-prep-budget-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const inspector: ListingDirectoryInspector = {
    async inspect(directories) {
      await sleep(250);
      return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
    },
  };
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed, undefined, inspector);
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    assert.ok(observed.options);
    assert.equal(observed.options.deadlineMono, undefined);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("listing graph mutation at the running phase is rejected before spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-prelaunch-mutation-"));
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "pack.pck");
  await mkdir(workspace, { recursive: true });
  await writeFile(input, "original", "utf8");
  const observed: { options?: ProcessRunOptions } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed);
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }] }, {
      signal: new AbortController().signal,
      progress: ({ phase }) => {
        if (phase === "running") writeFileSync(input, "replaced", "utf8");
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "path_unsupported");
    assert.equal(observed.options, undefined);
    await assertDurableListingFailure(result);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit timeout starts at the first process, not during delayed preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-run-budget-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "pack.pck"), "input", "utf8");
  const inspector: ListingDirectoryInspector = {
    async inspect(directories) {
      await sleep(300);
      return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
    },
  };
  const observed: { options?: ProcessRunOptions; runRemaining?: number } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed, undefined, inspector);
  try {
    const result = await execution.execute("list-files", { inputs: [{ kind: "path", path: "pack.pck" }], timeoutMs: 500 }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    assert.equal(observed.options?.deadlineMono, undefined);
    assert.equal(observed.options?.timeoutMs, undefined);
  } finally {
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
test("independent listing calls in distinct workspaces overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-overlap-"));
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  const alias = path.join(workspace, "alias");
  await mkdir(workspace, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "pack.pck"), "pack", "utf8");
  await writeFile(path.join(external, "other.pck"), "other", "utf8");
  await symlink(external, alias, "junction");
  let enteredResolve: (() => void) | undefined;
  let releaseResolve: (() => void) | undefined;
  let secondEnteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const secondEntered = new Promise<void>((resolve) => { secondEnteredResolve = resolve; });
  const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const observed: { options?: ProcessRunOptions; runRemaining?: number } = {};
  const execution = openFakeExecution(root, makeConfig(root), observed, undefined, undefined, undefined, undefined, async (runNumber) => {
    if (runNumber === 1) {
      enteredResolve?.();
      await released;
    } else {
      secondEnteredResolve?.();
    }
  });
  try {
    const first = execution.execute("list-files", { inputs: [{ kind: "path", path: path.join("alias", "pack.pck") }] }, { signal: new AbortController().signal });
    void first.catch(() => undefined);
    await entered;
    const second = execution.execute("list-files", {
      workspace: external,
      inputs: [{ kind: "path", path: "other.pck" }],
    }, { signal: new AbortController().signal });
    void second.catch(() => undefined);
    // The second call must reach its own process while the first is still held.
    const outcome = await Promise.race([
      secondEntered.then(() => "entered" as const),
      second.then((result) => `settled ${JSON.stringify({ status: result.status, error: result.error })}` as const),
      sleep(5_000).then(() => "timeout" as const),
    ]);
    assert.equal(outcome, "entered", "the independent call must reach its own process while the first is held");
    releaseResolve?.();
    assert.equal((await first).success, true);
    assert.equal((await second).success, true);
  } finally {
    releaseResolve?.();
    await execution.close("shutdown");
    await rm(root, { recursive: true, force: true });
  }
});
test("loadConfig accepts list-files timeout/session defaults and rejects unsupported default fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-list-config-"));
  try {
    const configFile = path.join(root, "config.json");
    await writeFile(configFile, JSON.stringify({
      workspaceRoot: root,
      defaults: { "list-files": { timeoutMs: 321, session: [{ kind: "multithreading", disabled: false }] } },
      settings: {},
    }), "utf8");
    const loaded = await loadConfig(root, { GDRE_MCP_CONFIG: configFile });
    assert.equal(loaded.defaults["list-files"]?.timeoutMs, 321);
    assert.deepEqual(loaded.defaults["list-files"]?.session, [{ kind: "multithreading", disabled: false }]);
    await writeFile(configFile, JSON.stringify({ workspaceRoot: root, defaults: { "list-files": { key } } }), "utf8");
    await assert.rejects(loadConfig(root, { GDRE_MCP_CONFIG: configFile }));
    await writeFile(configFile, JSON.stringify({
      workspaceRoot: root,
      defaults: { "list-files": { session: Array.from({ length: 65 }, () => ({ kind: "multithreading", disabled: false })) } },
    }), "utf8");
    await assert.rejects(loadConfig(root, { GDRE_MCP_CONFIG: configFile }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
