import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory = path.join(repositoryRoot, "vendor", "GDRE_tools");

interface TestConfigOptions {
  readonly targetVersion?: string;
  readonly runtimeDirectory?: string;
  readonly ignoreEnvironmentRuntime?: boolean;
}

interface StartedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

const environment = (
  configPath: string,
  ignoreEnvironmentRuntime = false,
): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // The intentional-missing-runtime case must stay missing even when the outer
  // worktree suite exports GDRE_MCP_RUNTIME_DIR for its other tests.
  if (ignoreEnvironmentRuntime) delete inherited.GDRE_MCP_RUNTIME_DIR;
  return { ...inherited, GDRE_MCP_CONFIG: configPath };
};

async function startClient(options: TestConfigOptions = {}): Promise<StartedClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-stdio-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller-cwd");
  await mkdir(callerCwd, { recursive: true });
  const configPath = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory: options.runtimeDirectory ?? runtimeDirectory,
      targetVersion: options.targetVersion ?? "2.8.0-beta.2",
      timeouts: { maxMs: 3_600_000 },
      defaults: {},
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: environment(configPath, options.ignoreEnvironmentRuntime === true),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-04-acceptance", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
}

test("real stdio discovers and executes the version tracer bullet", async () => {
  const started = await startClient();
  try {
    const listed = await started.client.listTools();
    assert.equal(listed.tools.length, 6);
    const extraction = listed.tools.find((candidate) => candidate.name === "gdre_extract");
    assert.ok(extraction);
    assert.equal(extraction.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(extraction.inputSchema.properties ?? {}).sort(), [
      "exclude",
      "include",
      "inputs",
      "output",
      "selection",
      "session",
      "timeoutMs",
      "workspace",
    ]);
    const tool = listed.tools.find((candidate) => candidate.name === "gdre_version");
    assert.ok(tool);
    assert.equal(tool.name, "gdre_version");
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["timeoutMs", "workspace"]);

    const call = await started.client.callTool(
      { name: "gdre_version", arguments: {} },
      { timeout: 640_000, maxTotalTimeout: 640_000 },
    );
    const result = call.structuredContent as any;
    assert.equal(call.isError, false, JSON.stringify({ error: result?.error, process: result?.process, cleanup: result?.cleanup, runtime: result?.runtime }));
    assert.equal(result.success, true);
    assert.equal(result.status, "succeeded");
    assert.equal(result.commandId, "version");
    assert.equal(result.runtime.health, "ready");
    assert.equal(result.runtime.actualVersion, "2.8.0-beta.2");
    assert.equal(result.runtime.comparison, "match");
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.semantic.rule, "gdre-version-line-v1");
    assert.deepEqual(result.semantic.data, { version: "2.8.0-beta.2" });
    assert.equal(result.stdout.text, "Godot RE Tools v2.8.0-beta.2\r\n");
    assert.equal(result.stderr.text, "");
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, true);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.persistence.state, "complete");
    assert.deepEqual(JSON.parse((call.content[0] as { text: string }).text), result);

    const manifest = await readJson(result.paths.manifest);
    const artifacts = await readJson(result.paths.artifactInventory);
    assert.equal(manifest.state, "succeeded");
    assert.deepEqual(manifest.invocation.argv, ["--headless", "--gdre-version"]);
    assert.equal(manifest.invocation.cwd, result.paths.operation);
    assert.equal(manifest.invocation.environmentProfile.root, path.join(result.paths.operation, "profile"));
    assert.equal(manifest.requestedParameters && Object.keys(manifest.requestedParameters).length, 0);
    assert.equal(artifacts.complete, true);
    assert.deepEqual(artifacts.entries, []);
    assert.equal((await readFile(result.stdout.rawPath, "utf8")), "Godot RE Tools v2.8.0-beta.2\r\n");
    assert.equal((await readFile(result.stderr.rawPath, "utf8")), "");

    const second = await started.client.callTool(
      { name: "gdre_version", arguments: {} },
      { timeout: 640_000, maxTotalTimeout: 640_000 },
    );
    assert.equal((second.structuredContent as any).success, true);
    assert.notEqual((second.structuredContent as any).operationId, result.operationId);
  } finally {
    await closeClient(started);
  }
});

test("SDK rejects unknown version arguments before allocating an operation", async () => {
  const started = await startClient();
  try {
    const result = await started.client.callTool({ name: "gdre_version", arguments: { unexpected: true } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const operationsRoot = path.join(started.workspace, ".gdre", "operations");
    let operations: string[] = [];
    try {
      operations = await readdir(operationsRoot);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
    assert.deepEqual(operations, []);
  } finally {
    await closeClient(started);
  }
});

test("runtime mismatch warns without changing the discovered schema", async () => {
  const started = await startClient({ targetVersion: "2.8.0-beta.1" });
  try {
    const listed = await started.client.listTools();
    const result = await started.client.callTool(
      { name: "gdre_version", arguments: {} },
      { timeout: 640_000, maxTotalTimeout: 640_000 },
    );
    const structured = result.structuredContent as any;
    assert.equal(result.isError, false);
    assert.equal(structured.success, true);
    assert.equal(structured.runtime.comparison, "mismatch");
    assert.ok(structured.runtime.warnings.some((warning: string) => warning.includes("does not match target")));
    assert.equal(listed.tools[0]?.name, "gdre_version");
  } finally {
    await closeClient(started);
  }
});

test("missing runtime stays discoverable and returns a durable runtime failure", async () => {
  const started = await startClient({ runtimeDirectory: path.join(os.tmpdir(), `gdre-mcp-missing-runtime-${randomUUID()}`), ignoreEnvironmentRuntime: true });
  try {
    const listed = await started.client.listTools();
    assert.equal(listed.tools[0]?.name, "gdre_version");
    const call = await started.client.callTool({ name: "gdre_version", arguments: {} });
    const result = call.structuredContent as any;
    assert.equal(call.isError, true);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "runtime_unavailable");
    assert.equal(result.persistence.state, "complete");
    assert.equal(result.process.pid, null);
    assert.ok(result.runtime.warnings.some((warning: string) => warning.includes("missing")));
  } finally {
    await closeClient(started);
  }
});
