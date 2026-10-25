import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeIndependentPck } from "./support/extraction-fixtures.js";

// Public MCP/stdio concurrency and isolation coverage. It runs the production
// server with the real registered tools and schemas, and substitutes only the
// runtime process through the existing ProcessRunner seam
// (test/support/fault-server.ts). The controlled runtime records each launch,
// writes one unique marker per stream after native ownership is confirmed, and
// then blocks until this test releases it. Overlap and isolation are therefore
// observed through files and retained evidence instead of timing assumptions.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const faultServerPath = path.join(repositoryRoot, "dist", "test", "support", "fault-server.js");
const callOptions = { timeout: 120_000, maxTotalTimeout: 120_000 };
const callTimeoutMs = 60_000;
// The first launch is observable well within this bound; it only separates
// "the other call never reached the runtime" from a slow start.
const markerWaitMs = 15_000;
const settleWaitMs = 30_000;

type AnyRecord = Record<string, any>;

interface RuntimeLaunch {
  readonly pid: number;
  /** The ownership helper that created this root; controlled fixture identity. */
  readonly parentPid: number;
  /** The child's actual working directory, recorded by the runtime itself. */
  readonly cwd: string;
  /** The original GDRE arguments captured through the runner seam. */
  readonly argv: readonly string[];
  readonly env: Record<string, string | null>;
}

interface OwnedLaunch {
  readonly pid: number;
}

interface Started {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly controlDir: string;
  readonly root: string;
  readonly diagnostics: () => string;
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const environment = (values: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  ...values,
});

async function makeFakeRuntime(root: string): Promise<string> {
  const directory = path.join(root, "runtime");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "gdre_tools.exe"), "fake executable", "utf8"),
    writeFile(path.join(directory, "gdre_tools.pck"), "fake pck", "utf8"),
    writeFile(path.join(directory, "GodotMonoDecompNativeAOT.dll"), "fake dll", "utf8"),
  ]);
  return directory;
}

async function startClient(): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-concurrency-stdio-"));
  const workspace = path.join(root, "workspace");
  const controlDir = path.join(root, "control");
  await mkdir(workspace, { recursive: true });
  await mkdir(controlDir, { recursive: true });
  const runtimeDirectory = await makeFakeRuntime(root);
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(configFile, JSON.stringify({
    workspaceRoot: workspace,
    runtimeDirectory,
    targetVersion: "2.8.0-beta.2",
    timeouts: { maxMs: 3_600_000 },
    defaults: {},
    settings: {},
  }), "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [faultServerPath],
    cwd: root,
    env: environment({
      GDRE_MCP_CONFIG: configFile,
      GDRE_MCP_TEST_PROCESS_MODE: "controlled",
      GDRE_MCP_TEST_CONTROL_DIR: controlDir,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-02-concurrency-stdio", version: "0.1.0" });
  const diagnosticChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => diagnosticChunks.push(chunk.toString()));
  try {
    await client.connect(transport);
  } catch (error) {
    // A failed startup must not leak the fixture process or its temp root.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { client, transport, workspace, controlDir, root, diagnostics: () => diagnosticChunks.join("") };
}

async function closeClient(started: Started): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const readRecords = async <T>(controlDir: string, pattern: RegExp): Promise<T[]> => {
  const names = (await readdir(controlDir)).filter((name) => pattern.test(name)).sort();
  const records: T[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(await readFile(path.join(controlDir, name), "utf8")) as T);
    } catch {
      // A record that is still being written is observed by the next poll.
    }
  }
  return records;
};

const waitForRecords = async <T>(controlDir: string, pattern: RegExp, expected: number, deadlineMs: number): Promise<T[]> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const records = await readRecords<T>(controlDir, pattern);
    if (records.length >= expected || Date.now() >= deadline) return records;
    await sleep(25);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessGone = async (pid: number, description: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(25);
  }
  throw new Error(`${description} (pid ${String(pid)}) is still alive`);
};

const waitForLaunches = (controlDir: string, expected: number, deadlineMs: number): Promise<RuntimeLaunch[]> =>
  waitForRecords<RuntimeLaunch>(controlDir, /^started-[0-9]+\.json$/u, expected, deadlineMs);

const waitForOwned = (controlDir: string, expected: number, deadlineMs: number): Promise<OwnedLaunch[]> =>
  waitForRecords<OwnedLaunch>(controlDir, /^owned-[0-9]+\.json$/u, expected, deadlineMs);

const releaseRuntimes = async (controlDir: string): Promise<void> => {
  await writeFile(path.join(controlDir, "release"), "released\n", "utf8");
};

const released = async (controlDir: string): Promise<boolean> => (await readdir(controlDir)).includes("release");

const readManifest = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const waitForManifest = async (file: string, predicate: (manifest: AnyRecord) => boolean, deadlineMs: number): Promise<AnyRecord> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const manifest = await readManifest(file);
      if (predicate(manifest) || Date.now() >= deadline) return manifest;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(25);
  }
};

const readStream = async (operation: string, kind: "stdout" | "stderr"): Promise<string> => {
  try {
    return await readFile(path.join(operation, `${kind}.bin`), "utf8");
  } catch {
    return "";
  }
};

const streamMarker = (kind: "STDOUT" | "STDERR", pid: number): string => `GDRE_CONTROLLED_${kind}_${pid}`;

const isInside = (root: string, child: string): boolean => {
  const relative = path.relative(root, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const launchFor = (launches: readonly RuntimeLaunch[], input: string): RuntimeLaunch | undefined =>
  launches.find((launch) => launch.argv.includes(`--list-files=${input}`));

const profileRootOf = (launch: RuntimeLaunch): string => {
  const appData = launch.env.APPDATA;
  assert.ok(typeof appData === "string", "the controlled runtime recorded its profile APPDATA root");
  return path.dirname(appData);
};

// Diagnostics only: the observed operation lifecycle states are reported when a
// call does not reach the runtime, and are never asserted on, so no queue,
// mutex, or module layout is frozen by this test.
const operationStates = async (workspace: string): Promise<Array<{ readonly id: string; readonly state: unknown }>> => {
  const root = path.join(workspace, ".gdre", "operations");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const states: Array<{ readonly id: string; readonly state: unknown }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(root, entry.name, "manifest.json"), "utf8")) as AnyRecord;
      states.push({ id: entry.name, state: manifest.state });
    } catch {
      states.push({ id: entry.name, state: null });
    }
  }
  return states;
};

const settle = async (pending: readonly Promise<unknown>[], deadlineMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const authorInput = async (file: string, name: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeIndependentPck(file, [
    { relative: "project.godot", bytes: Buffer.from(`config_version=5\n; ${name}\n`, "utf8") },
    { relative: "main.gd", bytes: Buffer.from(`extends Node\n# ${name}\n`, "utf8") },
  ]);
};

const startCall = (
  started: Started,
  pending: Promise<AnyRecord>[],
  options: { readonly workspace?: string; readonly path: string; readonly disabled?: boolean; readonly signal?: AbortSignal },
): Promise<AnyRecord> => {
  const request = started.client
    .callTool({
      name: "gdre_list_files",
      arguments: {
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        inputs: [{ kind: "path", path: options.path }],
        ...(options.disabled === undefined ? {} : { session: [{ kind: "multithreading", disabled: options.disabled }] }),
        timeoutMs: callTimeoutMs,
      },
    }, options.signal === undefined ? callOptions : { ...callOptions, signal: options.signal })
    .then((wire) => (wire as AnyRecord).structuredContent as AnyRecord);
  void request.catch(() => undefined);
  pending.push(request);
  return request;
};

test("two repeated same-workspace calls both reach the runtime before either is released", { timeout: 180_000 }, async () => {
  const started = await startClient();
  const pending: Promise<AnyRecord>[] = [];
  try {
    const input = path.join(started.workspace, "fixtures", "shared.pck");
    await authorInput(input, "concurrency tracer");

    startCall(started, pending, { path: "fixtures/shared.pck" });
    startCall(started, pending, { path: "fixtures/shared.pck" });

    const launches = await waitForLaunches(started.controlDir, 2, markerWaitMs);
    assert.equal(
      launches.length,
      2,
      "expected both repeated same-workspace calls to reach the runtime before either was released; observed "
        + `${String(launches.length)} launch(es) ${JSON.stringify(launches.map((launch) => ({ pid: launch.pid, cwd: launch.cwd })))}, `
        + `operation records ${JSON.stringify(await operationStates(started.workspace))}; server stderr: ${started.diagnostics()}`,
    );
    assert.equal(new Set(launches.map((launch) => launch.pid)).size, launches.length, "each call owns its own runtime process");
    assert.equal(
      new Set(launches.map((launch) => path.normalize(launch.cwd))).size,
      launches.length,
      "each call owns its own operation directory",
    );
    for (const launch of launches) {
      assert.ok(isInside(started.workspace, launch.cwd), `runtime cwd is outside the workspace: ${launch.cwd}`);
      assert.equal(launch.argv.includes(`--list-files=${input}`), true, JSON.stringify(launch.argv));
    }

    await releaseRuntimes(started.controlDir);
    const results = await Promise.all(pending);
    assert.equal(results.length, 2);
    const launchByPid = new Map(launches.map((launch) => [launch.pid, launch]));
    for (const result of results) {
      assert.equal(result.runtime.health, "ready", JSON.stringify(result.runtime.warnings));
      assert.ok(typeof result.process.pid === "number");
      // The controlled runtime performs no GDRE work: it always ends with code 3
      // after release, so a natural controlled exit is distinguishable from a
      // process that cleanup had to terminate.
      assert.equal(result.process.exitCode, 3, JSON.stringify({ error: result.error, process: result.process }));
      assert.equal(result.success, false);

      const launch = launchByPid.get(result.process.pid);
      assert.ok(launch, `result pid ${String(result.process.pid)} matches an observed launch`);
      assert.equal(path.normalize(result.paths.operation), path.normalize(launch.cwd), "result owns its launch cwd");
      assert.equal(path.normalize(result.paths.manifest), path.normalize(path.join(launch.cwd, "manifest.json")));
      const manifest = await readManifest(result.paths.manifest);
      assert.equal(manifest.operationId, result.operationId);
      assert.deepEqual(manifest.invocation.argv, [...launch.argv]);
      assert.equal(path.normalize(manifest.invocation.cwd), path.normalize(launch.cwd));
      assert.equal(path.normalize(manifest.invocation.environmentProfile.root), path.normalize(profileRootOf(launch)));

      const stdout = await readStream(launch.cwd, "stdout");
      const stderr = await readStream(launch.cwd, "stderr");
      assert.equal(stdout.includes(streamMarker("STDOUT", launch.pid)), true, "own stdout marker is retained");
      assert.equal(stderr.includes(streamMarker("STDERR", launch.pid)), true, "own stderr marker is retained");
      for (const sibling of launches) {
        if (sibling.pid === launch.pid) continue;
        assert.equal(stdout.includes(streamMarker("STDOUT", sibling.pid)), false, "stdout excludes the sibling marker");
        assert.equal(stderr.includes(streamMarker("STDERR", sibling.pid)), false, "stderr excludes the sibling marker");
      }
    }
    assert.notEqual(results[0]!.operationId, results[1]!.operationId);
    assert.notEqual(path.normalize(results[0]!.paths.operation), path.normalize(results[1]!.paths.operation));
  } finally {
    await releaseRuntimes(started.controlDir).catch(() => undefined);
    await settle(pending, settleWaitMs);
    await closeClient(started);
  }
});

test("distinct-workspace calls overlap through their launch markers", { timeout: 180_000 }, async () => {
  const started = await startClient();
  const pending: Promise<AnyRecord>[] = [];
  try {
    const workspaceA = started.workspace;
    const workspaceB = path.join(started.root, "workspace b");
    const inputA = path.join(workspaceA, "fixtures", "alpha.pck");
    const inputB = path.join(workspaceB, "fixtures", "beta.pck");
    await authorInput(inputA, "workspace alpha");
    await authorInput(inputB, "workspace beta");

    startCall(started, pending, { workspace: workspaceA, path: "fixtures/alpha.pck" });
    startCall(started, pending, { workspace: workspaceB, path: "fixtures/beta.pck" });

    const launches = await waitForLaunches(started.controlDir, 2, markerWaitMs);
    assert.equal(
      launches.length,
      2,
      "expected both distinct-workspace calls to reach the runtime before either was released; observed "
        + `${String(launches.length)} launch(es) ${JSON.stringify(launches.map((launch) => ({ pid: launch.pid, cwd: launch.cwd })))}, `
        + `operation records ${JSON.stringify(await operationStates(workspaceA))}; server stderr: ${started.diagnostics()}`,
    );
    const inA = launches.filter((launch) => isInside(workspaceA, launch.cwd));
    const inB = launches.filter((launch) => isInside(workspaceB, launch.cwd));
    assert.equal(inA.length, 1, JSON.stringify(launches.map((launch) => launch.cwd)));
    assert.equal(inB.length, 1, JSON.stringify(launches.map((launch) => launch.cwd)));
    const launchA = inA[0]!;
    const launchB = inB[0]!;
    assert.notEqual(launchA.pid, launchB.pid);
    assert.notEqual(path.normalize(launchA.cwd), path.normalize(launchB.cwd));
    assert.equal(launchA.argv.includes(`--list-files=${inputA}`), true, JSON.stringify(launchA.argv));
    assert.equal(launchA.argv.includes(`--list-files=${inputB}`), false, JSON.stringify(launchA.argv));
    assert.equal(launchB.argv.includes(`--list-files=${inputB}`), true, JSON.stringify(launchB.argv));
    assert.equal(launchB.argv.includes(`--list-files=${inputA}`), false, JSON.stringify(launchB.argv));

    await releaseRuntimes(started.controlDir);
    const results = await Promise.all(pending);
    for (const result of results) {
      assert.equal(result.runtime.health, "ready", JSON.stringify(result.runtime.warnings));
      assert.equal(result.process.exitCode, 3, JSON.stringify({ error: result.error, process: result.process }));
      assert.equal(result.success, false);
    }
    const pairedLaunches = results.map((result) => {
      const launch = launches.find((candidate) => candidate.pid === result.process.pid);
      assert.ok(launch, `result pid ${String(result.process.pid)} matches an observed launch`);
      return launch;
    });
    const operations = results.map((result) => path.normalize(result.paths.operation)).sort();
    assert.deepEqual(operations, [path.normalize(launchA.cwd), path.normalize(launchB.cwd)].sort());
    for (const launch of pairedLaunches) {
      const stdout = await readStream(launch.cwd, "stdout");
      assert.equal(stdout.includes(streamMarker("STDOUT", launch.pid)), true);
      const sibling = launches.find((candidate) => candidate.pid !== launch.pid);
      assert.ok(sibling !== undefined);
      assert.equal(stdout.includes(streamMarker("STDOUT", sibling.pid)), false, "stdout excludes the other workspace's marker");
    }
  } finally {
    await releaseRuntimes(started.controlDir).catch(() => undefined);
    await settle(pending, settleWaitMs);
    await closeClient(started);
  }
});

test("same-workspace calls keep their own sessions, records, profiles, and streams across a cancellation", { timeout: 180_000 }, async () => {
  const started = await startClient();
  const pending: Promise<AnyRecord>[] = [];
  const controller = new AbortController();
  try {
    const inputA = path.join(started.workspace, "fixtures", "alpha.pck");
    const inputB = path.join(started.workspace, "fixtures", "beta.pck");
    await authorInput(inputA, "session alpha");
    await authorInput(inputB, "session beta");

    const cancelledCall = startCall(started, pending, { path: "fixtures/alpha.pck", disabled: true, signal: controller.signal });
    const survivorCall = startCall(started, pending, { path: "fixtures/beta.pck", disabled: false });

    const launches = await waitForLaunches(started.controlDir, 2, markerWaitMs);
    const owned = await waitForOwned(started.controlDir, 2, markerWaitMs);
    assert.equal(launches.length, 2, JSON.stringify(launches.map((launch) => ({ pid: launch.pid, cwd: launch.cwd }))));
    assert.equal(owned.length, 2, JSON.stringify(launches.map((launch) => ({ pid: launch.pid, cwd: launch.cwd }))));
    const launchA = launchFor(launches, inputA);
    const launchB = launchFor(launches, inputB);
    assert.ok(launchA !== undefined, JSON.stringify(launches));
    assert.ok(launchB !== undefined, JSON.stringify(launches));
    assert.notEqual(launchA.pid, launchB.pid);
    assert.notEqual(path.normalize(launchA.cwd), path.normalize(launchB.cwd), "each call owns its operation directory");
    assert.ok(isInside(started.workspace, launchA.cwd) && isInside(started.workspace, launchB.cwd));
    assert.deepEqual(new Set(owned.map((value) => value.pid)), new Set([launchA.pid, launchB.pid]));
    assert.equal(launchA.argv.includes("--disable-multithreading=true"), true, JSON.stringify(launchA.argv));
    assert.equal(launchA.argv.includes("--disable-multithreading=false"), false, JSON.stringify(launchA.argv));
    assert.equal(launchB.argv.includes("--disable-multithreading=false"), true, JSON.stringify(launchB.argv));
    assert.equal(launchB.argv.includes("--disable-multithreading=true"), false, JSON.stringify(launchB.argv));

    // Both calls are established and unreleased; now cancel exactly one.
    controller.abort();
    await cancelledCall.catch(() => undefined);
    const cancelledManifest = await waitForManifest(
      path.join(launchA.cwd, "manifest.json"),
      (manifest) => manifest.state === "cancelled",
      markerWaitMs,
    );
    assert.equal(cancelledManifest.state, "cancelled", JSON.stringify(cancelledManifest).slice(0, 2_000));
    assert.equal(cancelledManifest.error?.code, "cancelled", JSON.stringify(cancelledManifest.error));
    assert.equal(cancelledManifest.cleanup?.state, "confirmed", JSON.stringify(cancelledManifest.cleanup));
    assert.equal(cancelledManifest.process?.pid, launchA.pid);
    assert.equal(path.normalize(cancelledManifest.paths.operation), path.normalize(launchA.cwd));

    // Actual killed-side effect: the cancelled operation's root and the helper
    // that owned it are gone, not merely marked cancelled in its manifest.
    await waitForProcessGone(launchA.pid, "cancelled operation root");
    await waitForProcessGone(launchA.parentPid, "cancelled operation ownership helper");

    // The survivor is still owned and unreleased, so a natural exit still lies ahead.
    assert.equal(await released(started.controlDir), false, "the survivor was never released before cancellation settled");
    assert.doesNotThrow(() => process.kill(launchB.pid, 0), "cancelling one call leaves the other process alive");

    await releaseRuntimes(started.controlDir);
    const survivor = await survivorCall;
    assert.equal(survivor.runtime.health, "ready", JSON.stringify(survivor.runtime.warnings));
    assert.equal(survivor.process.pid, launchB.pid);
    assert.equal(survivor.process.exitCode, 3, JSON.stringify({ error: survivor.error, process: survivor.process }));
    assert.equal(survivor.success, false);
    assert.equal(survivor.status, "failed");
    const survivorManifest = await readManifest(survivor.paths.manifest);
    assert.equal(survivorManifest.state, survivor.status);
    assert.equal(survivorManifest.operationId, survivor.operationId);
    assert.equal(path.normalize(survivor.paths.operation), path.normalize(launchB.cwd));

    assert.notEqual(cancelledManifest.operationId, survivor.operationId);
    assert.notEqual(path.normalize(cancelledManifest.paths.manifest), path.normalize(survivor.paths.manifest));

    // Requested and effective parameters belong to their own calls.
    assert.deepEqual(cancelledManifest.requestedParameters.inputs, [{ kind: "path", path: "fixtures/alpha.pck" }]);
    assert.deepEqual(survivorManifest.requestedParameters.inputs, [{ kind: "path", path: "fixtures/beta.pck" }]);
    assert.deepEqual(cancelledManifest.session, [{ kind: "multithreading", disabled: true }]);
    assert.deepEqual(survivorManifest.session, [{ kind: "multithreading", disabled: false }]);
    assert.deepEqual(cancelledManifest.effectiveParameters.session, [{ kind: "multithreading", disabled: true }]);
    assert.deepEqual(survivorManifest.effectiveParameters.session, [{ kind: "multithreading", disabled: false }]);
    assert.deepEqual(cancelledManifest.invocation.argv, [...launchA.argv]);
    assert.deepEqual(survivorManifest.invocation.argv, [...launchB.argv]);
    assert.equal(cancelledManifest.invocation.argv.includes(`--list-files=${inputB}`), false);
    assert.equal(survivorManifest.invocation.argv.includes(`--list-files=${inputA}`), false);

    // Operation-local profile roots and retained streams stay separated.
    assert.equal(path.normalize(cancelledManifest.invocation.environmentProfile.root), path.normalize(profileRootOf(launchA)));
    assert.equal(path.normalize(survivorManifest.invocation.environmentProfile.root), path.normalize(profileRootOf(launchB)));
    assert.notEqual(profileRootOf(launchA), profileRootOf(launchB));
    const cancelledStdout = await readStream(launchA.cwd, "stdout");
    const cancelledStderr = await readStream(launchA.cwd, "stderr");
    const survivorStdout = await readStream(launchB.cwd, "stdout");
    const survivorStderr = await readStream(launchB.cwd, "stderr");
    assert.equal(survivorStdout.includes(streamMarker("STDOUT", launchB.pid)), true);
    assert.equal(survivorStderr.includes(streamMarker("STDERR", launchB.pid)), true);
    for (const stream of [cancelledStdout, cancelledStderr]) {
      assert.equal(stream.includes(streamMarker("STDOUT", launchB.pid)), false, "cancelled streams exclude the sibling marker");
      assert.equal(stream.includes(streamMarker("STDERR", launchB.pid)), false, "cancelled streams exclude the sibling marker");
    }
    for (const stream of [survivorStdout, survivorStderr]) {
      assert.equal(stream.includes(streamMarker("STDOUT", launchA.pid)), false, "survivor streams exclude the cancelled marker");
      assert.equal(stream.includes(streamMarker("STDERR", launchA.pid)), false, "survivor streams exclude the cancelled marker");
    }
  } finally {
    await releaseRuntimes(started.controlDir).catch(() => undefined);
    await settle(pending, settleWaitMs);
    await closeClient(started);
  }
});
