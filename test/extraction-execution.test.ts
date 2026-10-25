import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { LoadedConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import { AtomicJsonWriter, StorageError, type JsonWriter, type StorageFaults } from "../src/storage.js";
import type { ProcessRunOptions, ProcessRunResult, ProcessRunner, StreamSummaryValue } from "../src/process.js";
import type { RuntimeManager } from "../src/runtime.js";
import type { RuntimeState } from "../src/types.js";
import { extractionFixtureDirectories, extractionFixtureMembers } from "./support/extraction-fixtures.js";

type AnyRecord = Record<string, any>;

const makeConfig = (root: string, defaults: LoadedConfig["defaults"] = {}): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults,
  settings: [],
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: Object.keys(defaults).length === 0 ? "builtin" : "config",
    settings: "builtin",
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

const stream = (options: ProcessRunOptions, kind: "stdout" | "stderr", text: string): StreamSummaryValue => ({
  bytes: Buffer.byteLength(text, "utf8"),
  text,
  truncated: false,
  utf8Valid: true,
  rawPath: kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath: kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete: true,
});

interface TestMember {
  readonly name: string;
  readonly relative: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

const preflightOutput = (input: string, failure: boolean, members: readonly TestMember[]): string => [
  `Input files: ["${input}"]`,
  "GDRE Tools v2.8.0-beta.2",
  "Windows 10.0.26100, headless",
  `Opening file: ${input}`,
  ...(failure ? [`Error: failed to open ["${input}"]`] : []),
  "",
  "Contents:",
  ...(failure ? [] : members.map((member) => member.name)),
  "",
  failure ? "Total files: 0" : `Total files: ${String(members.length)}`,
  "",
].join("\n");

const extractionOutput = (
  input: string,
  output: string,
  members: readonly TestMember[],
  options: { failure?: boolean } = {},
): string => [
  `Input files: ["${input}"]`,
  "GDRE Tools v2.8.0-beta.2",
  "Windows 10.0.26100, headless",
  `Opening file: ${input}`,
  "Successfully loaded PCK!",
  "Version: 4.4.0",
  `Verified ${String(members.length)} files, no errors detected!`,
  `Extracted ${String(members.length)} files, no errors detected!`,
  "Extraction operation complete in 00m00s",
  `Log file written to: ${path.join(output, "gdre_export.log")}`,
  ...(options.failure ? ["Error: File write error"] : []),
  "",
].join("\n");

interface Scenario {
  readonly preflight: "ok" | "semantic-failure" | "timeout" | "unconfirmed-cleanup";
  readonly preflightCleanup?: ProcessRunResult["cleanup"];
  readonly extraction: "ok" | "partial" | "nonzero" | "timeout-partial" | "cancel-partial" | "cleanup-unconfirmed";
  readonly members?: readonly TestMember[];
  readonly foreignFile?: string;
  /** One-shot gate observed by the first preflight process only. */
  readonly gate?: Promise<void>;
  /** Natural preflight exit only after the common execution deadline expires. */
  readonly preflightDelay?: boolean;
  /** Request cancellation observed after a natural preflight exit, before scanning. */
  readonly abortAfterPreflight?: () => void;
  /** Remove retained preflight stream files to force hash/storage failure. */
  readonly missingPreflightEvidence?: boolean;
}

interface ExecutionOptions {
  readonly defaults?: LoadedConfig["defaults"];
  readonly storageFaults?: StorageFaults;
  readonly writer?: JsonWriter;
}

const openExecution = (
  root: string,
  scenario: Scenario,
  observed: { readonly argvs: string[][]; extractionOptions?: ProcessRunOptions },
  executionOptions: ExecutionOptions = {},
): ExecutionImpl => {
  const state = runtimeState(root);
  const manager = { state, refreshIfChanged: async (): Promise<RuntimeState> => state } as unknown as RuntimeManager;
  const members = scenario.members ?? extractionFixtureMembers;
  let runNumber = 0;
  let gateUsed = false;
  const deletePreflightEvidence = async (options: ProcessRunOptions): Promise<void> => {
    if (!scenario.missingPreflightEvidence) return;
    await Promise.all(Object.values(options.streamPaths).map((file) => rm(file, { force: true })));
  };
  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      runNumber += 1;
      observed.argvs.push([...options.argv]);
      const preflightArg = options.argv.find((value) => value.startsWith("--list-files="));
      if (preflightArg !== undefined) {
        if (scenario.gate !== undefined && !gateUsed) {
          gateUsed = true;
          await scenario.gate;
        }
        if (scenario.foreignFile !== undefined) {
          await mkdir(path.dirname(scenario.foreignFile), { recursive: true });
          await writeFile(scenario.foreignFile, "another operation's output\n", { encoding: "utf8", flag: "wx" });
        }
        if (scenario.preflight === "unconfirmed-cleanup") {
          await options.sink?.close();
          await deletePreflightEvidence(options);
          return {
            pid: 100 + runNumber,
            exitCode: null,
            signal: null,
            spawnError: null,
            timedOut: true,
            trigger: "timeout",
            exitObserved: false,
            spawnedAt: new Date().toISOString(),
            spawnedAtMono: performance.now(),
            exitedAt: null,
            exitedAtMono: null,
            stdout: stream(options, "stdout", ""),
            stderr: stream(options, "stderr", ""),
            stdoutText: "",
            stderrText: "",
            ownership: null,
            cleanup: { state: "unconfirmed", trigger: "timeout", actions: [], error: "owned preflight tree termination could not be confirmed" },
            captureError: null,
            storageError: null,
            error: null,
          };
        }
        if (scenario.preflight === "timeout") {
          await options.sink?.close();
          await deletePreflightEvidence(options);
          return {
            pid: 100 + runNumber,
            exitCode: null,
            signal: null,
            spawnError: null,
            timedOut: true,
            trigger: "timeout",
            exitObserved: false,
            spawnedAt: new Date().toISOString(),
            spawnedAtMono: performance.now(),
            exitedAt: null,
            exitedAtMono: null,
            stdout: stream(options, "stdout", ""),
            stderr: stream(options, "stderr", ""),
            stdoutText: "",
            stderrText: "",
            ownership: null,
            cleanup: { state: "confirmed", trigger: "timeout", actions: ["terminated owned tree"], error: null },
            captureError: null,
            storageError: null,
            error: null,
          };
        }
        if (scenario.preflightDelay && !options.signal?.aborted) {
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
        const input = preflightArg.slice("--list-files=".length);
        const output = preflightOutput(input, scenario.preflight === "semantic-failure", members);
        await options.sink?.append("stdout", Buffer.from(output, "utf8"), output);
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        await deletePreflightEvidence(options);
        scenario.abortAfterPreflight?.();
        return {
          pid: 100 + runNumber,
          exitCode: 0,
          signal: null,
          spawnError: null,
          timedOut: false,
          trigger: null,
          exitObserved: true,
          spawnedAt: new Date().toISOString(),
          spawnedAtMono: performance.now(),
          exitedAt: new Date().toISOString(),
          exitedAtMono: performance.now() + 1,
          stdout: stream(options, "stdout", output),
          stderr: stream(options, "stderr", ""),
          stdoutText: output,
          stderrText: "",
          ownership: null,
          cleanup: scenario.preflightCleanup ?? { state: "not_needed", trigger: null, actions: [], error: null },
          captureError: null,
          storageError: null,
          error: null,
        };
      }

      observed.extractionOptions = options;
      const extractArg = options.argv.find((value) => value.startsWith("--extract="));
      const outputArg = options.argv.find((value) => value.startsWith("--output="));
      assert.ok(extractArg);
      assert.ok(outputArg);
      const input = extractArg.slice("--extract=".length);
      const output = outputArg.slice("--output=".length);
      const partialOutcome = scenario.extraction === "partial"
        || scenario.extraction === "timeout-partial"
        || scenario.extraction === "cancel-partial";
      const written = partialOutcome ? members.slice(0, 1) : members;
      for (const member of written) {
        const file = path.join(output, ...member.relative.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, member.bytes, { flag: "wx" });
      }
      await writeFile(path.join(output, "gdre_export.log"), "administrative runtime log\n", { encoding: "utf8", flag: "wx" });
      const terminated = scenario.extraction === "timeout-partial" || scenario.extraction === "cancel-partial";
      const exitCode = scenario.extraction === "nonzero" ? 1 : terminated ? null : 0;
      const trigger = scenario.extraction === "timeout-partial"
        ? "timeout"
        : scenario.extraction === "cancel-partial"
          ? "cancel"
          : null;
      const unconfirmed = scenario.extraction === "cleanup-unconfirmed";
      const text = terminated
        ? [
            `Input files: ["${input}"]`,
            "GDRE Tools v2.8.0-beta.2",
            "Windows 10.0.26100, headless",
            `Opening file: ${input}`,
            "Successfully loaded PCK!",
            "Extracting files... [===============               ] 50%",
            "",
          ].join("\n")
        : extractionOutput(input, output, members, { failure: scenario.extraction === "partial" });
      await options.sink?.append("stdout", Buffer.from(text, "utf8"), text);
      await options.sink?.append("stderr", Buffer.alloc(0), "");
      await options.sink?.close();
      return {
        pid: 200 + runNumber,
        exitCode,
        signal: null,
        spawnError: null,
        timedOut: terminated && trigger === "timeout",
        trigger,
        exitObserved: !terminated,
        spawnedAt: new Date().toISOString(),
        spawnedAtMono: performance.now(),
        exitedAt: terminated ? null : new Date().toISOString(),
        exitedAtMono: terminated ? null : performance.now() + 1,
        stdout: stream(options, "stdout", text),
        stderr: stream(options, "stderr", ""),
        stdoutText: text,
        stderrText: "",
        ownership: null,
        cleanup: unconfirmed
          ? { state: "unconfirmed", trigger: null, actions: [], error: "owned extraction tree termination could not be confirmed" }
          : terminated
            ? { state: "confirmed", trigger, actions: ["terminated owned tree"], error: null }
            : { state: "not_needed", trigger: null, actions: [], error: null },
        captureError: null,
        storageError: null,
        error: null,
      };
    },
  };
  return new ExecutionImpl(makeConfig(root, executionOptions.defaults), manager, {
    processRunner: runner,
    storageFaults: executionOptions.storageFaults,
    writer: executionOptions.writer,
  });
};

const fixture = async (): Promise<{ readonly root: string; readonly workspace: string; readonly input: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-extract-execution-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "fixtures"), { recursive: true });
  const input = path.join(workspace, "fixtures", "authored 空间.pck");
  await writeFile(input, "authored input bytes", "utf8");
  return { root, workspace, input };
};

test("extraction preflight semantic failure never launches extraction and preserves its failure", async () => {
  const value = await fixture();
  const requestedOutput = path.join(value.root, "external output 空间");
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "semantic-failure", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      output: requestedOutput,
    }, { signal: new AbortController().signal });
    assert.equal(observed.argvs.length, 1, "only the internal preflight may run");
    assert.ok(observed.argvs[0]?.some((token) => token.startsWith("--list-files=")));
    assert.equal(observed.argvs[0]?.some((token) => token.startsWith("--extract=")), false);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "semantic_failed");
    assert.equal(result.process.pid, null);
    assert.equal(result.paths.effectiveDestination, requestedOutput);
    assert.equal(result.paths.output, path.join(result.paths.operation!, "output"));
    assert.equal(result.artifacts.complete, false);
    assert.equal(result.artifacts.count, 0);
    await assert.rejects(stat(requestedOutput), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.preflight.semantic.status, "failed");
    assert.equal(manifest.preflight.process.exitCode, 0);
    assert.equal(manifest.error.code, "semantic_failed");
    assert.deepEqual(manifest.cleanup, result.cleanup);
    assert.equal(manifest.preflight.cleanup.state, "not_needed");
    assert.equal(typeof manifest.preflight.timing.spawnedAt, "string");
    assert.equal(typeof manifest.preflight.timing.exitedAt, "string");
    assert.ok(String(manifest.preflight.ownership.statusPath).endsWith(path.join("preflight", "ownership.json")));
    assert.equal(manifest.preflight.ownership.state, manifest.preflight.cleanup.state);
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("extraction honors an explicit destination and inventories members and the administrative log", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][], extractionOptions: undefined as ProcessRunOptions | undefined };
  const execution = openExecution(value.root, { preflight: "ok", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      output: "exports/out 空间",
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true, JSON.stringify({ error: result.error, semantic: result.semantic }));
    const effective = path.join(value.workspace, "exports", "out 空间");
    assert.equal(result.paths.effectiveDestination, effective);
    assert.notEqual(result.paths.effectiveDestination, result.paths.output);
    assert.equal(observed.argvs.length, 2);
    assert.equal(observed.extractionOptions?.timeoutMs, undefined);
    assert.equal(observed.extractionOptions?.deadlineMono, undefined);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.invocation.argv, [
      "--headless",
      "--no-header",
      "--",
      `--extract=${value.input}`,
      `--output=${effective}`,
    ]);
    assert.equal(manifest.parameterSources.output, "call");
    assert.equal("timeoutMs" in manifest.parameterSources, false);
    assert.equal("timeoutMs" in manifest.effectiveParameters, false);
    assert.ok(manifest.effects.writes.includes(effective));
    assert.ok(manifest.effects.knownSideEffectRoots.includes(effective));
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    const byPath = new Map((inventory.entries as any[]).map((entry) => [entry.path, entry]));
    for (const member of extractionFixtureMembers) {
      const entry = byPath.get(path.join(effective, ...member.relative.split("/"))) as Record<string, any>;
      assert.equal(entry.role, "extracted");
      assert.equal(entry.kind, "file");
      assert.equal(entry.sha256, member.sha256);
    }
    assert.equal((byPath.get(path.join(effective, "gdre_export.log")) as Record<string, any>).role, "administrative-log");
    assert.equal((await stat(result.paths.output!)).isDirectory(), true);
    assert.equal((await stat(path.join(result.paths.output!, "gdre_export.log")).catch(() => null)), null);
    assert.ok(manifest.preflight.expectedMembers.path.endsWith("expected-members.json"));
    assert.notEqual(result.stdout.rawPath, manifest.preflight.stdout.rawPath);
    assert.match(await readFile(result.stdout.rawPath!, "utf8"), /Extraction operation complete/u);
    assert.match(await readFile(manifest.preflight.stdout.rawPath, "utf8"), /Total files: 3/u);
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a known nonzero extraction preserves files and diagnostics without semantic or inventory auditing", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "ok", extraction: "nonzero" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.error?.code, "process_failed");
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.artifacts.complete, false);
    assert.equal(result.artifacts.count, 0);
    const member = extractionFixtureMembers[0]!;
    assert.deepEqual(await readFile(path.join(result.paths.effectiveDestination!, ...member.relative.split("/"))), member.bytes);
    assert.match(await readFile(result.stdout.textPath!, "utf8"), /Extraction operation complete/u);
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8"));
    assert.deepEqual(inventory.entries, []);
    assert.equal(inventory.complete, false);
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed extraction retains partial output and complete retained evidence", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "ok", extraction: "partial" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      output: "partial output",
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "semantic_failed");
    const effective = path.join(value.workspace, "partial output");
    const partial = path.join(effective, ...extractionFixtureMembers[0]!.relative.split("/"));
    assert.deepEqual(await readFile(partial), extractionFixtureMembers[0]!.bytes, "partial output is preserved");
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    const entry = (inventory.entries as any[]).find((candidate) => candidate.path === partial) as Record<string, any>;
    assert.equal(entry.kind, "file");
    assert.equal(entry.sha256, extractionFixtureMembers[0]!.sha256);
    assert.equal(inventory.complete, true);
    assert.equal(result.artifacts.complete, true);
    assert.ok(result.semantic.evidence.some((line: string) => /File write error/u.test(line)) || result.semantic.status === "failed");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("preflight timeout is classified without launching extraction", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "timeout", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out", JSON.stringify(result));
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(observed.argvs.length, 1);
    assert.equal(result.process.pid, null);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, "timeout");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.cleanup, result.cleanup);
    assert.equal(manifest.preflight.cleanup.state, "confirmed");
    assert.equal(typeof manifest.preflight.process.pid, "number");
    assert.equal(typeof manifest.preflight.timing.spawnedAt, "string");
    assert.equal(manifest.preflight.timing.processMs, null);
    assert.equal(manifest.preflight.timing.exitedAt, null);
    assert.ok(String(manifest.preflight.ownership.statusPath).endsWith(path.join("preflight", "ownership.json")));
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("unconfirmed preflight cleanup fails closed for later launches and agrees with the manifest", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "unconfirmed-cleanup", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "cleanup_failed");
    assert.equal(result.process.pid, null);
    assert.equal(observed.argvs.length, 1);
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.cleanup.trigger, "timeout");
    assert.ok(result.cleanup.error);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.cleanup, result.cleanup);
    assert.equal(manifest.preflight.cleanup.state, "unconfirmed");
    assert.equal(manifest.preflight.process.pid, 101);
    assert.equal(manifest.preflight.timing.exitedAt, null);
    assert.equal(manifest.preflight.ownership.state, "unconfirmed");
    assert.equal(manifest.persistence.state, "complete");

    const second = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(second.success, false);
    assert.equal(second.error?.code, "cleanup_failed");
    assert.equal(second.paths.operation, null);
    assert.equal(observed.argvs.length, 1, "quarantine prevents any further launch");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

const bulkMembers: readonly TestMember[] = Array.from({ length: 40 }, (_, index) => {
  const relative = `bulk/member-${String(index).padStart(2, "0")}.txt`;
  const bytes = Buffer.from(`bulk member ${String(index)}\n`, "utf8");
  return {
    name: `res://${relative}`,
    relative,
    bytes,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("timeout and cancellation retain partial extraction without auditing its destination", async () => {
  for (const [outcome, status, code] of [
    ["timeout-partial", "timed_out", "execution_timeout"],
    ["cancel-partial", "cancelled", "cancelled"],
  ] as const) {
    const value = await fixture();
    const observed = { argvs: [] as string[][] };
    const execution = openExecution(value.root, { preflight: "ok", extraction: outcome }, observed);
    try {
      const result = await execution.execute("extract", {
        inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
        output: "partial output",
      }, { signal: new AbortController().signal });
      assert.equal(result.success, false);
      assert.equal(result.status, status);
      assert.equal(result.error?.code, code);
      assert.equal(result.process.exitCode, null);
      const effective = path.join(value.workspace, "partial output");
      const partial = path.join(effective, ...extractionFixtureMembers[0]!.relative.split("/"));
      assert.deepEqual(await readFile(partial), extractionFixtureMembers[0]!.bytes, outcome);
      const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
      assert.deepEqual(inventory.entries, []);
      assert.equal(inventory.complete, false);
      assert.equal(result.semantic.status, "not_evaluated");
      const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
      assert.equal(manifest.error.code, code, "uncollected inventory must not replace the termination trigger");
      assert.equal(manifest.cleanup.trigger, outcome === "timeout-partial" ? "timeout" : "cancel");
      assert.equal(manifest.cleanup.state, "confirmed");
      assert.equal(observed.argvs.length, 2);
    } finally {
      await execution.close("shutdown");
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("artifact and terminal-manifest storage failures outrank a successful extraction", async () => {
  const artifactCase = await fixture();
  const artifactExecution = openExecution(
    artifactCase.root,
    { preflight: "ok", extraction: "ok" },
    { argvs: [] },
    { storageFaults: { failArtifacts: true } },
  );
  try {
    const result = await artifactExecution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.error.code, "storage_failed");
    assert.equal(manifest.persistence.state, "incomplete");
  } finally {
    await artifactExecution.close("shutdown");
    await rm(artifactCase.root, { recursive: true, force: true });
  }

  const manifestCase = await fixture();
  const writer: JsonWriter = {
    async write(file, value) {
      if (file.endsWith("manifest.json") && (value as Record<string, unknown>).state === "succeeded") {
        throw new StorageError("injected terminal manifest failure");
      }
      await new AtomicJsonWriter().write(file, value);
    },
  };
  const manifestExecution = openExecution(
    manifestCase.root,
    { preflight: "ok", extraction: "ok" },
    { argvs: [] },
    { writer },
  );
  try {
    const result = await manifestExecution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
  } finally {
    await manifestExecution.close("shutdown");
    await rm(manifestCase.root, { recursive: true, force: true });
  }
});

test("cancellation after expected-member publication preserves observed preflight cleanup", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const controller = new AbortController();
  const cleanup: ProcessRunResult["cleanup"] = {
    state: "confirmed", trigger: null, actions: ["preflight Job observed empty"], error: null,
  };
  const delegate = new AtomicJsonWriter();
  const writer: JsonWriter = {
    async write(file, written) {
      await delegate.write(file, written);
      if (file.endsWith("expected-members.json")) controller.abort();
    },
  };
  const execution = openExecution(value.root, {
    preflight: "ok", preflightCleanup: cleanup, extraction: "ok",
  }, observed, { writer });
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(observed.argvs.length, 1, "only the already-completed preflight ran");
    assert.deepEqual(result.cleanup, cleanup);
    assert.equal(result.process.pid, null, "primary extraction process facts remain separate");
    assert.equal(result.stdout.bytes, 0);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.deepEqual(manifest.cleanup, cleanup);
    assert.deepEqual(manifest.preflight.cleanup, cleanup);
    assert.equal(manifest.preflight.process.pid, 101);
    const expected = JSON.parse(await readFile(path.join(result.paths.operation!, "preflight", "expected-members.json"), "utf8"));
    assert.equal(expected.complete, true, "the already-published member evidence is retained");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("selected-member evidence storage failure is storage_failed and prevents extraction launch", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const cleanup: ProcessRunResult["cleanup"] = {
    state: "confirmed", trigger: null, actions: ["preflight Job observed empty"], error: null,
  };
  const writer: JsonWriter = {
    async write(file, written) {
      if (file.endsWith("selected-members.json")) throw new StorageError("injected selected-member evidence failure");
      await new AtomicJsonWriter().write(file, written);
    },
  };
  const execution = openExecution(value.root, {
    preflight: "ok", preflightCleanup: cleanup, extraction: "ok",
  }, observed, { writer });
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    assert.deepEqual(result.cleanup, cleanup);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8"));
    assert.deepEqual(manifest.cleanup, cleanup);
    assert.deepEqual(manifest.preflight.cleanup, cleanup);
    assert.notEqual(result.semantic.status, "succeeded");
    assert.equal(observed.argvs.length, 1, "only the internal preflight ran");
    assert.equal(observed.argvs[0]?.some((token) => token.startsWith("--extract=")), false);
    assert.ok(observed.argvs[0]?.some((token) => token.startsWith("--list-files=")));
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("cleanup failure retains priority over artifact storage failure", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(
    value.root,
    { preflight: "ok", extraction: "cleanup-unconfirmed" },
    observed,
    { storageFaults: { failArtifacts: true } },
  );
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "cleanup_failed");
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.persistence.state, "incomplete");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.error.code, "cleanup_failed");
    assert.equal(manifest.cleanup.state, "unconfirmed");
    assert.equal(manifest.persistence.state, "incomplete");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("more than 32 extraction artifacts keep a complete retained inventory", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, {
    preflight: "ok",
    extraction: "ok",
    members: bulkMembers,
  }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true, JSON.stringify({ error: result.error, semantic: result.semantic }));
    const semanticData = result.semantic.data;
    assert.ok(semanticData !== null && "extractedFiles" in semanticData);
    assert.equal(semanticData.extractedFiles, 40);
    assert.equal(result.artifacts.count, 42, "40 files + bulk directory + administrative log");
    assert.equal(result.artifacts.items.length, 32);
    assert.equal(result.artifacts.truncated, true);
    assert.equal(result.artifacts.complete, true);
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.entries.length, 42);
    const effective = result.paths.effectiveDestination as string;
    for (const member of bulkMembers) {
      const entry = (inventory.entries as any[]).find(
        (candidate) => candidate.path === path.join(effective, ...member.relative.split("/")),
      ) as Record<string, any>;
      assert.equal(entry.role, "extracted");
      assert.equal(entry.sha256, member.sha256);
    }
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a destination filled during preflight launches no extraction and adopts no foreign artifacts", async () => {
  const value = await fixture();
  const requestedOutput = path.join(value.root, "external output 空间");
  const foreignFile = path.join(requestedOutput, "foreign.txt");
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, {
    preflight: "ok",
    extraction: "ok",
    foreignFile,
  }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      output: requestedOutput,
    }, { signal: new AbortController().signal });
    assert.equal(observed.argvs.length, 1, "only the preflight may run");
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "path_unsupported");
    assert.equal(result.paths.effectiveDestination, requestedOutput);
    assert.equal(result.artifacts.count, 0, "foreign output must not be adopted as our artifacts");
    assert.equal(result.artifacts.complete, false);
    assert.equal((await readFile(foreignFile, "utf8")), "another operation's output\n");
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.deepEqual(inventory.entries, []);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.error.code, "path_unsupported");
    assert.equal(manifest.preflight.semantic.status, "succeeded");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("independent extractions in distinct workspaces and destinations overlap", async () => {
  const value = await fixture();
  const destinationA = path.join(value.root, "output a");
  const destinationB = path.join(value.root, "output b");
  const workspaceA = path.join(value.root, "workspace a");
  const workspaceB = path.join(value.root, "workspace b");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(
    value.root,
    { preflight: "ok", extraction: "ok", gate },
    observed,
    // Scheduling test under suite concurrency, not a 1s-performance claim.
    { defaults: { extract: { timeoutMs: 10_000 } } },
  );
  const control = new AbortController();
  try {
    const first = execution.execute("extract", {
      workspace: workspaceA,
      inputs: [{ kind: "path", path: value.input }],
      output: path.join(destinationA, "out"),
    }, { signal: control.signal });
    void first.catch(() => undefined);
    for (let attempt = 0; attempt < 500 && observed.argvs.length === 0; attempt += 1) await sleep(10);
    assert.equal(observed.argvs.length, 1, "the first operation is gated in its preflight");
    const second = execution.execute("extract", {
      workspace: workspaceB,
      inputs: [{ kind: "path", path: value.input }],
      output: path.join(destinationB, "out"),
    }, { signal: control.signal });
    void second.catch(() => undefined);
    for (let attempt = 0; attempt < 500 && observed.argvs.length < 2; attempt += 1) await sleep(10);
    assert.equal(observed.argvs.length, 2, "the independent operation launches its own preflight without waiting for the first");
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.success, true, JSON.stringify({ error: firstResult.error, semantic: firstResult.semantic }));
    assert.equal(secondResult.success, true, JSON.stringify({ error: secondResult.error, semantic: secondResult.semantic }));
    assert.equal(observed.argvs.length, 4, "each operation runs its own preflight and extraction");
    for (const destination of [destinationA, destinationB]) {
      assert.deepEqual(
        await readFile(path.join(destination, "out", ...extractionFixtureMembers[0]!.relative.split("/"))),
        extractionFixtureMembers[0]!.bytes,
      );
    }
  } finally {
    release();
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("configured extraction timeout/session apply and explicit session [] replaces them", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][], extractionOptions: undefined as ProcessRunOptions | undefined };
  const execution = openExecution(
    value.root,
    { preflight: "ok", extraction: "ok" },
    observed,
    {
      defaults: {
        extract: {
          // This exercises configuration/session behavior, not timeout enforcement.
          timeoutMs: 30_000,
          session: [{ kind: "multithreading", disabled: true }],
        },
      },
    },
  );
  try {
    const configured = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(configured.success, true, JSON.stringify({ status: configured.status, error: configured.error, semantic: { status: configured.semantic.status, summary: configured.semantic.summary }, timing: configured.timing }));
    assert.equal(observed.extractionOptions?.timeoutMs, undefined);
    assert.equal(observed.extractionOptions?.deadlineMono, undefined);
    assert.ok(observed.argvs[0]?.includes("--disable-multithreading=true"));
    assert.ok(observed.argvs[1]?.includes("--disable-multithreading=true"));
    const configuredManifest = JSON.parse(await readFile(configured.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(configuredManifest.parameterSources.timeoutMs, "config");
    assert.equal(configuredManifest.parameterSources.session, "config");
    assert.deepEqual(configuredManifest.session, [{ kind: "multithreading", disabled: true }]);
    assert.equal(configuredManifest.effectiveParameters.timeoutMs, 30_000);

    observed.argvs.length = 0;
    const cleared = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      session: [],
    }, { signal: new AbortController().signal });
    assert.equal(cleared.success, true, JSON.stringify({ status: cleared.status, error: cleared.error, semantic: { status: cleared.semantic.status, summary: cleared.semantic.summary }, timing: cleared.timing }));
    assert.equal(observed.argvs[0]?.some((token) => token.startsWith("--disable-multithreading")), false);
    assert.equal(observed.argvs[1]?.some((token) => token.startsWith("--disable-multithreading")), false);
    const clearedManifest = JSON.parse(await readFile(cleared.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(clearedManifest.parameterSources.session, "call");
    assert.deepEqual(clearedManifest.session, []);
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a validated junction destination inventories its canonical root and keeps the display destination", async () => {
  const value = await fixture();
  const physical = path.join(value.root, "physical output");
  const alias = path.join(value.root, "junction output");
  await mkdir(physical, { recursive: true });
  await symlink(physical, alias, "junction");
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "ok", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
      output: alias,
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true, JSON.stringify({ error: result.error, semantic: result.semantic }));
    const data = result.semantic.data;
    assert.ok(data !== null && "outputPath" in data);
    assert.equal(path.normalize(result.paths.effectiveDestination!), path.normalize(alias));
    assert.equal(path.normalize(data.outputPath), path.normalize(alias));
    assert.equal(observed.argvs[1]?.at(-1), `--output=${path.normalize(alias)}`);
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.entries.length, extractionFixtureMembers.length + extractionFixtureDirectories.length + 1, "no duplicate enumeration through the alias");
    const physicalPrefix = `${path.normalize(physical).toLowerCase()}${path.sep}`;
    for (const entry of inventory.entries as AnyRecord[]) {
      assert.ok(path.normalize(entry.path).toLowerCase().startsWith(physicalPrefix), entry.path);
    }
    const memberRelative = extractionFixtureMembers[1]!.relative.split("/");
    const memberEntry = (inventory.entries as AnyRecord[]).find(
      (entry) => path.normalize(entry.path) === path.normalize(path.join(physical, ...memberRelative)),
    );
    assert.equal(memberEntry?.sha256, extractionFixtureMembers[1]!.sha256);
    const log = (inventory.entries as AnyRecord[]).find(
      (entry) => path.normalize(entry.path) === path.normalize(path.join(physical, "gdre_export.log")),
    );
    assert.equal(log?.role, "administrative-log");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("omitted output stays beside the physical input through a workspace junction", async () => {
  const value = await fixture();
  const physicalWorkspace = path.join(value.root, "physical workspace");
  const aliasWorkspace = path.join(value.root, "workspace junction");
  await mkdir(physicalWorkspace, { recursive: true });
  await symlink(physicalWorkspace, aliasWorkspace, "junction");
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(value.root, { preflight: "ok", extraction: "ok" }, observed);
  try {
    const result = await execution.execute("extract", {
      workspace: aliasWorkspace,
      inputs: [{ kind: "path", path: value.input }],
    }, { signal: new AbortController().signal });
    assert.equal(result.success, true, JSON.stringify({ error: result.error, semantic: result.semantic }));
    const data = result.semantic.data;
    assert.ok(data !== null && "outputPath" in data);
    const expectedSibling = path.join(
      path.dirname(value.input),
      `authored 空间-extracted-${path.basename(result.paths.operation!)}`,
    );
    assert.equal(path.normalize(result.paths.effectiveDestination!), path.normalize(expectedSibling));
    assert.equal(path.normalize(data.outputPath), path.normalize(expectedSibling));
    assert.notEqual(result.paths.effectiveDestination, result.paths.output);
    const inventory = JSON.parse(await readFile(result.paths.artifactInventory!, "utf8")) as Record<string, any>;
    assert.equal(inventory.entries.length, extractionFixtureMembers.length + extractionFixtureDirectories.length + 1);
    const realPrefix = `${expectedSibling.toLowerCase()}${path.sep}`;
    for (const entry of inventory.entries as AnyRecord[]) {
      assert.ok(path.normalize(entry.path).toLowerCase().startsWith(realPrefix), entry.path);
    }
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a natural preflight exit after the execution budget expires is timed out without extraction", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const execution = openExecution(
    value.root,
    { preflight: "ok", extraction: "ok", preflightDelay: true },
    observed,
    { defaults: { extract: { timeoutMs: 60 } } },
  );
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(observed.argvs.length, 1, "no extraction may launch after budget expiry");
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(result.process.pid, null);
    assert.equal(result.cleanup.state, "not_needed");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.preflight.process.exitCode, 0);
    assert.equal(manifest.preflight.process.signal, null);
    assert.equal(manifest.error.code, "execution_timeout");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("request cancellation after a natural preflight exit is classified as cancelled, not semantic_unknown", async () => {
  const value = await fixture();
  const observed = { argvs: [] as string[][] };
  const control = new AbortController();
  const execution = openExecution(value.root, {
    preflight: "ok",
    extraction: "ok",
    abortAfterPreflight: () => control.abort(),
  }, observed);
  try {
    const result = await execution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: control.signal });
    assert.equal(observed.argvs.length, 1, "no extraction may launch after cancellation");
    assert.equal(result.success, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(result.process.pid, null);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as Record<string, any>;
    assert.equal(manifest.preflight.process.exitCode, 0);
    assert.equal(manifest.error.code, "cancelled");
  } finally {
    await execution.close("shutdown");
    await rm(value.root, { recursive: true, force: true });
  }
});

test("stopped preflight does not reread missing logs or hide the termination outcome", async () => {
  const timeoutCase = await fixture();
  const timeoutExecution = openExecution(timeoutCase.root, {
    preflight: "timeout",
    extraction: "ok",
    missingPreflightEvidence: true,
  }, { argvs: [] });
  try {
    const result = await timeoutExecution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(result.persistence.state, "complete");
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, "timeout");
  } finally {
    await timeoutExecution.close("shutdown");
    await rm(timeoutCase.root, { recursive: true, force: true });
  }

  const cleanupCase = await fixture();
  const cleanupExecution = openExecution(cleanupCase.root, {
    preflight: "unconfirmed-cleanup",
    extraction: "ok",
    missingPreflightEvidence: true,
  }, { argvs: [] });
  try {
    const result = await cleanupExecution.execute("extract", {
      inputs: [{ kind: "path", path: "fixtures/authored 空间.pck" }],
    }, { signal: new AbortController().signal });
    assert.equal(result.error?.code, "cleanup_failed");
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.persistence.state, "complete");
  } finally {
    await cleanupExecution.close("shutdown");
    await rm(cleanupCase.root, { recursive: true, force: true });
  }
});
