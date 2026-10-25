import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createExtractionFixture,
  extractionFixtureDirectories,
  extractionFixtureMembers,
} from "./support/extraction-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory = path.join(repositoryRoot, "vendor", "GDRE_tools");
// Budget queue (600 s), execution (600 s), and termination/finalization separately.
const clientRequestOptions = { timeout: 1_240_000, maxTotalTimeout: 1_240_000 };

type AnyRecord = Record<string, any>;

interface StartedExtractionClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  GDRE_MCP_CONFIG: configFile,
});

async function startClient(): Promise<StartedExtractionClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-extract-stdio-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller cwd");
  await mkdir(callerCwd, { recursive: true });
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory,
      targetVersion: "2.8.0-beta.2",
      timeouts: { maxMs: 3_600_000 },
      defaults: { extract: { timeoutMs: 600_000 } },
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: childEnvironment(configFile),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-21-extraction-stdio", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedExtractionClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const hashFile = async (file: string): Promise<string> =>
  createHash("sha256").update(await readFile(file)).digest("hex");

async function walk(root: string): Promise<{ readonly files: string[]; readonly directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await visit(root, "");
  return { files, directories };
}

const expectedSafetyControls: Record<string, boolean> = {
  "General/download_plugins": false,
  "General/execute_visual_shader_node_scripts": false,
  "General/delete_auto_converted_files": false,
  "General/force_single_threaded": false,
  "Recovery/clear_output_dir_except_git_before_full_recovery": false,
  "Recovery/git/create_git_repo": false,
  "Recovery/git/add_imports_to_git_repo": false,
  "CSharp/compile_after_decompile": false,
  "CSharp/verify_nuget_package_is_from_nuget_org": false,
  "CSharp/automatically_search_workshop_dependencies": false,
  "CSharp/copy_out_of_tree_references": false,
};

function parseGeneratedConfig(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const header = /^\[(.+)\]$/u.exec(line);
    if (header !== null && header[1] !== undefined) {
      section = header[1];
      continue;
    }
    const separator = line.indexOf("=");
    assert.ok(separator > 0, `generated config line is not key=value: ${line}`);
    parsed[`${section}/${line.slice(0, separator)}`] = line.slice(separator + 1);
  }
  return parsed;
}

const knownSystemDirectoryDiagnostic = [
  'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
  "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
] as const;

/**
 * The synthetic profile legitimately triggers the runtime's known system-dir
 * diagnostic. No other stderr content is accepted by this independent check.
 */
function assertOnlyKnownSystemDirectoryDiagnostics(raw: Buffer): void {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(raw)
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  assert.equal(lines.length % knownSystemDirectoryDiagnostic.length, 0);
  for (let index = 0; index < lines.length; index += knownSystemDirectoryDiagnostic.length) {
    assert.deepEqual(
      lines.slice(index, index + knownSystemDirectoryDiagnostic.length),
      [...knownSystemDirectoryDiagnostic],
    );
  }
}

test("real stdio extracts an independently authored PCK with complete verified evidence", async () => {
  const started = await startClient();
  try {
    const fixture = await createExtractionFixture(path.join(started.workspace, "fixtures"));
    const pckBytesBefore = await readFile(fixture.pck);

    const tools = (await started.client.listTools()).tools;
    const extractTool = tools.find((tool) => tool.name === "gdre_extract");
    assert.ok(extractTool, "gdre_extract must be discoverable");
    assert.deepEqual(extractTool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(extractTool.inputSchema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(extractTool.inputSchema.properties ?? {}).sort(),
      ["exclude", "include", "inputs", "output", "selection", "session", "timeoutMs", "workspace"],
    );

    const wire = await started.client.callTool({
      name: "gdre_extract",
      arguments: { inputs: [{ kind: "path", path: fixture.relativePck }] },
    }, clientRequestOptions) as AnyRecord;
    const result = wire.structuredContent as AnyRecord;
    assert.equal(wire.isError, false, JSON.stringify({
      error: result?.error,
      semantic: result?.semantic,
      process: result?.process,
      stdout: result?.stdout?.text,
      stderr: result?.stderr?.text,
    }));
    assert.equal(result.success, true);
    assert.equal(result.commandId, "extract");
    assert.equal(result.status, "succeeded");
    assert.equal(result.error, null);
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.process.signal, null);
    assert.equal(typeof result.process.pid, "number");

    const effective = result.paths.effectiveDestination as string;
    const owned = result.paths.output as string;
    const operation = result.paths.operation as string;
    const expectedSibling = path.join(
      fixture.root,
      `authored 空间-extracted-${path.basename(operation)}`,
    );
    assert.equal(effective, expectedSibling, "omitted output is a sibling product");
    assert.equal(owned, path.join(operation, "output"), "internal output stays operation-owned");
    assert.notEqual(effective, owned);
    assert.equal(result.paths.workspace, started.workspace);
    const operationOutput = await walk(owned).catch(() => ({ files: [], directories: [] }));
    assert.deepEqual(operationOutput, { files: [], directories: [] }, "no product is written into internal state");

    // Independently expected member bytes, exact destination, no extra members.
    const destination = await walk(effective);
    assert.deepEqual(
      [...destination.files].sort(),
      [...extractionFixtureMembers.map((member) => member.relative), "gdre_export.log"].sort(),
    );
    assert.deepEqual(
      [...destination.directories].sort(),
      [...extractionFixtureDirectories].sort(),
    );
    for (const member of extractionFixtureMembers) {
      const extracted = await readFile(path.join(effective, ...member.relative.split("/")));
      assert.deepEqual(extracted, member.bytes, `exact bytes for ${member.name}`);
      assert.equal(createHash("sha256").update(extracted).digest("hex"), member.sha256, member.name);
    }

    assert.equal(result.semantic.status, "succeeded");
    assert.equal(result.semantic.rule, "gdre-extract-v1");
    assert.equal(result.semantic.data.totalFiles, extractionFixtureMembers.length);
    assert.equal(result.semantic.data.extractedFiles, extractionFixtureMembers.length);
    assert.equal(result.semantic.data.outputPath, effective);
    assert.equal(result.semantic.data.checksum, "default");
    assert.ok(result.semantic.evidence.some((line: string) => line.includes("Verified 3 files")));
    assert.ok(result.semantic.evidence.some((line: string) => line.includes("Extracted 3 files")));

    // Complete inventory includes member files, expected directories, and the
    // administrative runtime log with a distinct role.
    assert.equal(result.artifacts.complete, true);
    assert.equal(result.artifacts.truncated, false);
    const expectedEntryCount = extractionFixtureMembers.length + extractionFixtureDirectories.length + 1;
    assert.equal(result.artifacts.count, expectedEntryCount);
    assert.equal(result.artifacts.items.length, expectedEntryCount);
    const artifactItems = result.artifacts.items as AnyRecord[];
    const byPath = new Map(artifactItems.map((entry) => [entry.path as string, entry]));
    for (const member of extractionFixtureMembers) {
      const entry = byPath.get(path.join(effective, ...member.relative.split("/")));
      assert.ok(entry, member.name);
      assert.equal(entry.role, "extracted");
      assert.equal(entry.bytes, member.size);
      assert.equal(entry.sha256, member.sha256);
    }
    const logEntry = byPath.get(path.join(effective, "gdre_export.log"));
    assert.ok(logEntry, "administrative runtime log is inventoried separately");
    assert.equal(logEntry.role, "administrative-log");
    assert.equal(typeof logEntry.bytes, "number");
    assert.equal(String(logEntry.sha256).length, 64);
    for (const directory of extractionFixtureDirectories) {
      const entry = byPath.get(path.join(effective, ...directory.split("/")));
      assert.ok(entry, directory);
      assert.equal(entry.role, "extracted");
    }

    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.schemaVersion, 1);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, artifactItems.length);
    assert.deepEqual(inventory.errors, []);
    const inventoryByPath = new Map(
      (inventory.entries as AnyRecord[]).map((entry) => [entry.path as string, entry]),
    );
    for (const member of extractionFixtureMembers) {
      const entry = inventoryByPath.get(path.join(effective, ...member.relative.split("/")));
      assert.equal(entry?.kind, "file");
      assert.equal(entry?.error, null);
    }
    assert.equal(inventoryByPath.get(path.join(effective, "gdre_export.log"))?.kind, "file");
    for (const directory of extractionFixtureDirectories) {
      const entry = inventoryByPath.get(path.join(effective, ...directory.split("/")));
      assert.equal(entry?.kind, "directory");
      assert.equal(entry?.error, null);
    }

    // Actual raw streams: complete and retained; product stdout is MCP-only.
    const rawStdout = await readFile(result.stdout.rawPath);
    const rawStderr = await readFile(result.stderr.rawPath);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stderr.complete, true);
    assert.equal(result.stderr.bytes, rawStderr.byteLength);
    assertOnlyKnownSystemDirectoryDiagnostics(rawStderr);
    assert.equal(result.stdout.bytes, rawStdout.byteLength);
    assert.equal(result.stdout.truncated, false);
    const stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(rawStdout);
    assert.ok(stdoutText.includes("Successfully loaded PCK!"));
    assert.ok(stdoutText.includes("Verified 3 files, no errors detected!"));
    assert.ok(stdoutText.includes("Extracted 3 files, no errors detected!"));
    assert.ok(stdoutText.includes("Extraction operation complete in"));

    // Manifest: exact argv, actual destination, preflight evidence, profile.
    const manifest = await readJson(result.paths.manifest);
    assert.equal(manifest.state, "succeeded");
    assert.equal(manifest.status, "succeeded");
    assert.equal(manifest.success, true);
    assert.deepEqual(manifest.invocation.argv, [
      "--headless",
      "--no-header",
      "--",
      `--extract=${fixture.pck}`,
      `--output=${effective}`,
    ]);
    assert.equal(manifest.invocation.cwd, operation);
    assert.equal(manifest.process.pid, result.process.pid);
    assert.equal(manifest.process.exitCode, 0);
    assert.equal(manifest.parameterSources.inputs, "call");
    assert.equal(manifest.parameterSources.output, "builtin");
    assert.equal(manifest.parameterSources.session, "builtin");
    assert.equal(manifest.parameterSources.timeoutMs, "config");
    assert.deepEqual(manifest.requestedParameters, { inputs: [{ kind: "path", path: fixture.relativePck }] });
    assert.equal(manifest.effectiveParameters.output, effective);
    assert.ok(manifest.effects.writes.includes(effective));
    assert.ok(manifest.effects.knownSideEffectRoots.includes(effective));
    assert.equal(manifest.paths.effectiveDestination, effective);
    assert.equal(manifest.paths.output, owned);

    // Actual generated safety configuration, read from the profile the runtime used.
    const profile = manifest.invocation.environmentProfile;
    assert.equal(profile.root, path.join(operation, "profile"));
    assert.ok(String(profile.userData).endsWith(path.join("Godot", "app_userdata", "Godot RE Tools")));
    assert.deepEqual(profile.controls, expectedSafetyControls);
    const generatedBytes = await readFile(profile.generatedConfigFile);
    assert.equal(profile.configSha256, createHash("sha256").update(generatedBytes).digest("hex"));
    const generatedConfig = parseGeneratedConfig(generatedBytes.toString("utf8"));
    assert.equal(Object.keys(expectedSafetyControls).length, 11);
    for (const [key, value] of Object.entries(expectedSafetyControls)) {
      assert.equal(generatedConfig[key], value ? "true" : "false", key);
    }
    // The runtime rewrites the live ConfigFile on exit. Its retained non-default
    // false controls corroborate that the generated values were consumed.
    const liveConfig = parseGeneratedConfig(await readFile(profile.configFile, "utf8"));
    for (const key of [
      "CSharp/compile_after_decompile",
      "CSharp/automatically_search_workshop_dependencies",
      "CSharp/copy_out_of_tree_references",
    ]) {
      assert.equal(liveConfig[key], "false", key);
    }

    // Internal retained preflight evidence is separate from the extraction result.
    const preflight = manifest.preflight as AnyRecord;
    assert.ok(preflight, "manifest references retained preflight evidence");
    assert.deepEqual(preflight.invocation.argv, [
      "--headless",
      "--no-header",
      "--",
      `--list-files=${fixture.pck}`,
    ]);
    assert.equal(preflight.invocation.cwd, operation);
    assert.equal(preflight.invocation.environmentProfile.root, profile.root);
    assert.equal(preflight.process.exitCode, 0);
    assert.equal(preflight.process.signal, null);
    assert.notEqual(preflight.process.pid, null);
    assert.equal(preflight.semantic.status, "succeeded");
    assert.equal(preflight.semantic.rule, "gdre-list-files-v1");
    const preflightStdout = await readFile(preflight.stdout.rawPath);
    assert.equal(preflight.stdout.bytes, preflightStdout.byteLength);
    assert.equal("sha256" in preflight.stdout, false);
    assert.equal(preflight.stdout.complete, true);
    const preflightText = new TextDecoder("utf-8", { fatal: true }).decode(preflightStdout);
    assert.ok(preflightText.includes("Total files: 3"));
    for (const member of extractionFixtureMembers) assert.ok(preflightText.includes(member.name), member.name);
    const preflightStderr = await readFile(preflight.stderr.rawPath);
    assert.equal(preflight.stderr.bytes, preflightStderr.byteLength);
    assert.equal("sha256" in preflight.stderr, false);
    assert.equal(preflight.stderr.complete, true);
    assertOnlyKnownSystemDirectoryDiagnostics(preflightStderr);

    assert.equal(preflight.expectedMembers.count, extractionFixtureMembers.length);
    const expectedMembers = await readJson(preflight.expectedMembers.path);
    assert.equal(expectedMembers.complete, true);
    assert.equal(expectedMembers.count, extractionFixtureMembers.length);
    assert.deepEqual(
      [...expectedMembers.members].sort(),
      [...extractionFixtureMembers.map((member) => member.name)].sort(),
    );
    assert.equal(preflight.expectedMembers.sha256, await hashFile(preflight.expectedMembers.path));

    // The authored package is input only and must not be mutated.
    assert.deepEqual(await readFile(fixture.pck), pckBytesBefore);
  } finally {
    await closeClient(started);
  }
});
