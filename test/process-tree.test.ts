import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NativeOwnershipFactory,
  statusCompletion,
  type OwnershipHandle,
} from "../src/process-tree.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativeHelperPath = path.join(repositoryRoot, "native", "gdre-job-object.ps1");

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
};

const readJsonFile = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const waitForJsonFile = async <T>(file: string, description: string): Promise<T> => {
  let value: T | null = null;
  await waitFor(async () => {
    value = await readJsonFile<T>(file);
    return value !== null;
  }, description);
  assert.ok(value !== null);
  return value;
};

const readStatus = async (statusPath: string): Promise<Record<string, unknown> | null> =>
  readJsonFile<Record<string, unknown>>(statusPath);

const waitForKnownPids = async (statusPath: string, pids: readonly number[]): Promise<number[]> => {
  let known: number[] = [];
  await waitFor(async () => {
    const status = await readStatus(statusPath);
    known = Array.isArray(status?.knownPids)
      ? status.knownPids.filter((pid): pid is number => typeof pid === "number")
      : [];
    return pids.every((pid) => known.includes(pid));
  }, `Job membership to include ${pids.join(", ")}`);
  return known;
};

const cleanupStatus = (cleanup: Record<string, unknown>): Record<string, unknown> => ({
  launch: { started: true, rootPid: 123 },
  attach: { success: true },
  knownPids: [123, 456],
  cleanup,
});

test("empty Job membership never overrides failed or contradictory native cleanup", () => {
  for (const cleanup of [
    { state: "failed", confirmed: false, activeJobPids: [], error: "An owned process remains alive outside the Job." },
    { state: "failed", confirmed: true, activeJobPids: [] },
    { state: "confirmed", confirmed: false, activeJobPids: [] },
    { state: "confirmed", confirmed: true, activeJobPids: [456] },
    { state: "confirmed", confirmed: true, activeJobPids: [], error: "Verification failed." },
    { state: "pending", confirmed: false, activeJobPids: [] },
    { state: "confirmed", confirmed: true },
  ]) {
    const completion = statusCompletion(cleanupStatus(cleanup), 1, null);
    assert.equal(completion.cleanupConfirmed, false, JSON.stringify(cleanup));
    assert.equal(completion.noDescendantsConfirmed, false, JSON.stringify(cleanup));
  }
  assert.equal(statusCompletion(null, null, null).noDescendantsConfirmed, false);
  // Missing status is an unknown launch outcome, not proof of no launch.
  assert.equal(statusCompletion(null, null, null).launchStarted, null);
  assert.equal(statusCompletion({ state: "failed", failure: "helper vanished" }, 1, null).launchStarted, null);
  for (const started of [undefined, null, "false", 0]) {
    assert.equal(statusCompletion({ state: "failed", launch: { started } }, 1, null).launchStarted, null);
  }
  // A terminal status with an explicit not-started launch record proves absence.
  assert.equal(statusCompletion({
    state: "failed",
    launch: { started: false },
    cleanup: { state: "not-started", confirmed: false, activeJobPids: null },
  }, 1, null).launchStarted, false);
});

test("consistent native confirmation remains authoritative", () => {
  const completion = statusCompletion({
    launch: { started: true, rootPid: 123 },
    attach: { success: true },
    root: { pid: 123, exitObserved: true, exitCode: 7 },
    stop: { requested: false },
    knownPids: [123],
    cleanup: {
      state: "confirmed",
      confirmed: true,
      activeJobPids: [],
      error: null,
    },
  }, 0, null);
  assert.equal(completion.cleanupConfirmed, true);
  assert.equal(completion.noDescendantsConfirmed, true);
  assert.equal(completion.launchStarted, true);
  assert.equal(completion.rootPid, 123);
  assert.equal(completion.rootExitObserved, true);
  assert.equal(completion.rootExitCode, 7);
  assert.equal(completion.stopRequested, false);
  assert.deepEqual(completion.activePids, []);
});

interface FixtureScripts {
  readonly rootPath: string;
  readonly childPath: string;
  readonly pidsPath: string;
  readonly exitPath: string;
}

/**
 * Root waits for an exit trigger, then exits naturally. Before that it spawns a
 * child that spawns a grandchild; both descendants keep running inside the Job.
 */
const writeNaturalTreeScripts = async (directory: string): Promise<FixtureScripts> => {
  const rootPath = path.join(directory, "root.cjs");
  const childPath = path.join(directory, "child.cjs");
  const pidsPath = path.join(directory, "pids.json");
  const exitPath = path.join(directory, "exit");
  await fs.writeFile(childPath, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const pidsFile = process.argv[2];",
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });',
    "fs.writeFileSync(pidsFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  await fs.writeFile(rootPath, [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const childScript = process.argv[2];",
    "const pidsFile = process.argv[3];",
    "const exitFile = process.argv[4];",
    'spawn(process.execPath, [childScript, pidsFile], { stdio: "ignore", windowsHide: true });',
    'const timer = setInterval(() => { if (fs.existsSync(exitFile)) { clearInterval(timer); process.exit(0); } }, 20);',
  ].join("\n"), "utf8");
  return { rootPath, childPath, pidsPath, exitPath };
};

const launchTree = async (
  directory: string,
  scripts: FixtureScripts,
): Promise<OwnershipHandle> => {
  const factory = new NativeOwnershipFactory({ helperScriptPath: nativeHelperPath, helperReadyTimeoutMs: 45_000 });
  return factory.launch({
    executable: process.execPath,
    argv: [scripts.rootPath, scripts.childPath, scripts.pidsPath, scripts.exitPath],
    cwd: directory,
    env: { ...process.env },
  }, path.join(directory, "ownership.json"));
};

test("a native creation failure reports no launched root and no cleanup claim", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-launch-failure-"));
  const statusPath = path.join(directory, "ownership.json");
  let handle: OwnershipHandle | undefined;

  try {
    const factory = new NativeOwnershipFactory({ helperScriptPath: nativeHelperPath, helperReadyTimeoutMs: 45_000 });
    handle = await factory.launch({
      executable: path.join(directory, "missing-executable.exe"),
      argv: ["--never-runs"],
      cwd: directory,
      env: { ...process.env },
    }, statusPath);

    const ready = await handle.ready;
    assert.equal(ready.success, false);
    assert.equal(ready.rootPid, null);
    assert.match(ready.error ?? "", /CreateProcessW/u);
    const completion = await handle.waitForCompletion();
    assert.equal(completion.launchStarted, false);
    assert.equal(completion.rootPid, null);
    assert.equal(completion.cleanupConfirmed, false);
    assert.equal(completion.status?.state, "failed");
    const cleanup = completion.status?.cleanup as Record<string, unknown> | undefined;
    assert.equal(cleanup?.state, "not-started");
  } finally {
    if (handle !== undefined) await handle.terminate("shutdown").catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("creation-time Job ownership cleans real descendants and never adopts an unrelated older process", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-job-ownership-"));
  const statusPath = path.join(directory, "ownership.json");
  const started: ChildProcess[] = [];
  let handle: OwnershipHandle | undefined;

  try {
    const scripts = await writeNaturalTreeScripts(directory);
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
      windowsHide: true,
    });
    started.push(sentinel);
    const sentinelPid = sentinel.pid;
    assert.ok(sentinelPid !== undefined);
    await waitFor(() => isAlive(sentinelPid), "older sentinel process");

    handle = await launchTree(directory, scripts);
    const ready = await handle.ready;
    assert.equal(ready.success, true, ready.error ?? "native owned launch failed");
    assert.equal(typeof ready.rootPid, "number");
    assert.equal(typeof ready.rootStartedAtUtc, "string");

    const spawned = await waitForJsonFile<{ child: number; grandchild: number }>(scripts.pidsPath, "the root to report its descendants");
    const known = await waitForKnownPids(statusPath, [ready.rootPid!, spawned.child, spawned.grandchild]);
    assert.equal(known.includes(sentinelPid), false, `unrelated sentinel must not be adopted: ${JSON.stringify(known)}`);

    // Natural root exit; the remaining descendants are still Job members.
    await fs.writeFile(scripts.exitPath, "exit\n", "utf8");
    const completion = await handle.waitForCompletion();
    assert.equal(completion.launchStarted, true);
    assert.equal(completion.rootExitObserved, true);
    assert.equal(completion.rootExitCode, 0);
    assert.equal(completion.cleanupConfirmed, true, completion.error ?? "owned cleanup was not confirmed");
    assert.equal(isAlive(sentinelPid), true, "the unrelated sentinel must survive owned-Job cleanup");
    await waitFor(() => !isAlive(spawned.child), "real child termination");
    await waitFor(() => !isAlive(spawned.grandchild), "real grandchild termination");
  } finally {
    if (handle !== undefined) await handle.terminate("shutdown").catch(() => undefined);
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await waitFor(
      () => started.every((child) => child.exitCode !== null || child.signalCode !== null),
      "held fixture processes to settle",
    ).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a fast natural root exit does not become an ownership failure and still cleans descendants", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-fast-exit-"));
  const statusPath = path.join(directory, "ownership.json");
  const childPath = path.join(directory, "child.cjs");
  const rootPath = path.join(directory, "root.cjs");
  const pidsPath = path.join(directory, "child.json");
  let handle: OwnershipHandle | undefined;

  try {
    await fs.writeFile(childPath, [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.argv[2], JSON.stringify({ child: process.pid }));',
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    await fs.writeFile(rootPath, [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const childScript = process.argv[2];",
      "const pidsFile = process.argv[3];",
      'spawn(process.execPath, [childScript, pidsFile], { stdio: "ignore", windowsHide: true });',
      // Wait until the child is observable, then exit naturally while the child
      // is still running inside the Job.
      "const timer = setInterval(() => { if (fs.existsSync(pidsFile)) { clearInterval(timer); process.exit(0); } }, 5);",
    ].join("\n"), "utf8");

    const factory = new NativeOwnershipFactory({ helperScriptPath: nativeHelperPath, helperReadyTimeoutMs: 45_000 });
    handle = await factory.launch({
      executable: process.execPath,
      argv: [rootPath, childPath, pidsPath],
      cwd: directory,
      env: { ...process.env },
    }, statusPath);

    const ready = await handle.ready;
    assert.equal(ready.success, true, ready.error ?? "a fast root exit must not fail the owned launch");
    const spawned = await waitForJsonFile<{ child: number }>(pidsPath, "the fast-exiting root to report its child");

    const completion = await handle.waitForCompletion();
    assert.equal(completion.rootExitObserved, true);
    assert.equal(completion.rootExitCode, 0);
    assert.equal(completion.cleanupConfirmed, true, completion.error ?? "fast-exit cleanup was not confirmed");
    await waitFor(() => !isAlive(spawned.child), "fast-exit child termination");
  } finally {
    if (handle !== undefined) await handle.terminate("shutdown").catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("forced helper death closes the Job and kills owned descendants without a status claim", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-helper-death-"));
  const statusPath = path.join(directory, "ownership.json");
  const rootPath = path.join(directory, "root.cjs");
  const pidsPath = path.join(directory, "tree.json");
  let handle: OwnershipHandle | undefined;

  try {
    // The controlled root kills its actual parent (the helper) after its tree
    // exists. Kernel kill-on-job-close must terminate the whole owned tree.
    await fs.writeFile(rootPath, [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const pidsFile = process.argv[2];",
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });',
      "fs.writeFileSync(pidsFile, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));",
      "setTimeout(() => { try { process.kill(process.ppid); } catch {} }, 400);",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");

    const factory = new NativeOwnershipFactory({ helperScriptPath: nativeHelperPath, helperReadyTimeoutMs: 45_000 });
    handle = await factory.launch({
      executable: process.execPath,
      argv: [rootPath, pidsPath],
      cwd: directory,
      env: { ...process.env },
    }, statusPath);
    const ready = await handle.ready;
    assert.equal(ready.success, true, ready.error ?? "owned launch failed");
    const tree = await waitForJsonFile<{ root: number; grandchild: number }>(pidsPath, "the controlled root to report its tree");

    const completion = await handle.waitForCompletion();
    // The helper's final status cannot claim confirmed cleanup: it was killed.
    assert.equal(completion.cleanupConfirmed, false);
    assert.match(completion.error ?? "", /status evidence|helper/iu);
    await waitFor(() => !isAlive(tree.grandchild), "kill-on-job-close grandchild termination");
    await waitFor(() => !isAlive(tree.root), "kill-on-job-close root termination");
  } finally {
    if (handle !== undefined) await handle.terminate("shutdown").catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const powerShellPath = (): string =>
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

const spawnHelper = (statusPath: string): ChildProcess => spawn(powerShellPath(), [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  nativeHelperPath,
  "-StatusPath",
  statusPath,
], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

const encodedRequest = (request: unknown): string =>
  `${Buffer.from(JSON.stringify(request), "utf8").toString("base64")}\n`;

const environmentPairs = (): [string, string][] =>
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined);

test("a stop buffered before creation never leaves an unowned late launch", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-prelaunch-stop-"));
  const statusPath = path.join(directory, "ownership.json");
  const rootPath = path.join(directory, "root.cjs");
  const markerPath = path.join(directory, "root.json");
  let helper: ChildProcess | undefined;

  try {
    await fs.writeFile(rootPath, [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));',
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");

    helper = spawnHelper(statusPath);
    // The launch request and the stop byte are both buffered before the helper
    // reaches creation. The helper must either skip the launch or terminate the
    // already-owned root; it must never leave a running unowned process.
    helper.stdin!.write(encodedRequest({
      executable: process.execPath,
      argv: [rootPath, markerPath],
      cwd: directory,
      env: environmentPairs(),
    }));
    helper.stdin!.write("stop\n");

    await waitFor(() => helper!.exitCode !== null || helper!.signalCode !== null, "helper exit after buffered stop");
    const status = await readStatus(statusPath);
    const launch = typeof status?.launch === "object" && status.launch !== null
      ? status.launch as Record<string, unknown>
      : null;
    if (launch?.started === true) {
      const rootPid = typeof launch.rootPid === "number" && launch.rootPid > 0 ? launch.rootPid : null;
      assert.ok(rootPid !== null, "a started launch must report the native root PID");
      assert.equal((status?.stop as Record<string, unknown> | undefined)?.requested, true);
      assert.equal((status?.cleanup as Record<string, unknown> | undefined)?.confirmed, true);
      // The already-owned root may be killed before its JS writes the marker.
      // Liveness observation uses the native PID; termination is Job-owned.
      await waitFor(() => !isAlive(rootPid!), "buffered-stop root termination");
      const marker = await readJsonFile<{ pid: number }>(markerPath);
      if (marker !== null) assert.equal(isAlive(marker.pid), false);
    } else {
      assert.equal(status?.state, "cancelled");
      const marker = await readJsonFile<{ pid: number }>(markerPath);
      if (marker !== null) await waitFor(() => !isAlive(marker.pid), "cancelled root termination");
    }
  } finally {
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) helper.kill();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("closing the helper control pipe (EOF) stops owned work and confirms cleanup", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-eof-"));
  const statusPath = path.join(directory, "ownership.json");
  const rootPath = path.join(directory, "root.cjs");
  const pidsPath = path.join(directory, "tree.json");
  const powerShell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  let helper: ChildProcess | undefined;

  try {
    await fs.writeFile(rootPath, [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const pidsFile = process.argv[2];",
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });',
      "fs.writeFileSync(pidsFile, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");

    // Hold the helper process directly so the test owns its control pipe and can
    // deliver EOF without killing Node or the helper.
    helper = spawn(powerShell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      nativeHelperPath,
      "-StatusPath",
      statusPath,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const request = {
      executable: process.execPath,
      argv: [rootPath, pidsPath],
      cwd: directory,
      env: Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    };
    helper.stdin!.write(`${Buffer.from(JSON.stringify(request), "utf8").toString("base64")}\n`);

    await waitFor(async () => {
      const status = await readStatus(statusPath);
      return status?.launch !== undefined && (status.launch as Record<string, unknown>).started === true;
    }, "the helper to create the owned root");
    const tree = await waitForJsonFile<{ root: number; grandchild: number }>(pidsPath, "the controlled root to report its tree");

    helper.stdin!.end();
    await waitFor(async () => {
      const status = await readStatus(statusPath);
      const cleanup = typeof status?.cleanup === "object" && status.cleanup !== null
        ? status.cleanup as Record<string, unknown>
        : null;
      return cleanup?.confirmed === true;
    }, "EOF-driven cleanup confirmation");
    const status = await readStatus(statusPath);
    assert.equal((status?.stop as Record<string, unknown> | undefined)?.reason, "eof");
    await waitFor(() => !isAlive(tree.grandchild), "EOF-driven grandchild termination");
    await waitFor(() => !isAlive(tree.root), "EOF-driven root termination");
    await waitFor(() => helper!.exitCode !== null || helper!.signalCode !== null, "helper exit after EOF");
  } finally {
    if (helper !== undefined && helper.exitCode === null && helper.signalCode === null) helper.kill();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("forced Node death stops the owned tree and leaves no detached helper", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const temporaryRoot = path.join(tmpdir(), "Claude");
  await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "gdre-node-death-"));
  const statusPath = path.join(directory, "ownership.json");
  const rootPath = path.join(directory, "root.cjs");
  const parentPath = path.join(directory, "parent.mjs");
  const pidsPath = path.join(directory, "tree.json");
  const readyPath = path.join(directory, "parent-ready.json");
  const processTreeModule = new URL("../src/process-tree.js", import.meta.url).href;
  let parent: ChildProcess | undefined;

  try {
    await fs.writeFile(rootPath, [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const pidsFile = process.argv[2];",
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });',
      "fs.writeFileSync(pidsFile, JSON.stringify({ root: process.pid, grandchild: grandchild.pid }));",
      "setInterval(() => {}, 1000);",
    ].join("\n"), "utf8");
    await fs.writeFile(parentPath, [
      `import { NativeOwnershipFactory } from ${JSON.stringify(processTreeModule)};`,
      'import { writeFileSync } from "node:fs";',
      `const factory = new NativeOwnershipFactory({ helperScriptPath: ${JSON.stringify(nativeHelperPath)}, helperReadyTimeoutMs: 45000 });`,
      "const handle = await factory.launch({",
      "  executable: process.execPath,",
      `  argv: [${JSON.stringify(rootPath)}, ${JSON.stringify(pidsPath)}],`,
      `  cwd: ${JSON.stringify(directory)},`,
      "  env: { ...process.env },",
      `}, ${JSON.stringify(statusPath)});`,
      "const ready = await handle.ready;",
      `writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ rootPid: ready.rootPid, helperPid: ready.helperPid, error: ready.error }));`,
      "await handle.waitForCompletion();",
    ].join("\n"), "utf8");

    parent = spawn(process.execPath, [parentPath], { stdio: "ignore", windowsHide: true, env: { ...process.env } });
    await waitFor(async () => (await readJsonFile<Record<string, unknown>>(readyPath)) !== null, "parent fixture readiness");
    const readyRecord = await readJsonFile<{ rootPid: number | null; helperPid: number | null; error: string | null }>(readyPath);
    assert.ok(readyRecord !== null && readyRecord.error === null, "parent fixture did not launch an owned root");
    const tree = await waitForJsonFile<{ root: number; grandchild: number }>(pidsPath, "the controlled root to report its tree");
    assert.ok(parent.pid !== undefined);

    // Force-kill the Node parent. The helper must not remain as a detached
    // supervisor, and the launched work must stop. When the host terminates the
    // whole tree the final status may be absent; only actual effects are claimed.
    parent.kill();
    await waitFor(() => !isAlive(tree.grandchild), "forced-Node-death grandchild termination");
    await waitFor(() => !isAlive(tree.root), "forced-Node-death root termination");
    if (readyRecord.helperPid !== null) {
      await waitFor(() => !isAlive(readyRecord.helperPid!), "helper exit after Node death");
    }
  } finally {
    if (parent !== undefined && parent.exitCode === null && parent.signalCode === null) parent.kill();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
