import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeIndependentPck } from "./support/extraction-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const faultServerPath = path.join(repositoryRoot, "dist", "test", "support", "fault-server.js");

type Mode = "natural" | "long" | "delayed" | "extract-partial";

interface FaultOptions {
  readonly mode?: Mode;
  readonly storageFault?: string;
  readonly ownership?: "unconfirmed";
  readonly ownershipAttachDelayMs?: number;
  readonly maxMs?: number;
  readonly defaultsTimeoutMs?: number;
  readonly workspaceFromEnvironment?: boolean;
  readonly prepareWorkspace?: (workspace: string) => Promise<void>;
}

interface StartedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
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

async function startFaultClient(options: FaultOptions = {}): Promise<StartedClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-fault-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await options.prepareWorkspace?.(workspace);
  const runtimeDirectory = await makeFakeRuntime(root);
  const controlDirectory = path.join(root, "control");
  await mkdir(controlDirectory);
  const maxMs = options.maxMs ?? 3_600_000;
  const configPath = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...(options.workspaceFromEnvironment === true ? {} : { workspaceRoot: workspace }),
      runtimeDirectory,
      targetVersion: "2.8.0-beta.2",
      timeouts: {
        maxMs,
      },
      defaults: options.defaultsTimeoutMs === undefined ? {} : { version: { timeoutMs: options.defaultsTimeoutMs } },
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [faultServerPath],
    cwd: root,
    env: environment({
      GDRE_MCP_CONFIG: configPath,
      GDRE_MCP_TEST_PROCESS_MODE: options.mode ?? "natural",
      GDRE_MCP_TEST_CONTROL_DIR: controlDirectory,
      ...(options.storageFault === undefined ? {} : { GDRE_MCP_TEST_STORAGE_FAULT: options.storageFault }),
      ...(options.ownership === undefined ? {} : { GDRE_MCP_TEST_OWNERSHIP: options.ownership }),
      ...(options.ownershipAttachDelayMs === undefined ? {} : { GDRE_MCP_TEST_ATTACH_DELAY_MS: String(options.ownershipAttachDelayMs) }),
      ...(options.workspaceFromEnvironment === true ? { GDRE_MCP_WORKSPACE: workspace } : {}),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-04-lifecycle", version: "0.1.0" });
  const diagnosticChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => diagnosticChunks.push(chunk.toString()));
  await client.connect(transport);
  return { client, transport, workspace, root, diagnostics: () => diagnosticChunks.join("") };
}

async function closeClient(started: StartedClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const operationsRoot = (workspace: string): string => path.join(workspace, ".gdre", "operations");

async function readManifests(workspace: string): Promise<Record<string, any>[]> {
  const root = operationsRoot(workspace);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: Record<string, any>[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(JSON.parse(await readFile(path.join(root, entry.name, "manifest.json"), "utf8")) as Record<string, any>);
    } catch {
      // A snapshot may be mid-replacement; the poll retries.
    }
  }
  return manifests;
}

async function waitForManifest(
  workspace: string,
  predicate: (manifest: Record<string, any>) => boolean,
  timeoutMs = 20_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await readManifests(workspace)).find(predicate);
    if (match !== undefined) return match;
    await sleep(50);
  }
  throw new Error(`timed out waiting for a matching operation manifest in ${workspace}`);
}

async function waitForOwnedProcess(workspace: string, timeoutMs = 20_000): Promise<void> {
  const root = operationsRoot(workspace);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const status = JSON.parse(await readFile(path.join(root, entry.name, "ownership.json"), "utf8")) as Record<string, any>;
        if (status.state === "monitoring" && status.attach?.success === true) return;
      } catch {
        // The helper may still be replacing the status file.
      }
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for native ownership in ${workspace}`);
}

// Independent finite client watchdog for the controlled fixture workload.
const callOptions = { timeout: 640_000, maxTotalTimeout: 640_000 };

test("an omitted timeout runs without recording a builtin execution limit", async () => {
  const started = await startFaultClient();
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: {} }, callOptions);
    const result = call.structuredContent as any;
    assert.equal(result.success, true, JSON.stringify(result.error));
    const manifest = JSON.parse(await readFile(result.paths.manifest, "utf8"));
    assert.equal("timeoutMs" in manifest.effectiveParameters, false);
    assert.equal("timeoutMs" in manifest.parameterSources, false);
  } finally {
    await closeClient(started);
  }
});

test("storage failure is reported as a failure, never as process success", async () => {
  const started = await startFaultClient({ storageFault: "failStreams" });
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 30_000 } }, callOptions);
    const result = call.structuredContent as any;
    assert.equal(call.isError, true);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    assert.equal(result.stdout.complete, false);
    const manifest = await waitForManifest(started.workspace, (value) => value.state === "failed");
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.success, false);
    assert.equal(manifest.persistence.state, "incomplete");
  } finally {
    await closeClient(started);
  }
});

test("fault version fixture waits for confirmed ownership before exiting", { timeout: 45_000 }, async () => {
  // A valid attach may take longer than the fixture's former five-second cutoff.
  const started = await startFaultClient({ ownershipAttachDelayMs: 6_000 });
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: {} }, callOptions);
    const result = call.structuredContent as any;
    assert.equal(result.success, true, JSON.stringify({ error: result.error, runtime: result.runtime, cleanup: result.cleanup }));
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.runtime.health, "ready");
  } finally {
    await closeClient(started);
  }
});

test("execution timeout terminates and confirms native cleanup", async () => {
  const started = await startFaultClient({ mode: "long" });
  try {
    // Keep a finite deadline, but allow owned startup under full-suite load.
    const pending = started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 15_000 } }, callOptions);
    void pending.catch(() => undefined);
    await waitForOwnedProcess(started.workspace, 30_000);
    const call = await pending;
    const result = call.structuredContent as any;
    assert.equal(call.isError, true);
    assert.equal(result.status, "timed_out", JSON.stringify({ error: result.error, process: result.process, cleanup: result.cleanup }));
    assert.equal(result.error.code, "execution_timeout");
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, "timeout");
    assert.equal(result.persistence.state, "complete");
    assert.equal(typeof result.timing.processMs, "number");
    assert.equal(result.timing.processExitedAt !== null, true);
  } finally {
    await closeClient(started);
  }
});

test("configured default timeout and environment workspace provenance are recorded", async () => {
  const started = await startFaultClient({
    mode: "long",
    defaultsTimeoutMs: 400,
    workspaceFromEnvironment: true,
  });
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: {} }, callOptions);
    const result = call.structuredContent as any;
    assert.equal(result.status, "timed_out", JSON.stringify({ error: result.error, process: result.process, cleanup: result.cleanup }));
    const manifest = await waitForManifest(started.workspace, (value) => value.state === "timed_out");
    assert.equal(manifest.parameterSources.workspace, "environment");
    assert.equal(manifest.parameterSources.timeoutMs, "config");
  } finally {
    await closeClient(started);
  }
});

test("call cancellation persists cancelled status with confirmed cleanup", async () => {
  const started = await startFaultClient({ mode: "long" });
  const controller = new AbortController();
  const pending = started.client
    .callTool({ name: "gdre_version", arguments: {} }, { ...callOptions, signal: controller.signal })
    .catch(() => undefined);
  try {
    // Cancel only once the runtime is observably owned by the operation, so
    // the assertion covers a genuinely running process rather than timing.
    await waitForOwnedProcess(started.workspace);
    controller.abort();
    await pending;
    const manifest = await waitForManifest(started.workspace, (value) => value.state === "cancelled");
    assert.equal(manifest.status, "cancelled");
    assert.equal(manifest.success, false);
    assert.equal(manifest.error.code, "cancelled");
    assert.equal(manifest.cleanup.state, "confirmed");
    assert.equal(manifest.persistence.state, "complete");
  } finally {
    controller.abort();
    await pending;
    await closeClient(started);
  }
});

test("cancelled extraction keeps readable partial files without a post-stop inventory or later effects", { timeout: 90_000 }, async () => {
  const started = await startFaultClient({ mode: "extract-partial" });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    const input = path.join(started.workspace, "partial.pck");
    await writeIndependentPck(input, [{ relative: "partial.txt", bytes: Buffer.from("retained partial") }]);
    pending = started.client.callTool({ name: "gdre_extract", arguments: {
      inputs: [{ kind: "path", path: input }], output: "partial-output",
    } }, { ...callOptions, signal: controller.signal }).catch(() => undefined);
    const partial = path.join(started.workspace, "partial-output", "partial.txt");
    const deadline = Date.now() + 30_000;
    while (await readFile(partial, "utf8").catch(() => null) !== "retained partial") {
      if (Date.now() > deadline) throw new Error(`partial extraction never started: ${started.diagnostics()}`);
      await sleep(25);
    }
    const [launchFile] = (await readdir(path.join(started.root, "control"))).filter((name) => name.startsWith("started-"));
    assert.ok(launchFile !== undefined);
    const launch = JSON.parse(await readFile(path.join(started.root, "control", launchFile), "utf8"));
    controller.abort();
    await pending;
    const manifest = await waitForManifest(started.workspace, (value) => value.state === "cancelled");
    assert.equal(manifest.error.code, "cancelled");
    assert.equal(manifest.cleanup.state, "confirmed");
    assert.equal(manifest.semantic.status, "not_evaluated");
    assert.equal(manifest.artifacts.complete, false);
    assert.equal(manifest.artifacts.count, 0, "zero enumerated files is not a claim that the destination is empty");
    const inventory = JSON.parse(await readFile(manifest.paths.artifactInventory, "utf8"));
    assert.equal(inventory.complete, false);
    assert.deepEqual(inventory.entries, []);
    assert.equal(await readFile(partial, "utf8"), "retained partial");
    assert.match(await readFile(manifest.stdout.textPath, "utf8"), /GDRE_CONTROLLED_STDOUT/u);
    assert.throws(() => process.kill(launch.pid, 0), "the cancelled extraction root is gone");
    assert.throws(() => process.kill(launch.parentPid, 0), "its ownership helper is gone");
    const observe = async (): Promise<string[]> => {
      const entries: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(file);
          else {
            const info = await stat(file);
            entries.push(`${file}|${info.size}|${info.mtimeMs}`);
          }
        }
      };
      await walk(manifest.paths.operation);
      await walk(path.dirname(partial));
      return entries.sort();
    };
    const stable = await observe();
    await sleep(300);
    assert.deepEqual(await observe(), stable, "no output, log, inventory or record recovery runs after completion");
  } finally {
    controller.abort();
    await pending;
    await closeClient(started);
  }
});

test("disconnect interrupts a running operation and confirms cleanup", async () => {
  const started = await startFaultClient({ mode: "long" });
  try {
    void started.client.callTool({ name: "gdre_version", arguments: {} }, callOptions).catch(() => undefined);
    await waitForOwnedProcess(started.workspace);
    await started.transport.close();
    const manifest = await waitForManifest(started.workspace, (value) => value.state === "interrupted");
    assert.equal(manifest.status, "interrupted");
    assert.equal(manifest.error.code, "disconnected");
    assert.equal(manifest.cleanup.state, "confirmed");
    assert.equal(manifest.persistence.state, "complete");
  } finally {
    await started.client.close().catch(() => undefined);
    await started.transport.close().catch(() => undefined);
    await rm(started.root, { recursive: true, force: true });
  }
});

test("independent same-workspace calls overlap instead of waiting for each other", async () => {
  const started = await startFaultClient({ mode: "long" });
  try {
    const firstController = new AbortController();
    const first = started.client
      .callTool({ name: "gdre_version", arguments: { timeoutMs: 30_000 } }, { ...callOptions, signal: firstController.signal })
      .catch(() => undefined);
    await waitForOwnedProcess(started.workspace);

    // The second call must reach its own running process while the first is
    // still held by the long-running runtime. Its budget is generous enough to
    // survive native ownership-helper startup under suite concurrency.
    const second = await started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 2_000 } }, callOptions);
    const result = second.structuredContent as any;
    assert.equal(second.isError, true);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error.code, "execution_timeout");
    assert.equal(typeof result.process.pid, "number");
    assert.equal(result.cleanup.state, "confirmed");

    const terminalRecords = await readManifests(started.workspace);
    assert.equal(terminalRecords.length, 1, "the held operation has not published a final record");
    await waitForOwnedProcess(started.workspace);

    firstController.abort();
    await first;
  } finally {
    await closeClient(started);
  }
});

test("only a final versioned record is published after owned work stops", async () => {
  const started = await startFaultClient({ mode: "long" });
  const controller = new AbortController();
  const pending = started.client
    .callTool({ name: "gdre_version", arguments: { timeoutMs: 30_000 } }, { ...callOptions, signal: controller.signal })
    .catch(() => undefined);
  try {
    await waitForOwnedProcess(started.workspace);
    assert.deepEqual(await readManifests(started.workspace), [], "running work has no fabricated final record");
    const [operation] = await readdir(operationsRoot(started.workspace));
    assert.ok(operation !== undefined);
    const inventory = JSON.parse(await readFile(path.join(operationsRoot(started.workspace), operation, "artifacts.json"), "utf8"));
    assert.equal(inventory.complete, false, "allocated inventory does not claim the running destination is empty");
    assert.deepEqual(inventory.entries, []);
    controller.abort();
    await pending;
    const terminal = await waitForManifest(started.workspace, (value) => value.state === "cancelled");
    assert.equal(terminal.schemaVersion, 1);
    assert.equal(terminal.recordVersion, 2);
    assert.equal(terminal.status, "cancelled");
    assert.equal(typeof terminal.timing.finishedAt, "string");
    assert.equal("events" in terminal, false);
    assert.ok(Array.isArray(terminal.invocation.argv));
    assert.equal(typeof terminal.invocation.environmentProfile.root, "string");
  } finally {
    controller.abort();
    await pending;
    await closeClient(started);
  }
});

test("old nonterminal and malformed records remain unchanged and do not block new calls", async () => {
  const oldRecord = JSON.stringify({ schemaVersion: 1, state: "running", status: null, success: null, events: [] });
  const oldFiles: { path: string; contents: string }[] = [];
  const started = await startFaultClient({
    prepareWorkspace: async (workspace) => {
      for (const contents of [oldRecord, "{not valid json"]) {
        const operation = path.join(operationsRoot(workspace), randomUUID().toLowerCase());
        await mkdir(operation, { recursive: true });
        const file = path.join(operation, "manifest.json");
        await writeFile(file, contents, "utf8");
        oldFiles.push({ path: file, contents });
      }
    },
  });
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 30_000 } }, callOptions);
    assert.equal((call.structuredContent as any).success, true, JSON.stringify(call.structuredContent));
    for (const file of oldFiles) assert.equal(await readFile(file.path, "utf8"), file.contents);
  } finally {
    await closeClient(started);
  }
});

test("unconfirmed cleanup blocks later launches and preserves cleanup_failed priority", async () => {
  const started = await startFaultClient({ mode: "long", ownership: "unconfirmed" });
  try {
    const first = await started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 400 } }, callOptions);
    const firstResult = first.structuredContent as any;
    assert.equal(first.isError, true);
    assert.equal(firstResult.status, "failed");
    assert.equal(firstResult.error.code, "cleanup_failed");
    assert.equal(firstResult.cleanup.state, "unconfirmed");
    assert.equal(firstResult.persistence.state, "complete");

    const second = await started.client.callTool({ name: "gdre_version", arguments: {} }, callOptions);
    const secondResult = second.structuredContent as any;
    assert.equal(second.isError, true);
    assert.equal(secondResult.status, "failed");
    assert.equal(secondResult.error.code, "cleanup_failed");
    assert.equal(secondResult.paths.operation, null);
    assert.equal(secondResult.persistence.state, "unavailable");
  } finally {
    await closeClient(started);
  }
});

test("a call-level timeout above the configured maximum is rejected before allocation", async () => {
  const started = await startFaultClient({ maxMs: 60_000 });
  try {
    const call = await started.client.callTool({ name: "gdre_version", arguments: { timeoutMs: 120_000 } }, callOptions);
    const result = call.structuredContent as any;
    assert.equal(call.isError, true);
    assert.equal(result.error.code, "validation_failed");
    const operations = await readdir(operationsRoot(started.workspace)).catch(() => [] as string[]);
    assert.deepEqual(operations, []);
  } finally {
    await closeClient(started);
  }
});

test("running progress reports phases without heartbeat notifications", async () => {
  const started = await startFaultClient({ mode: "delayed" });
  try {
    const notifications: { progress: number; message?: string }[] = [];
    const call = await started.client.callTool(
      { name: "gdre_version", arguments: {} },
      {
        ...callOptions,
        onprogress: (progress) => notifications.push({ progress: progress.progress, message: progress.message }),
      },
    );
    assert.equal(call.isError, false, `${JSON.stringify(call.structuredContent)}\n--- server diagnostics ---\n${started.diagnostics()}`);
    const running = notifications.filter((entry) => entry.message === "running");
    assert.equal(running.length, 1, JSON.stringify(notifications));
    assert.deepEqual(notifications.map((entry) => entry.message), ["preparing", "running", "finalizing"]);
    for (let index = 1; index < notifications.length; index += 1) {
      assert.ok(notifications[index]!.progress > notifications[index - 1]!.progress);
    }
  } finally {
    await closeClient(started);
  }
});
