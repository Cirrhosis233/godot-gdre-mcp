import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedConfig } from "../src/config.js";
import { checkRuntime } from "../src/runtime.js";
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner, StreamSummaryValue } from "../src/process.js";

const makeConfig = (root: string): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: root,
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 10_000 },
  defaults: {},
  settings: [],
  sources: {
    workspace: "builtin",
    runtimeDirectory: "builtin",
    targetVersion: "builtin",
    timeouts: "builtin",
    defaults: "builtin",
    settings: "builtin",
  },
});

const summary = (
  options: ProcessRunOptions,
  kind: "stdout" | "stderr",
  text: string,
  truncated: boolean,
): StreamSummaryValue => ({
  bytes: truncated ? 20_000 : Buffer.byteLength(text, "utf8"),
  text,
  truncated,
  utf8Valid: true,
  rawPath: kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath: kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete: true,
});

const fakeRun = (storageError: string | null): ProcessRunner => ({
  run: async (options): Promise<ProcessRunResult> => {
    const stdoutText = "Godot RE Tools v2.8.0-beta.2\r\n";
    const stderrText = "startup prefix\n...[truncated]...\nstartup suffix";
    return {
      pid: 1234,
      exitCode: 1,
      signal: null,
      spawnError: null,
      timedOut: false,
      trigger: null,
      exitObserved: true,
      spawnedAt: "2026-10-19T00:00:00.000Z",
      spawnedAtMono: 1,
      exitedAt: "2026-10-19T00:00:00.010Z",
      exitedAtMono: 11,
      stdout: summary(options, "stdout", stdoutText, false),
      stderr: summary(options, "stderr", stderrText, true),
      stdoutText,
      stderrText,
      ownership: null,
      cleanup: { state: "confirmed", trigger: null, actions: [], error: null },
      captureError: null,
      storageError,
      error: null,
    };
  },
});

const prepareRuntime = async (): Promise<{ readonly root: string; readonly config: LoadedConfig }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-runtime-streams-"));
  const runtime = path.join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  await Promise.all([
    writeFile(path.join(runtime, "gdre_tools.exe"), "exe"),
    writeFile(path.join(runtime, "gdre_tools.pck"), "pck"),
    writeFile(path.join(runtime, "GodotMonoDecompNativeAOT.dll"), "dll"),
  ]);
  return { root, config: makeConfig(root) };
};

test("startup probe retains its independent ten-second budget", async () => {
  const prepared = await prepareRuntime();
  const observed: (number | undefined)[] = [];
  try {
    await checkRuntime({ ...prepared.config, defaults: { version: { timeoutMs: 20 } } }, {
      processRunner: {
        async run(options) {
          observed.push(options.timeoutMs);
          return fakeRun(null).run(options);
        },
      },
    });
    assert.deepEqual(observed, [10_000]);
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test("truncated startup stderr makes runtime health unavailable with retained-evidence guidance", async () => {
  const prepared = await prepareRuntime();
  try {
    const state = await checkRuntime(prepared.config, { processRunner: fakeRun(null) });
    assert.equal(state.health, "unavailable");
    assert.ok(state.warnings.some((warning) => warning.includes("stderr preview was truncated")));
    assert.ok(state.warnings.some((warning) => warning.includes(state.probe.stderr.textPath ?? "")));
    assert.equal(state.probe.stderr.truncated, true);
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test("startup stream storage failure keeps precedence over truncated-stderr diagnostics", async () => {
  const prepared = await prepareRuntime();
  try {
    const state = await checkRuntime(prepared.config, { processRunner: fakeRun("injected startup stream storage failure") });
    assert.equal(state.health, "unavailable");
    assert.ok(state.warnings.some((warning) => warning.includes("injected startup stream storage failure")));
    assert.ok(!state.warnings.some((warning) => warning.includes("stderr preview was truncated")));
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
});
