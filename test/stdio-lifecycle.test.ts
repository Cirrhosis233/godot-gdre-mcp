import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

// Public MCP/stdio lifecycle coverage. The server is the real fault entry point
// using the production stdio connection module; only the runtime executable is
// substituted (test/support/fault-server.ts). No test-only MCP tool is added.

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const faultServerPath = path.join(repositoryRoot, "dist", "test", "support", "fault-server.js");
const temporaryBase = path.join(os.tmpdir(), "Claude");

const MODERN_REVISION = "2026-07-28";
const LEGACY_REVISION = "2025-11-25";
const CLIENT_INFO = { name: "stdio-lifecycle", version: "0.1.0" };
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface JsonRpcMessage {
  readonly jsonrpc: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface PendingRequest {
  resolve(message: JsonRpcMessage): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class RawStdioServer {
  public readonly child: ChildProcess;
  public readonly notifications: JsonRpcMessage[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exited: Promise<void>;
  private buffer = "";
  private stderrText = "";

  public constructor(root: string, configFile: string, mode: string, controlDirectory: string) {
    this.child = spawn(process.execPath, [faultServerPath], {
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        GDRE_MCP_CONFIG: configFile,
        GDRE_MCP_TEST_PROCESS_MODE: mode,
        GDRE_MCP_TEST_CONTROL_DIR: controlDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
    this.child.once("exit", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`server exited before answering: ${this.stderrText}`));
      }
      this.pending.clear();
    });
  }

  public get diagnostics(): string {
    return this.stderrText;
  }

  public write(message: Record<string, unknown>): void {
    if (this.child.stdin === null || this.child.stdin.destroyed) throw new Error("server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  public request(id: number, method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage> {
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderrText}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return response;
  }

  public endStdin(): void {
    this.child.stdin?.end();
  }

  public isAlive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  public async waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async dispose(): Promise<void> {
    this.endStdin();
    if (!await this.waitForExit(5_000)) {
      try { this.child.kill(); } catch { /* the server may already be gone */ }
      await this.waitForExit(5_000);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        throw new Error(`unexpected non-JSON server stdout: ${line}; stderr: ${this.stderrText}`);
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } else {
        this.notifications.push(message);
      }
    }
  }
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly controlDirectory: string;
  readonly server: RawStdioServer;
}

const makeFakeRuntime = async (root: string): Promise<string> => {
  const directory = path.join(root, "runtime");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "gdre_tools.exe"), "fake executable", "utf8"),
    writeFile(path.join(directory, "gdre_tools.pck"), "fake pck", "utf8"),
    writeFile(path.join(directory, "GodotMonoDecompNativeAOT.dll"), "fake dll", "utf8"),
  ]);
  return directory;
};

const startFixture = async (mode: "natural" | "controlled"): Promise<Fixture> => {
  await mkdir(temporaryBase, { recursive: true });
  const root = await mkdtemp(path.join(temporaryBase, "gdre-mcp-stdio-lifecycle-"));
  const workspace = path.join(root, "workspace");
  const controlDirectory = path.join(root, "control");
  await mkdir(workspace, { recursive: true });
  await mkdir(controlDirectory, { recursive: true });
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
  return { root, workspace, controlDirectory, server: new RawStdioServer(root, configFile, mode, controlDirectory) };
};

const closeFixture = async (fixture: Fixture): Promise<void> => {
  await fixture.server.dispose();
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

const initializeLegacy = async (server: RawStdioServer, id: number): Promise<JsonRpcMessage> => {
  const response = await server.request(id, "initialize", {
    protocolVersion: LEGACY_REVISION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  server.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  return response;
};

interface ControlledLaunch {
  readonly pid: number;
  readonly parentPid: number;
  readonly cwd: string;
  readonly argv: readonly string[];
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
};

const waitForProcessGone = async (pid: number, description: string, timeoutMs = 15_000): Promise<void> => {
  try {
    await waitFor(() => !isAlive(pid), description, timeoutMs);
  } catch (error) {
    throw new Error(`${description} (pid ${String(pid)}) is still alive: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const readJsonFile = async <T>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, "utf8")) as T;

const controlFiles = async (directory: string, pattern: RegExp): Promise<string[]> =>
  (await readdir(directory)).filter((name) => pattern.test(name)).sort();

const waitForControlledLaunch = async (controlDirectory: string): Promise<ControlledLaunch> => {
  let launch: ControlledLaunch | undefined;
  await waitFor(async () => {
    const names = await controlFiles(controlDirectory, /^started-[0-9]+\.json$/u);
    if (names.length === 0) return false;
    launch = await readJsonFile<ControlledLaunch>(path.join(controlDirectory, names[0]!));
    return typeof launch.pid === "number" && typeof launch.parentPid === "number";
  }, "controlled runtime launch record");
  assert.ok(launch !== undefined);
  return launch;
};

const waitForOwnedMarker = async (controlDirectory: string, pid: number): Promise<void> => {
  await waitFor(async () => (await controlFiles(controlDirectory, new RegExp(`^owned-${String(pid)}\\.json$`, "u"))).length === 1, "controlled runtime ownership marker");
};

const operationsRoot = (workspace: string): string => path.join(workspace, ".gdre", "operations");

const readManifests = async (workspace: string): Promise<Record<string, any>[]> => {
  let entries;
  try {
    entries = await readdir(operationsRoot(workspace), { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: Record<string, any>[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(await readJsonFile<Record<string, any>>(path.join(operationsRoot(workspace), entry.name, "manifest.json")));
    } catch {
      // A manifest that is still being written is observed by the next poll.
    }
  }
  return manifests;
};

const waitForManifest = async (
  workspace: string,
  predicate: (manifest: Record<string, any>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, any>> => {
  let found: Record<string, any> | undefined;
  await waitFor(async () => {
    found = (await readManifests(workspace)).find(predicate);
    return found !== undefined;
  }, "matching operation manifest", timeoutMs);
  assert.ok(found !== undefined);
  return found;
};

const snapshotTree = async (root: string): Promise<string[]> => {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const value = await stat(full);
        entries.push(`${path.relative(root, full)}|${String(value.size)}|${String(value.mtimeMs)}`);
      }
    }
  };
  await walk(root);
  return entries.sort();
};

test("stdin EOF stops the launched process tree and the server exits without a kill", { timeout: 120_000 }, async () => {
  const fixture = await startFixture("controlled");
  let launch: ControlledLaunch | undefined;
  try {
    await initializeLegacy(fixture.server, 1);
    const call = fixture.server.request(2, "tools/call", {
      name: "gdre_version",
      arguments: { timeoutMs: 30_000 },
      _meta: { progressToken: "eof-progress" },
    });
    void call.catch(() => undefined);

    launch = await waitForControlledLaunch(fixture.controlDirectory);
    await waitForOwnedMarker(fixture.controlDirectory, launch.pid);
    const operation = launch.cwd;
    assert.deepEqual(await readManifests(fixture.workspace), [], "no final record exists while the root is held");
    await waitFor(
      () => fixture.server.notifications.some((message) => message.method === "notifications/progress" && message.params?.message === "running"),
      "running phase notification",
      10_000,
    );
    assert.equal(isAlive(launch.pid), true, "the controlled root is running before EOF");
    assert.equal(isAlive(launch.parentPid), true, "the ownership helper is running before EOF");

    fixture.server.endStdin();
    const exited = await fixture.server.waitForExit(30_000);
    assert.equal(exited, true, `server did not exit after stdin EOF; stderr: ${fixture.server.diagnostics}`);
    assert.equal(fixture.server.child.exitCode, 0, `server exit code after EOF; stderr: ${fixture.server.diagnostics}`);

    await waitForProcessGone(launch.pid, "launched root after stdin EOF");
    await waitForProcessGone(launch.parentPid, "ownership helper after stdin EOF");

    const terminal = await waitForManifest(fixture.workspace, (manifest) => ["interrupted", "cancelled", "failed"].includes(manifest.state));
    assert.equal(terminal.state, "interrupted", JSON.stringify(terminal).slice(0, 2_000));
    assert.equal(terminal.error?.code, "disconnected", JSON.stringify(terminal.error));
    assert.equal(terminal.cleanup?.state, "confirmed", JSON.stringify(terminal.cleanup));
    assert.equal(terminal.persistence?.state, "complete", JSON.stringify(terminal.persistence));

    const stable = await snapshotTree(operation);
    const notificationCount = fixture.server.notifications.length;
    await sleep(300);
    assert.deepEqual(await snapshotTree(operation), stable, "artifacts are not written after stdin EOF cleanup");
    assert.equal(fixture.server.notifications.length, notificationCount, "progress stops after stdin EOF");

    await call.catch(() => undefined);
  } finally {
    if (launch !== undefined) {
      await waitForProcessGone(launch.pid, "launched root during test teardown", 5_000).catch(() => undefined);
      await waitForProcessGone(launch.parentPid, "ownership helper during test teardown", 5_000).catch(() => undefined);
    }
    await closeFixture(fixture);
  }
});

test("abrupt server termination stops the launched process tree", { timeout: 120_000 }, async () => {
  const fixture = await startFixture("controlled");
  let launch: ControlledLaunch | undefined;
  try {
    await initializeLegacy(fixture.server, 1);
    const call = fixture.server.request(2, "tools/call", {
      name: "gdre_version",
      arguments: { timeoutMs: 30_000 },
    });
    void call.catch(() => undefined);

    launch = await waitForControlledLaunch(fixture.controlDirectory);
    await waitForOwnedMarker(fixture.controlDirectory, launch.pid);
    assert.deepEqual(await readManifests(fixture.workspace), [], "no final record exists before forced server loss");
    assert.equal(isAlive(launch.pid), true, "the controlled root is running before the abrupt kill");
    assert.equal(isAlive(launch.parentPid), true, "the ownership helper is running before the abrupt kill");

    fixture.server.child.kill();
    const exited = await fixture.server.waitForExit(10_000);
    assert.equal(exited, true, "the server process was terminated");
    await waitForProcessGone(launch.pid, "launched root after abrupt server termination", 20_000);
    await waitForProcessGone(launch.parentPid, "ownership helper after abrupt server termination", 20_000);

    // No final status is claimed for this scenario. If a terminal manifest was
    // persisted before the kill, it must not report success.
    const manifests = await readManifests(fixture.workspace);
    const manifest = manifests.find((value) => value.paths?.operation === launch?.cwd);
    assert.notEqual(manifest?.state, "succeeded", JSON.stringify(manifest ?? null).slice(0, 2_000));

    await call.catch(() => undefined);
  } finally {
    if (launch !== undefined) {
      await waitForProcessGone(launch.pid, "launched root during test teardown", 5_000).catch(() => undefined);
      await waitForProcessGone(launch.parentPid, "ownership helper during test teardown", 5_000).catch(() => undefined);
    }
    await closeFixture(fixture);
  }
});

test("modern probe disposal on the same wire keeps the shared execution usable", { timeout: 60_000 }, async () => {
  const fixture = await startFixture("natural");
  try {
    const discover = await fixture.server.request(1, "server/discover", {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
        [CLIENT_INFO_META_KEY]: CLIENT_INFO,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    });
    assert.equal(discover.error, undefined, JSON.stringify(discover.error) + fixture.server.diagnostics);

    await initializeLegacy(fixture.server, 2);
    const call = await fixture.server.request(3, "tools/call", {
      name: "gdre_version",
      arguments: { timeoutMs: 30_000 },
    });
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    assert.equal(call.result?.isError, false, JSON.stringify(call.result));
    assert.equal(call.result?.structuredContent?.success, true, JSON.stringify(call.result));
  } finally {
    await closeFixture(fixture);
  }
});
