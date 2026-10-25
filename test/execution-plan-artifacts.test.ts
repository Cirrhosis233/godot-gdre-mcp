import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { mock } from "node:test";
import { inventoryArtifacts } from "../src/artifacts.js";
import { ExecutionImpl } from "../src/execution.js";
import type { LoadedConfig } from "../src/config.js";
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner, StreamSummaryValue } from "../src/process.js";
import { versionCommand } from "../src/registry.js";
import type { RuntimeManager } from "../src/runtime.js";
import type { RuntimeState, PlanningContext, VersionInput, InvocationPlan } from "../src/types.js";

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const successText = "Godot RE Tools v2.8.0-beta.2\r\n";

const stream = (options: ProcessRunOptions, kind: "stdout" | "stderr", text: string): StreamSummaryValue => ({
  bytes: Buffer.byteLength(text, "utf8"),
  text,
  truncated: false,
  utf8Valid: true,
  rawPath: kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath: kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete: true,
});

const scriptedRunner = (produce: (options: ProcessRunOptions) => Promise<void> = async () => undefined): ProcessRunner => ({
  async run(options): Promise<ProcessRunResult> {
    const spawnedAtMono = performance.now();
    await produce(options);
    await options.sink?.append("stdout", Buffer.from(successText, "utf8"), successText);
    await options.sink?.close();
    const exitedAtMono = performance.now();
    return {
      pid: null,
      exitCode: 1,
      signal: null,
      spawnError: null,
      timedOut: false,
      trigger: null,
      exitObserved: true,
      spawnedAt: new Date().toISOString(),
      spawnedAtMono,
      exitedAt: new Date().toISOString(),
      exitedAtMono,
      stdout: stream(options, "stdout", successText),
      stderr: stream(options, "stderr", ""),
      stdoutText: successText,
      stderrText: "",
      ownership: null,
      cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
      captureError: null,
      storageError: null,
      error: null,
    };
  },
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
  evidencePath: path.join(root, "startup.json"),
  probe: {
    exitCode: 1,
    signal: null,
    stdout: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    stderr: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    error: null,
  },
  warnings: [],
});

const config = (root: string, defaultTimeout?: number): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults: defaultTimeout === undefined ? {} : { version: { timeoutMs: defaultTimeout } },
  settings: [],
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: defaultTimeout === undefined ? "builtin" : "config",
    settings: "builtin",
  },
});

const makeExecution = (root: string, runner: ProcessRunner, defaultTimeout?: number): ExecutionImpl => {
  const state = runtimeState(root);
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  return new ExecutionImpl(config(root, defaultTimeout), manager, { processRunner: runner });
};

const execute = (execution: ExecutionImpl, timeoutMs = 1_000, signal: AbortSignal = new AbortController().signal) =>
  execution.execute("version", { timeoutMs }, { signal });

const closeAndRemove = async (execution: ExecutionImpl, root: string): Promise<void> => {
  await execution.close("shutdown");
  await rm(root, { recursive: true, force: true });
};

test("one planner result drives runner and manifest invocation/effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-plan-spy-"));
  const plannedCwd = path.join(root, "planned-cwd");
  const calls: { readonly input: VersionInput; readonly operationDirectory: string }[] = [];
  const originalPlan = versionCommand.plan;
  const planMock = mock.method(versionCommand, "plan", (input: VersionInput, context: PlanningContext): InvocationPlan => {
    calls.push({ input, operationDirectory: context.operationDirectory });
    return {
      ...originalPlan(input, context),
      argv: ["--planned-version"],
      cwd: plannedCwd,
      timeoutMs: 73,
      effects: {
        reads: ["D:/planned/read.txt"],
        writes: [context.operationDirectory],
        network: true,
        codeExecution: false,
        unknownScope: true,
      },
    };
  });
  let observed: ProcessRunOptions | undefined;
  const execution = makeExecution(root, {
    run: async (options) => {
      observed = options;
      return (await scriptedRunner().run(options));
    },
  });
  try {
    const result = await execution.execute("version", { timeoutMs: 41 }, { signal: new AbortController().signal });
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input.timeoutMs, 41);
    if (observed === undefined) throw new Error("scripted runner was not invoked");
    assert.equal(observed.timeoutMs, undefined, "shared execution owns the only timeout timer");
    assert.equal(observed.deadlineMono, undefined);
    assert.ok(observed.signal instanceof AbortSignal);
    assert.deepEqual(observed.argv, ["--planned-version"]);
    assert.equal(observed.cwd, plannedCwd);

    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.invocation.argv, ["--planned-version"]);
    assert.equal(manifest.invocation.cwd, plannedCwd);
    assert.equal(manifest.invocation.environmentProfile.overrides.CWD, plannedCwd);
    assert.equal(manifest.effectiveParameters.timeoutMs, 73);
    assert.equal(manifest.effects.network, true);
    assert.equal(manifest.effects.unknownScope, true);
    assert.ok(manifest.effects.reads.includes("D:/planned/read.txt"));
    assert.ok(manifest.effects.writes.includes(result.paths.operation));
    assert.ok(manifest.effects.writes.includes(result.paths.output));
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, true);
  } finally {
    planMock.mock.restore();
    await closeAndRemove(execution, root);
  }
});

test("unexpected output is hashed, persisted, and fails version semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-unexpected-"));
  const payload = Buffer.from("unexpected version output", "utf8");
  const execution = makeExecution(root, scriptedRunner(async (options) => {
    const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
    await writeFile(path.join(output, "unexpected.bin"), payload);
  }));
  try {
    const result = await execute(execution);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "semantic_failed");
    assert.equal(result.artifacts.count, 1);
    assert.equal(result.artifacts.complete, true);
    assert.equal(result.artifacts.items[0]?.bytes, payload.byteLength);
    assert.equal(result.artifacts.items[0]?.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.equal(result.semantic.status, "failed");

    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, 1);
    assert.equal(inventory.entries[0].path, result.artifacts.items[0]?.path);
    assert.equal(inventory.entries[0].bytes, payload.byteLength);
    assert.equal(inventory.entries[0].sha256, result.artifacts.items[0]?.sha256);
  } finally {
    await closeAndRemove(execution, root);
  }
});

test("request cancellation retains partial output without inventory auditing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-cancelled-"));
  const request = new AbortController();
  const execution = makeExecution(root, {
    run: async (options) => {
      const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
      await writeFile(path.join(output, "partial.bin"), "cancelled partial", "utf8");
      request.abort("cancel");
      const completed = await scriptedRunner().run(options);
      return {
        ...completed,
        trigger: "cancel",
        cleanup: { ...completed.cleanup, trigger: "cancel" },
      };
    },
  });
  try {
    const result = await execute(execution, 1_000, request.signal);
    assert.equal(result.success, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(result.artifacts.count, 0, "stopped output was not inventoried");
    assert.equal(result.artifacts.complete, false);
    assert.equal(result.persistence.state, "complete");
    assert.equal(await readFile(path.join(result.paths.output!, "partial.bin"), "utf8"), "cancelled partial");

    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);
  } finally {
    await closeAndRemove(execution, root);
  }
});

test("nested output projection stays bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-tree-"));
  const execution = makeExecution(root, scriptedRunner(async (options) => {
    const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
    const nested = path.join(output, "nested", "inner");
    await mkdir(nested, { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(output, `file-${String(index).padStart(2, "0")}.bin`), String(index), "utf8");
    }
    await writeFile(path.join(nested, "nested.bin"), "nested", "utf8");
  }));
  try {
    const result = await execute(execution);
    assert.equal(result.success, false);
    assert.equal(result.artifacts.complete, true);
    assert.ok(result.artifacts.count > 32);
    assert.equal(result.artifacts.items.length, 32);
    assert.equal(result.artifacts.truncated, true);

    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, result.artifacts.count);
    assert.ok(inventory.entries.some((entry: any) => entry.path.endsWith(path.join("nested", "inner", "nested.bin"))));
  } finally {
    await closeAndRemove(execution, root);
  }
});

test("symlink or junction output is recorded incomplete without following its outside sentinel", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-link-"));
  let fixtureError: string | null = null;
  const execution = makeExecution(root, scriptedRunner(async (options) => {
    const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "outside sentinel", "utf8");
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(outside, path.join(output, "link-dir"), linkType);
    } catch (error) {
      fixtureError = error instanceof Error ? error.message : String(error);
    }
  }));
  try {
    const result = await execute(execution);
    if (fixtureError !== null) {
      t.skip(`platform refused symlink/junction fixture: ${fixtureError}`);
      return;
    }
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "process_failed");
    assert.equal(result.artifacts.complete, false);

    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.complete, false);
    assert.equal(inventory.entries.some((entry: any) => entry.path.endsWith("secret.txt")), false);
    const link = inventory.entries.find((entry: any) => entry.path.endsWith(path.join("output", "link-dir")));
    assert.equal(link?.kind, "link");
    assert.equal(link?.bytes, null);
    assert.equal(link?.sha256, null);
    assert.match(link?.error ?? "", /symlink\/reparse point recorded without traversal/u);
    assert.ok(inventory.errors.some((error: string) => /symlink\/reparse/u.test(error)));
  } finally {
    await closeAndRemove(execution, root);
  }
});

test("explicit timeout retains partial files without a salvage inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-timeout-salvage-"));
  const execution = makeExecution(root, scriptedRunner(async (options) => {
    await sleep(25);
    const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
    await writeFile(path.join(output, "partial.bin"), "partial", "utf8");
  }));
  try {
    const result = await execute(execution, 1);
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(result.persistence.state, "complete");
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, false);
    assert.equal(await readFile(path.join(result.paths.output!, "partial.bin"), "utf8"), "partial");

    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);
  } finally {
    await closeAndRemove(execution, root);
  }
});

test("normal inventory with an already expired deadline stops before discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-prescan-deadline-"));
  try {
    await writeFile(path.join(root, "partial.bin"), "partial", "utf8");
    const inventory = await inventoryArtifacts(
      [{ path: root, role: "output" }],
      { deadlineMono: performance.now() - 1 },
    );
    assert.equal(inventory.stopReason, "deadline");
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);
    assert.ok(inventory.errors.some((error) => error.includes("deadline")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory stop after discovery preserves stat size, errors, and null hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-stop-after-discovery-"));
  const payload = "known-size";
  try {
    await writeFile(path.join(root, "partial.bin"), payload, "utf8");
    let checks = 0;
    const signal = {
      get aborted(): boolean {
        checks += 1;
        return checks > 6;
      },
    } as unknown as AbortSignal;
    const inventory = await inventoryArtifacts([{ path: root, role: "output" }], { signal });
    assert.equal(inventory.stopReason, "cancelled");
    assert.equal(inventory.complete, false);
    assert.equal(inventory.entries.length, 1);
    assert.equal(inventory.entries[0]?.bytes, Buffer.byteLength(payload, "utf8"));
    assert.equal(inventory.entries[0]?.sha256, null);
    assert.match(inventory.entries[0]?.error ?? "", /cancellation/u);
    assert.ok(inventory.errors.some((error) => /cancellation/u.test(error)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing declared root is explicit incomplete artifact evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-artifact-missing-"));
  try {
    const inventory = await inventoryArtifacts([{ path: path.join(root, "missing-output"), role: "output" }]);
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);
    assert.ok(inventory.errors[0]?.includes("missing-output"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
