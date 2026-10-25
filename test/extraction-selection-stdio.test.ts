import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeIndependentPck } from "./support/extraction-fixtures.js";
import { corruptFirstPckPayloadByte } from "./support/extraction-input-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory = path.join(repositoryRoot, "vendor", "GDRE_tools");
const clientRequestOptions = { timeout: 1_240_000, maxTotalTimeout: 1_240_000 };

type AnyRecord = Record<string, any>;

interface Started {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  GDRE_MCP_CONFIG: configFile,
});

async function startClient(): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-selection-stdio-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller cwd");
  await mkdir(callerCwd, { recursive: true });
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
    args: [serverPath],
    cwd: callerCwd,
    env: childEnvironment(configFile),
    stderr: "pipe",
  });
  const client = new Client({ name: "ticket-22-selection-stdio", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: Started): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const readJson = async (file: string): Promise<AnyRecord> => JSON.parse(await readFile(file, "utf8")) as AnyRecord;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  await visit(root, "");
  return found.sort();
}

const authorPck = async (workspace: string, name: string, members: ReadonlyArray<readonly [string, Buffer]>): Promise<string> => {
  const pck = path.join(workspace, "fixtures", `${name}.pck`);
  await mkdir(path.dirname(pck), { recursive: true });
  await writeIndependentPck(pck, members.map(([relative, bytes]) => ({ relative, bytes })));
  return pck;
};

const extract = async (started: Started, args: AnyRecord): Promise<AnyRecord> => {
  const wire = await started.client.callTool({ name: "gdre_extract", arguments: args }, clientRequestOptions) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
};

// ---- shared fixtures -------------------------------------------------------

const memberBytes = {
  "project.godot": Buffer.from("config_version=5\n[application]\nconfig/name=\"selection\"\n", "utf8"),
  "main.gd": Buffer.from("extends Node\n# selection probe\n", "utf8"),
  "data/nested.bin": Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
};
const memberNames = Object.keys(memberBytes).map((relative) => `res://${relative}`);

const selectionMembers: ReadonlyArray<readonly [string, Buffer]> = Object.entries(memberBytes) as ReadonlyArray<readonly [string, Buffer]>;

test("real stdio extracts only the selected include subset with truthful full-set checksum coverage", async () => {
  const started = await startClient();
  try {
    const pck = await authorPck(started.workspace, "selection", selectionMembers);
    const { wire, result } = await extract(started, {
      inputs: [{ kind: "path", path: "fixtures/selection.pck" }],
      include: ["*.gd"],
    });
    assert.equal(wire.isError, false, JSON.stringify({ error: result?.error, semantic: result?.semantic }));

    const effective = result.paths.effectiveDestination as string;
    assert.deepEqual(await listFiles(effective), ["gdre_export.log", "main.gd"]);
    const extracted = await readFile(path.join(effective, "main.gd"));
    assert.equal(sha256(extracted), sha256(memberBytes["main.gd"]));

    assert.equal(result.semantic.status, "succeeded");
    assert.equal(result.semantic.data.totalFiles, 3);
    assert.equal(result.semantic.data.selectedFiles, 1);
    assert.equal(result.semantic.data.extractedFiles, 1);
    assert.deepEqual(result.semantic.data.checksumCoverage, { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 });
    assert.ok(result.semantic.evidence.some((line: string) => line.includes("Verified 3 files")));
    assert.ok(result.semantic.evidence.some((line: string) => line.includes("Extracted 1 files")));

    const manifest = await readJson(result.paths.manifest);
    const preflight = manifest.preflight as AnyRecord;
    assert.deepEqual(preflight.invocation.argv, ["--headless", "--no-header", "--", `--list-files=${pck}`]);
    assert.equal(manifest.invocation.argv.includes("--include=*.gd"), true);
    assert.equal(manifest.effectiveParameters.selection, "all");
    assert.equal(manifest.parameterSources.selection, "builtin", "omitted selection keeps builtin provenance");

    const expectedMembers = await readJson(preflight.expectedMembers.path);
    assert.equal(expectedMembers.count, 3);
    assert.deepEqual([...expectedMembers.members].sort(), [...memberNames].sort());

    assert.equal(preflight.selectedMembers.count, 1);
    assert.equal(preflight.selectedMembers.complete, true);
    const selected = await readJson(preflight.selectedMembers.path);
    assert.equal(selected.complete, true);
    assert.deepEqual(selected.members, ["res://main.gd"]);
    assert.deepEqual(selected.request, { mode: "all", include: ["*.gd"], exclude: [] });
    assert.equal(selected.sourceKind, "package");
    assert.equal(selected.full.expectedMembersSha256, preflight.expectedMembers.sha256);
    assert.equal(preflight.selectedMembers.sha256, sha256(await readFile(preflight.selectedMembers.path)));

    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.entries.length, result.artifacts.count);
    assert.equal(result.artifacts.items.length, result.artifacts.count);
  } finally {
    await closeClient(started);
  }
});

// ---- scripts / translations modes -----------------------------------------

const modeBytes = {
  "project.godot": Buffer.from("config_version=5\n", "utf8"),
  "main.gd": Buffer.from("extends Node\n# main\n", "utf8"),
  "scripts/player.gdc": Buffer.from("GDC-PLAYER-BYTES", "utf8"),
  "scripts/enemy.gde": Buffer.from("GDE-ENEMY-BYTES", "utf8"),
  "locales/en.translation": Buffer.from("EN-TRANSLATION-BYTES", "utf8"),
  "locales/zh_CN.xl": Buffer.from("ZH-XL-BYTES", "utf8"),
  "case/Case.GD": Buffer.from("UPPER-GD-BYTES", "utf8"),
  "case/Case.XL": Buffer.from("UPPER-XL-BYTES", "utf8"),
  "data/nested.bin": Buffer.from([9, 8, 7, 6, 5]),
  "notes.txt": Buffer.from("notes\n", "utf8"),
};
const modeMembers = Object.entries(modeBytes) as ReadonlyArray<readonly [string, Buffer]>;
const scriptsExpected = ["case/Case.GD", "main.gd", "scripts/enemy.gde", "scripts/player.gdc"].sort();
const translationsExpected = ["case/Case.XL", "locales/en.translation", "locales/zh_CN.xl"].sort();

for (const mode of ["scripts", "translations"] as const) {
  test(`real stdio extracts the ${mode} mode subset with exact bytes and the mode flag`, async () => {
    const started = await startClient();
    try {
      await authorPck(started.workspace, "modes", modeMembers);
      const { wire, result } = await extract(started, {
        inputs: [{ kind: "path", path: "fixtures/modes.pck" }],
        selection: mode,
      });
      assert.equal(wire.isError, false, JSON.stringify({ error: result?.error, semantic: result?.semantic }));
      const expected = mode === "scripts" ? scriptsExpected : translationsExpected;
      const flag = mode === "scripts" ? "--scripts-only" : "--translation-only";

      const effective = result.paths.effectiveDestination as string;
      assert.deepEqual(await listFiles(effective), ["gdre_export.log", ...expected].sort());
      for (const relative of expected) {
        const bytes = await readFile(path.join(effective, ...relative.split("/")));
        assert.equal(sha256(bytes), sha256(modeBytes[relative as keyof typeof modeBytes]!), relative);
      }
      // Excluded members are absent.
      for (const absent of mode === "scripts" ? ["locales/en.translation", "data/nested.bin"] : ["main.gd", "data/nested.bin"]) {
        await assert.rejects(readFile(path.join(effective, ...absent.split("/"))));
      }

      assert.equal(result.semantic.data.totalFiles, 10);
      assert.equal(result.semantic.data.selectedFiles, expected.length);
      assert.equal(result.semantic.data.extractedFiles, expected.length);
      assert.deepEqual(result.semantic.data.checksumCoverage, { scope: "all-members", verifiedFiles: 10, skippedFiles: 0 });

      const manifest = await readJson(result.paths.manifest);
      assert.equal(manifest.invocation.argv.includes(flag), true);
      assert.equal(manifest.effectiveParameters.selection, mode);
      assert.equal(manifest.parameterSources.selection, "call");
      const selected = await readJson((manifest.preflight as AnyRecord).selectedMembers.path);
      assert.equal(selected.count, expected.length);
      assert.deepEqual([...selected.members].map((name: string) => name.replace(/^res:\/\//u, "")).sort(), expected);
    } finally {
      await closeClient(started);
    }
  });
}

test("real stdio combines ordered overlapping includes and excludes at an explicit destination", async () => {
  const started = await startClient();
  try {
    await authorPck(started.workspace, "filters", modeMembers);
    const { wire, result } = await extract(started, {
      inputs: [{ kind: "path", path: "fixtures/filters.pck" }],
      output: "exports/selected set",
      include: ["res://scripts/**", "res://**/*.gd", "res://scripts/player.gdc"],
      exclude: ["res://scripts/*.gde"],
    });
    assert.equal(wire.isError, false, JSON.stringify({ error: result?.error, semantic: result?.semantic }));
    const effective = result.paths.effectiveDestination as string;
    assert.equal(path.normalize(effective), path.join(started.workspace, "exports", "selected set"));
    assert.equal(result.semantic.data.outputPath, effective);
    assert.deepEqual(await listFiles(effective), ["gdre_export.log", "main.gd", "scripts/player.gdc"]);
    assert.equal(result.semantic.data.totalFiles, 10);
    assert.equal(result.semantic.data.selectedFiles, 2);
    assert.equal(result.semantic.data.extractedFiles, 2);
    assert.deepEqual(result.semantic.data.checksumCoverage, { scope: "all-members", verifiedFiles: 10, skippedFiles: 0 });

    const manifest = await readJson(result.paths.manifest);
    assert.deepEqual(manifest.semantic, result.semantic);
    assert.deepEqual(manifest.invocation.argv.filter((token: string) => /^--(?:include|exclude)=/u.test(token)), [
      "--include=res://scripts/**",
      "--include=res://**/*.gd",
      "--include=res://scripts/player.gdc",
      "--exclude=res://scripts/*.gde",
    ]);
    assert.equal(manifest.preflight.invocation.argv.some((token: string) => /^--(?:include|exclude)=/u.test(token)), false);
    const selected = await readJson(manifest.preflight.selectedMembers.path);
    assert.deepEqual([...selected.members].sort(), ["res://main.gd", "res://scripts/player.gdc"]);
    assert.equal(selected.count, 2, "overlapping patterns select distinct members");
    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, 4, "two members, their scripts directory, and the administrative log");
    for (const relative of ["main.gd", "scripts/player.gdc"] as const) {
      const actualPath = path.join(effective, ...relative.split("/"));
      const bytes = await readFile(actualPath);
      assert.deepEqual(bytes, modeBytes[relative]);
      const artifact = inventory.entries.find((entry: AnyRecord) => path.normalize(entry.path) === actualPath);
      assert.ok(artifact, relative);
      assert.equal(artifact.sha256, sha256(modeBytes[relative]));
      assert.equal(artifact.bytes, modeBytes[relative].length);
    }
  } finally {
    await closeClient(started);
  }
});

// ---- excluded invalid-MD5 member ------------------------------------------

test("real stdio fails truthfully when an excluded member has an invalid MD5 entry", async () => {
  const started = await startClient();
  try {
    const pck = await authorPck(started.workspace, "corrupt", [
      ["bad.txt", Buffer.from("bad payload, md5 will be corrupted\n", "utf8")],
      ["keep1.txt", Buffer.from("keep one\n", "utf8")],
      ["keep2.txt", Buffer.from("keep two\n", "utf8")],
    ]);
    await corruptFirstPckPayloadByte(pck);

    const { wire, result } = await extract(started, {
      inputs: [{ kind: "path", path: "fixtures/corrupt.pck" }],
      include: ["res://keep*.txt"],
      exclude: ["res://bad.txt"],
    });
    assert.equal(wire.isError, true);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "process_failed");
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.artifacts.complete, false);
    assert.equal(result.process.exitCode, 1);
    assert.notEqual(result.process.pid, null);

    const stdout = await readFile(result.stdout.rawPath);
    const stdoutText = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    assert.match(stdoutText, /MD5 checksum failed|Checksum failed/u);
    assert.equal(result.semantic.data, null);

    // Selected expectation is independently derived and retained; nothing was extracted.
    const manifest = await readJson(result.paths.manifest);
    const selected = await readJson((manifest.preflight as AnyRecord).selectedMembers.path);
    assert.equal(selected.count, 2);
    assert.deepEqual([...selected.members].sort(), ["res://keep1.txt", "res://keep2.txt"]);
    assert.equal((await readJson((manifest.preflight as AnyRecord).expectedMembers.path)).count, 3);
    const effective = result.paths.effectiveDestination as string;
    // Only the administrative runtime log exists; no selected member was extracted.
    assert.deepEqual(await listFiles(effective), ["gdre_export.log"]);
    await assert.rejects(readFile(path.join(effective, "keep1.txt")));
    await assert.rejects(readFile(path.join(effective, "keep2.txt")));
  } finally {
    await closeClient(started);
  }
});

// ---- no-match safety -------------------------------------------------------

const plainMembers: ReadonlyArray<readonly [string, Buffer]> = [
  ["project.godot", Buffer.from("config_version=5\n", "utf8")],
  ["data.txt", Buffer.from("plain\n", "utf8")],
  ["icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
];

test("real stdio blocks exclude-all and mode no-match selections before any mutation", async () => {
  const started = await startClient();
  try {
    await authorPck(started.workspace, "plain", plainMembers);
    const cases: AnyRecord[] = [
      { include: ["res://**/*.nope"] },
      { exclude: ["res://**"] },
      { selection: "scripts" },
      { selection: "translations" },
    ];
    for (const selection of cases) {
      const { wire, result } = await extract(started, {
        inputs: [{ kind: "path", path: "fixtures/plain.pck" }],
        ...selection,
      });
      assert.equal(wire.isError, true, JSON.stringify(selection));
      assert.equal(result.success, false, JSON.stringify(selection));
      assert.equal(result.semantic.status, "failed", JSON.stringify(selection));
      assert.equal(result.error.code, "semantic_failed", JSON.stringify(selection));
      assert.equal(result.process.pid, null, `no extraction process for ${JSON.stringify(selection)}`);
      assert.equal(result.artifacts.items.length, 0, JSON.stringify(selection));
      assert.equal(result.artifacts.count, 0, JSON.stringify(selection));

      const manifest = await readJson(result.paths.manifest);
      const preflight = manifest.preflight as AnyRecord;
      assert.equal(preflight.semantic.status, "succeeded", "full preflight still succeeds");
      assert.equal(preflight.expectedMembers.count, 3);
      assert.equal(preflight.selectedMembers.complete, true);
      assert.equal(preflight.selectedMembers.count, 0);
      const selected = await readJson(preflight.selectedMembers.path);
      assert.equal(selected.complete, true);
      assert.equal(selected.count, 0);
      assert.deepEqual(selected.members, []);

      const effective = result.paths.effectiveDestination as string;
      await assert.rejects(
        readdir(effective),
        { code: "ENOENT" },
        `no product directory created for ${JSON.stringify(selection)}`,
      );
      assert.deepEqual(await listFiles(result.paths.output as string), [], "internal output remains empty");
    }
  } finally {
    await closeClient(started);
  }
});

// ---- directory source ------------------------------------------------------

test("real stdio rejects rooted directory filters and accepts a bare-star directory filter", async () => {
  const started = await startClient();
  try {
    const project = path.join(started.workspace, "project");
    await mkdir(path.join(project, ".godot"), { recursive: true });
    await writeFile(path.join(project, "project.godot"), memberBytes["project.godot"]);
    await writeFile(path.join(project, "main.gd"), memberBytes["main.gd"]);

    const rejected = await extract(started, { inputs: [{ kind: "path", path: "project" }], include: ["res://main.gd"] });
    assert.equal(rejected.wire.isError, true);
    assert.equal(rejected.result.error.code, "unsupported_capability");
    assert.equal(rejected.result.process.pid, null);
    assert.match(rejected.result.semantic.summary, /directory/iu);
    const rejectedRecord = await readJson((await readJson(rejected.result.paths.manifest)).preflight.selectedMembers.path);
    assert.equal(rejectedRecord.complete, false);
    assert.equal(Object.hasOwn(rejectedRecord, "count"), false, "unsupported selection claims no exact count");
    assert.deepEqual(rejectedRecord.rejectedPatterns, ["res://main.gd"]);

    const accepted = await extract(started, { inputs: [{ kind: "path", path: "project" }], include: ["*.gd"] });
    assert.equal(accepted.wire.isError, false, JSON.stringify(accepted.result?.semantic));
    const effective = accepted.result.paths.effectiveDestination as string;
    assert.deepEqual(await listFiles(effective), ["gdre_export.log", "main.gd"]);
    assert.equal(sha256(await readFile(path.join(effective, "main.gd"))), sha256(memberBytes["main.gd"]));
    await assert.rejects(readFile(path.join(effective, "project.godot")), "excluded project.godot is absent");
    assert.equal(accepted.result.semantic.data.selectedFiles, 1);
  } finally {
    await closeClient(started);
  }
});

// ---- bounded response with more than 32 selected members -------------------

test("real stdio caps the inline artifact sample while retaining the complete selected inventory", async () => {
  const started = await startClient();
  try {
    const members: Array<readonly [string, Buffer]> = [];
    for (let index = 0; index < 34; index += 1) {
      members.push([`scripts/s${String(index).padStart(2, "0")}.gd`, Buffer.from(`extends Node\n# ${String(index)}\n`, "utf8")]);
    }
    for (let index = 0; index < 8; index += 1) {
      members.push([`data/b${String(index).padStart(2, "0")}.bin`, Buffer.from([index, index, index])]);
    }
    await authorPck(started.workspace, "many", members);

    const { wire, result } = await extract(started, {
      inputs: [{ kind: "path", path: "fixtures/many.pck" }],
      include: ["*.gd"],
    });
    assert.equal(wire.isError, false, JSON.stringify({ error: result?.error, semantic: result?.semantic }));
    assert.equal(result.semantic.data.totalFiles, 42);
    assert.equal(result.semantic.data.selectedFiles, 34);
    assert.equal(result.semantic.data.extractedFiles, 34);
    assert.equal(result.artifacts.items.length, 32, "inline sample is capped at 32");
    assert.equal(result.artifacts.truncated, true);
    assert.equal(result.artifacts.complete, true);
    assert.equal(result.artifacts.count, 34 + 1 + 1, "34 selected files + scripts/data dirs + log");

    const manifest = await readJson(result.paths.manifest);
    const selected = await readJson((manifest.preflight as AnyRecord).selectedMembers.path);
    assert.equal(selected.count, 34);
    assert.equal(selected.members.length, 34);
    const inventory = await readJson(result.paths.artifactInventory);
    assert.equal(inventory.complete, true);
    assert.equal(inventory.entries.length, result.artifacts.count);
  } finally {
    await closeClient(started);
  }
});
