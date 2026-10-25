import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeIndependentPck } from "./support/extraction-fixtures.js";
import {
  createExportFixture,
  type ExportFixture,
} from "./support/export-fixtures.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ?? path.join(repositoryRoot, "vendor", "GDRE_tools");
const runtimeExecutable = path.join(runtimeDirectory, "gdre_tools.exe");

/** Finite client watchdog for these controlled fixture workloads. */
const clientRequestOptions = { timeout: 240_000, maxTotalTimeout: 240_000 };

type AnyRecord = Record<string, any>;

interface StartedExportClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

interface StartOptions {
  readonly defaults?: Record<string, unknown>;
  /** Reuse an existing workspace, e.g. to inspect configured defaults. */
  readonly workspace?: string;
}

const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  GDRE_MCP_CONFIG: configFile,
});

async function startClient(options: StartOptions = {}): Promise<StartedExportClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-export-stdio-"));
  const workspace = options.workspace ?? path.join(root, "workspace");
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
      defaults: options.defaults ?? {},
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
  const client = new Client({ name: "ticket-07-export-stdio", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedExportClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function sha256File(file: string): Promise<string> {
  return sha256(await readFile(file));
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(full)).map((item) => `${entry.name}/${item}`));
    else result.push(entry.name);
  }
  return result.sort();
}

async function snapshotTree(target: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${relative}`);
        await visit(full, relative);
      } else {
        lines.push(`f ${relative} ${await sha256File(full)}`);
      }
    }
  };
  await visit(target, "");
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
}

async function assertMissing(file: string, label: string): Promise<void> {
  await assert.rejects(readFile(file), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT", label);
    return true;
  });
}

const callExport = async (
  started: StartedExportClient,
  arguments_: AnyRecord,
): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord }> => {
  const wire = await started.client.callTool(
    { name: "gdre_export_resources", arguments: arguments_ },
    clientRequestOptions,
  ) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
};

const fixtureAt = (
  started: StartedExportClient,
  name: string,
  options: { readonly includeFailureVariants?: boolean; readonly includeTranslations?: boolean } = {},
): Promise<ExportFixture> =>
  createExportFixture({
    root: path.join(started.workspace, "fixtures", name),
    runtimeExecutable,
    includeFailureVariants: options.includeFailureVariants,
    includeTranslations: options.includeTranslations,
  });

const packageInput = (name: string): readonly AnyRecord[] => [
  { kind: "path", path: `fixtures/${name}/fixture.pck` },
];

const translationSelection = (fixture: ExportFixture): AnyRecord => ({
  kind: "members",
  include: [...fixture.translation!.binaryMembers],
});

async function assertReportsAccessible(data: AnyRecord): Promise<void> {
  for (const label of ["native", "nativeLog", "adapter"] as const) {
    const file = data.reports[label] as string | null;
    assert.equal(typeof file, "string", `${label} report path`);
    const info = await stat(file!);
    assert.ok(info.isFile() && info.size > 0, `${label} report is nonempty`);
  }
}

function assertCompleteness(
  wire: AnyRecord,
  result: AnyRecord,
  completeness: string,
  label: string,
): AnyRecord {
  const data = result.semantic.data as AnyRecord;
  assert.ok(data !== null, `${label}: semantic data retained`);
  assert.equal(data.completeness, completeness, label);
  assert.equal(result.semantic.status, completeness === "complete" ? "succeeded" : completeness === "unknown" ? "unknown" : "failed", label);
  assert.equal(result.success, completeness === "complete", label);
  assert.equal(wire.isError, completeness !== "complete", label);
  return data;
}

test("real stdio discovers export and exports selected package content with authored evidence", async (t) => {
  const started = await startClient();
  try {
    const fixture = await fixtureAt(started, "selected");
    const pck = path.join(fixture.root, "fixture.pck");
    const pckHash = await sha256File(pck);
    const sourceHash = await snapshotTree(fixture.sourceDirectory);
    const explicitOutput = "exports/selected";
    const effective = path.join(started.workspace, explicitOutput);
    const selection = {
      kind: "members",
      include: [...fixture.translation!.binaryMembers, fixture.script.bytecodeMember],
    };

    await t.test("discovers the tool and reuses authored translation and script expectations", async () => {
      const listed = await started.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.ok(names.includes("gdre_export_resources"));
      assert.ok(names.includes("gdre_version"));
      assert.ok(names.includes("gdre_list_files"));
      assert.ok(names.includes("gdre_extract"));

      const { wire, result } = await callExport(started, {
        inputs: packageInput("selected"),
        output: explicitOutput,
        selection,
        session: [{ kind: "multithreading", disabled: true }],
      });
      const data = assertCompleteness(wire, result, "complete", "selected package export");

      assert.equal(result.status, "succeeded");
      assert.equal(result.error, null);
      assert.equal(result.paths.effectiveDestination, effective);
      assert.equal(data.outputPath, effective);
      assert.deepEqual(data.selection, { kind: "members", group: null });
      assert.deepEqual(data.counts, {
        completeMembers: fixture.members.length,
        selectedMembers: 3,
        nativeImports: 2,
        exportSuccess: 2,
        exportFailed: 0,
        exportUnsupported: 0,
        unverifiedSuccess: 0,
        unaccountedImports: 0,
        unmappedMembers: 0,
        missingKeys: 0,
        totalKeys: 4,
      });
      assert.equal(data.artifactRoles.editableExports, 2);
      assert.equal(data.artifactRoles.unverifiedExports, 0);
      assert.equal(data.artifactRoles.rawOrUnmappedMembers, 0);
      assert.ok(data.artifactRoles.accompanying >= 1);
      assert.ok(data.artifactRoles.administrative >= 2);
      assert.ok(data.sideEffects.some((line: string) => /scaffolding|project configuration/iu.test(line)));
      const slash = (value: string): string => value.replaceAll("\\", "/");
      assert.deepEqual(
        [...data.previews.editableExports].map(slash).sort(),
        [path.join(effective, "main.gd"), path.join(effective, "translations.csv")].map(slash).sort(),
      );

      assert.equal(await readFile(path.join(effective, "translations.csv"), "utf8"), fixture.translation!.csvText);
      assert.equal(await readFile(path.join(effective, "main.gd"), "utf8"), fixture.script.expectedText);
      await assertMissing(path.join(effective, "notes.txt"), "unselected raw member is absent");
      await assertReportsAccessible(data);

      const nativeReport = await readJson(data.reports.native);
      assert.equal(nativeReport.session_files_total, 2);
      assert.equal(nativeReport.success.length, 2);
      assert.deepEqual(nativeReport.failed, []);
      assert.deepEqual(nativeReport.not_converted, []);
      const translationEntry = (nativeReport.success as AnyRecord[]).find((entry) => entry.exporter === "Translation");
      assert.ok(translationEntry);
      assert.deepEqual(translationEntry.extra_info, { missing_keys: 0, total_keys: 4 });
      assert.ok((nativeReport.success as AnyRecord[]).some((entry) => entry.exporter === "GDScript"));

      const inventory = await readJson(result.paths.artifactInventory);
      assert.equal(inventory.complete, true);
      assert.equal(result.artifacts.complete, true);
      assert.equal(result.artifacts.count, (inventory.entries as AnyRecord[]).length);
      assert.ok(result.artifacts.items.length <= 32);
      const roles = new Map((inventory.entries as AnyRecord[]).map((entry) => [entry.path as string, entry.role as string]));
      assert.equal(roles.get(path.join(effective, "translations.csv")), "export-artifact");
      assert.equal(roles.get(path.join(effective, "main.gd")), "export-artifact");
      assert.equal(roles.get(path.join(effective, "gdre_export.json")), "administrative-report");
      assert.equal(roles.get(path.join(effective, "gdre_export.log")), "administrative-log");
      assert.equal(roles.get(path.join(effective, "project.godot")), "accompanying");
      assert.equal(
        roles.get(path.join(effective, ".godot", "imported", "translations.en.translation")),
        "selected-raw",
      );

      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(manifest.parameterSources, {
        workspace: "config",
        inputs: "call",
        session: "call",
        output: "call",
        selection: "call",
        translationHints: "builtin",
        collectResourceStrings: "builtin",
        dumpResourceStrings: "builtin",
      });
      assert.equal(manifest.effectiveParameters.output, effective);
      assert.deepEqual(manifest.effectiveParameters.session, [{ kind: "multithreading", disabled: true }]);
      assert.equal(manifest.effectiveParameters.collectResourceStrings, true);
      assert.equal(manifest.effectiveParameters.dumpResourceStrings, false);
      assert.deepEqual(manifest.invocation.argv, [
        "--headless",
        "--no-header",
        "--",
        "--disable-multithreading=true",
        `--recover=${pck}`,
        `--output=${effective}`,
        `--include=${fixture.translation!.binaryMembers[0]}`,
        `--include=${fixture.translation!.binaryMembers[1]}`,
        `--include=${fixture.script.bytecodeMember}`,
        "--setting=write_json_report=true",
      ]);
      assert.equal(manifest.invocation.executable, runtimeExecutable);
      assert.equal(manifest.invocation.cwd, result.paths.operation);
      assert.ok(manifest.effects.reads.includes(pck));
      assert.ok(manifest.effects.writes.includes(effective));

      const primary = (manifest.invocation.inputPaths as AnyRecord[]).find((entry) => entry.role === "input");
      assert.equal(primary?.path, pck);
      assert.equal(primary?.sha256, pckHash);

      const profile = manifest.invocation.environmentProfile as AnyRecord;
      assert.equal(profile.root, path.join(result.paths.operation!, "profile"));
      assert.equal(profile.overrides.APPDATA, path.join(profile.root, "appdata"));
      assert.equal(profile.overrides.LOCALAPPDATA, path.join(profile.root, "localappdata"));
      assert.equal(profile.overrides.USERPROFILE, path.join(profile.root, "userprofile"));
      assert.equal(profile.overrides.HOME, path.join(profile.root, "home"));
      assert.equal(profile.overrides.TEMP, path.join(profile.root, "temp"));
      assert.equal(profile.overrides.TMP, path.join(profile.root, "tmp"));
      assert.equal(profile.overrides.GDRE_PLUGIN_CACHE_DIR, path.join(profile.root, "plugin-cache"));
      assert.equal(profile.overrides.CWD, result.paths.operation);
      assert.deepEqual(profile.controls, {
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
      });
      const generatedConfig = await readFile(profile.generatedConfigFile as string, "utf8");
      assert.match(generatedConfig, /download_plugins=false/u);
      assert.match(generatedConfig, /execute_visual_shader_node_scripts=false/u);
      assert.match(generatedConfig, /compile_after_decompile=false/u);

      const preflight = manifest.preflight as AnyRecord;
      assert.equal(preflight.semantic.status, "succeeded");
      assert.equal(preflight.native.fileCount, fixture.members.length);

      assert.equal(await sha256File(pck), pckHash, "package input unchanged");
      assert.equal(await snapshotTree(fixture.sourceDirectory), sourceHash, "fixture source unchanged");
    });

    await t.test("omitted output uses a distinct sibling destination", async () => {
      const { wire, result } = await callExport(started, {
        inputs: packageInput("selected"),
        selection: { kind: "members", include: [fixture.script.bytecodeMember] },
      });
      const data = assertCompleteness(wire, result, "complete", "sibling output");
      const expectedSibling = path.join(
        fixture.root,
        `fixture-exported-${path.basename(result.paths.operation!)}`,
      );
      assert.equal(result.paths.output, path.join(result.paths.operation!, "output"));
      assert.equal(result.paths.effectiveDestination, expectedSibling);
      assert.notEqual(result.paths.effectiveDestination, result.paths.output);
      assert.equal(data.outputPath, expectedSibling);
      assert.notEqual(result.paths.effectiveDestination, path.join(started.workspace, "exports", "selected"));
      assert.equal(await readFile(path.join(result.paths.effectiveDestination!, "main.gd"), "utf8"), fixture.script.expectedText);
      await assertMissing(path.join(result.paths.effectiveDestination!, "translations.csv"), "unselected translation is absent");
      assert.deepEqual(await readdirSafe(result.paths.output!), [], "internal output stays empty");
    });

    await t.test("repeating a populated explicit destination is rejected without overwriting", async () => {
      const before = await readFile(path.join(effective, "translations.csv"), "utf8");
      const { wire, result } = await callExport(started, {
        inputs: packageInput("selected"),
        output: explicitOutput,
        selection,
      });
      assert.equal(wire.isError, true);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "path_unsupported");
      assert.equal(result.error.stage, "validating");
      assert.equal(result.process.pid, null, "no recovery process was started");
      assert.equal(result.artifacts.count, 0);
      assert.equal(result.semantic.status, "not_evaluated");
      assert.equal(await readFile(path.join(effective, "translations.csv"), "utf8"), before);
      assert.equal(await sha256File(pck), pckHash);
    });

    await t.test("configured export defaults apply and an explicit empty session clears them", async () => {
      const configured = await startClient({
        workspace: started.workspace,
        defaults: {
          "export-resources": {
            timeoutMs: 120_000,
            session: [{ kind: "multithreading", disabled: true }],
          },
        },
      });
      try {
        const inherited = await callExport(configured, {
          inputs: packageInput("selected"),
          output: "exports/configured-defaults",
          selection: { kind: "members", include: [fixture.script.bytecodeMember] },
        });
        assertCompleteness(inherited.wire, inherited.result, "complete", "configured defaults");
        const inheritedManifest = await readJson(inherited.result.paths.manifest);
        assert.equal(inheritedManifest.parameterSources.session, "config");
        assert.equal(inheritedManifest.parameterSources.timeoutMs, "config");
        assert.deepEqual(inheritedManifest.effectiveParameters.session, [{ kind: "multithreading", disabled: true }]);
        assert.equal(inheritedManifest.effectiveParameters.timeoutMs, 120_000);
        assert.ok((inheritedManifest.invocation.argv as string[]).includes("--disable-multithreading=true"));

        const cleared = await callExport(configured, {
          inputs: packageInput("selected"),
          output: "exports/cleared-session",
          selection: { kind: "members", include: [fixture.script.bytecodeMember] },
          session: [],
        });
        assertCompleteness(cleared.wire, cleared.result, "complete", "explicit empty session");
        const clearedManifest = await readJson(cleared.result.paths.manifest);
        assert.equal(clearedManifest.parameterSources.session, "call");
        assert.deepEqual(clearedManifest.effectiveParameters.session, []);
        assert.equal((clearedManifest.invocation.argv as string[]).some((token) => token.startsWith("--disable-multithreading")), false);
      } finally {
        await closeClient(configured);
      }
    });
  } finally {
    await closeClient(started);
  }
});

test("real stdio exports native groups, directory inputs and one host-input glob", async (t) => {
  const started = await startClient();
  try {
    const fixture = await fixtureAt(started, "groups");
    const sourceHash = await snapshotTree(fixture.sourceDirectory);
    const pckHash = await sha256File(fixture.packagePath);
    const cases: readonly {
      readonly label: string;
      readonly input: readonly AnyRecord[];
      readonly selection: AnyRecord;
      readonly output: string;
      readonly expectedEditable: "translations.csv" | "main.gd";
      readonly expectedSelected: number;
      readonly expectedImports: number;
      readonly argvFlag: string;
    }[] = [
      {
        label: "package translations group",
        input: packageInput("groups"),
        selection: { kind: "group", group: "translations" },
        output: "exports/groups/package-translations",
        expectedEditable: "translations.csv",
        expectedSelected: 2,
        expectedImports: 1,
        argvFlag: "--translation-only",
      },
      {
        label: "package scripts group",
        input: packageInput("groups"),
        selection: { kind: "group", group: "scripts" },
        output: "exports/groups/package-scripts",
        expectedEditable: "main.gd",
        expectedSelected: 1,
        expectedImports: 1,
        argvFlag: "--scripts-only",
      },
      {
        label: "directory translations group",
        input: [{ kind: "path", path: "fixtures/groups/project" }],
        selection: { kind: "group", group: "translations" },
        output: "exports/groups/directory-translations",
        expectedEditable: "translations.csv",
        expectedSelected: 2,
        expectedImports: 1,
        argvFlag: "--translation-only",
      },
      {
        label: "directory scripts group",
        input: [{ kind: "path", path: "fixtures/groups/project" }],
        selection: { kind: "group", group: "scripts" },
        output: "exports/groups/directory-scripts",
        expectedEditable: "main.gd",
        expectedSelected: 1,
        expectedImports: 1,
        argvFlag: "--scripts-only",
      },
      {
        label: "directory bare-star member filter",
        input: [{ kind: "path", path: "fixtures/groups/project" }],
        selection: { kind: "members", include: ["*.translation"] },
        output: "exports/groups/directory-bare-star",
        expectedEditable: "translations.csv",
        expectedSelected: 2,
        expectedImports: 1,
        argvFlag: "--include=*.translation",
      },
      {
        label: "host-input glob",
        input: [{ kind: "glob", pattern: "fixtures/groups/*.pck" }],
        selection: { kind: "group", group: "translations" },
        output: "exports/groups/glob-input",
        expectedEditable: "translations.csv",
        expectedSelected: 2,
        expectedImports: 1,
        argvFlag: "--translation-only",
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.label, async () => {
        const { wire, result } = await callExport(started, {
          inputs: testCase.input,
          output: testCase.output,
          selection: testCase.selection,
        });
        const data = assertCompleteness(wire, result, "complete", testCase.label);
        const effective = path.join(started.workspace, testCase.output);
        assert.equal(data.outputPath, effective);
        assert.equal(data.counts.selectedMembers, testCase.expectedSelected);
        assert.equal(data.counts.nativeImports, testCase.expectedImports);
        assert.equal(data.counts.exportSuccess, testCase.expectedImports);
        assert.equal(data.artifactRoles.editableExports, 1);
        if (testCase.expectedEditable === "translations.csv") {
          assert.equal(await readFile(path.join(effective, "translations.csv"), "utf8"), fixture.translation!.csvText);
          await assertMissing(path.join(effective, "main.gd"), `${testCase.label}: unselected script absent`);
        } else {
          assert.equal(await readFile(path.join(effective, "main.gd"), "utf8"), fixture.script.expectedText);
          await assertMissing(path.join(effective, "translations.csv"), `${testCase.label}: unselected translation absent`);
        }
        const manifest = await readJson(result.paths.manifest);
        assert.ok((manifest.invocation.argv as string[]).includes(testCase.argvFlag), testCase.label);
      });
    }

    await t.test("path-qualified member filters are rejected for directory sources before recovery", async () => {
      const output = "exports/groups/directory-rejected";
      const { wire, result } = await callExport(started, {
        inputs: [{ kind: "path", path: "fixtures/groups/project" }],
        output,
        selection: { kind: "members", include: ["res://main.gdc"] },
      });
      assert.equal(wire.isError, true);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "unsupported_capability");
      assert.equal(result.process.pid, null, "no recovery process was started");
      assert.match(result.semantic.summary, /directory/iu);
      assert.deepEqual(await readdirSafe(path.join(started.workspace, output)), []);
      const manifest = await readJson(result.paths.manifest);
      const preflight = manifest.preflight as AnyRecord;
      assert.equal(preflight.semantic.status, "failed");
      assert.equal(preflight.selection.ok, false);
      assert.equal(preflight.selection.reason, "directory_filter_unsupported");
      assert.deepEqual(preflight.selection.patterns, ["res://main.gdc"]);
    });

    assert.equal(await snapshotTree(fixture.sourceDirectory), sourceHash, "directory input unchanged");
    assert.equal(await sha256File(fixture.packagePath), pckHash, "package input unchanged");
  } finally {
    await closeClient(started);
  }
});

test("real stdio rejects unsafe selections, keeps no-match non-mutating, and reports real outcomes", async (t) => {
  const started = await startClient();
  try {
    const fixture = await fixtureAt(started, "outcomes", { includeFailureVariants: true });
    const noTranslations = await fixtureAt(started, "no-translations", { includeTranslations: false });
    const sourceHash = await snapshotTree(fixture.sourceDirectory);
    const pckHash = await sha256File(fixture.packagePath);

    await t.test("schema-level invalid selections and key/checksum intent allocate no operation", async () => {
      const operationsRoot = path.join(started.workspace, ".gdre", "operations");
      assert.deepEqual(await readdirSafe(operationsRoot), [], "no operation allocated");
      const invalid: readonly AnyRecord[] = [
        { inputs: packageInput("outcomes") },
        { inputs: packageInput("outcomes"), selection: { kind: "members", include: [] } },
        { inputs: packageInput("outcomes"), selection: { kind: "group", group: "all" } },
        { inputs: packageInput("outcomes"), selection: { kind: "members", include: ["*.gdc"] }, key: "a".repeat(64) },
        { inputs: packageInput("outcomes"), selection: { kind: "members", include: ["*.gdc"] }, checksum: "skip" },
      ];
      for (const arguments_ of invalid) {
        const { wire, result } = await callExport(started, arguments_);
        assert.equal(wire.isError, true, JSON.stringify(arguments_));
        assert.equal(result, undefined, "SDK rejected before structured execution");
      }
      assert.deepEqual(await readdirSafe(operationsRoot), [], "still no operation allocated");
    });

    await t.test("no-match include retains preflight evidence and launches no recovery", async () => {
      const output = "exports/outcomes/no-match-include";
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output,
        selection: { kind: "members", include: ["res://missing/*.translation"] },
      });
      assert.equal(wire.isError, true);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "semantic_failed");
      assert.equal(result.process.pid, null);
      assert.deepEqual(await readdirSafe(path.join(started.workspace, output)), []);
      const manifest = await readJson(result.paths.manifest);
      const preflight = manifest.preflight as AnyRecord;
      assert.equal(preflight.semantic.status, "failed");
      assert.equal(preflight.selection.ok, true);
      assert.equal(preflight.selection.classification, "no_match");
      assert.equal(preflight.selection.count, 0);
      assert.equal(preflight.native.fileCount, fixture.members.length);
      assert.equal(preflight.expectations, null);
    });

    await t.test("no-match translations group on a translation-free fixture launches no recovery", async () => {
      assert.equal(noTranslations.translation, null);
      const output = "exports/outcomes/no-match-group";
      const { wire, result } = await callExport(started, {
        inputs: [{ kind: "path", path: "fixtures/no-translations/fixture.pck" }],
        output,
        selection: { kind: "group", group: "translations" },
      });
      assert.equal(wire.isError, true);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "semantic_failed");
      assert.equal(result.process.pid, null);
      assert.deepEqual(await readdirSafe(path.join(started.workspace, output)), []);
      const manifest = await readJson(result.paths.manifest);
      const preflight = manifest.preflight as AnyRecord;
      assert.equal(preflight.semantic.status, "failed");
      assert.equal(preflight.selection.ok, true);
      assert.equal(preflight.selection.classification, "no_match");
      assert.equal(preflight.selection.provenance.kind, "group");
      assert.equal(preflight.selection.count, 0);
      assert.equal(preflight.native.fileCount, noTranslations.members.length);
    });

    await t.test("input/output and hint/output overlap are rejected before recovery", async () => {
      const overlap = await callExport(started, {
        inputs: packageInput("outcomes"),
        output: "fixtures/outcomes/project",
        selection: { kind: "group", group: "translations" },
      });
      assert.equal(overlap.wire.isError, true);
      assert.equal(overlap.result.error.code, "path_unsupported");
      assert.equal(overlap.result.process.pid, null);

      const hintDirectory = path.join(started.workspace, "exports", "outcomes", "hint-overlap");
      await mkdir(hintDirectory, { recursive: true });
      const hintFile = path.join(hintDirectory, "hints.csv");
      await writeFile(hintFile, "key,en,zh\nHELLO,Hello,你好\n", "utf8");
      const hintSnapshot = await sha256File(hintFile);
      const hinted = await callExport(started, {
        inputs: packageInput("outcomes"),
        output: "exports/outcomes/hint-overlap",
        selection: translationSelection(fixture),
        translationHints: ["exports/outcomes/hint-overlap/hints.csv"],
      });
      assert.equal(hinted.wire.isError, true);
      assert.equal(hinted.result.error.code, "path_unsupported");
      assert.match(hinted.result.error.message, /overlap/iu);
      assert.equal(hinted.result.process.pid, null);
      assert.equal(await sha256File(hintFile), hintSnapshot, "hint input unchanged");
    });

    await t.test("nonempty explicit output is rejected without overwriting existing files", async () => {
      const outputDirectory = path.join(started.workspace, "exports", "outcomes", "nonempty");
      await mkdir(outputDirectory, { recursive: true });
      const marker = path.join(outputDirectory, "marker.txt");
      await writeFile(marker, "existing\n", "utf8");
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output: "exports/outcomes/nonempty",
        selection: { kind: "group", group: "translations" },
      });
      assert.equal(wire.isError, true);
      assert.equal(result.error.code, "path_unsupported");
      assert.equal(result.process.pid, null);
      assert.equal(await readFile(marker, "utf8"), "existing\n");
      assert.deepEqual((await readdirSafe(outputDirectory)).sort(), ["marker.txt"]);
    });

    await t.test("a failed selected import is reported as failed, not editable", async () => {
      const output = "exports/outcomes/failed";
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output,
        selection: { kind: "members", include: [fixture.variants!.failed.selectedMember] },
      });
      const data = assertCompleteness(wire, result, "failed", "failed import");
      assert.equal(data.counts.nativeImports, 1);
      assert.equal(data.counts.exportFailed, 1);
      assert.equal(data.counts.exportSuccess, 0);
      assert.equal(data.artifactRoles.editableExports, 0);
      assert.equal(data.previews.failed.length, 1);
      assert.match(data.previews.failed[0], /Texture/iu);
      await assertReportsAccessible(data);
      const nativeReport = await readJson(data.reports.native);
      assert.equal(nativeReport.failed.length, 1);
      const effective = path.join(started.workspace, output);
      await assertMissing(path.join(effective, "broken.png"), "no editable texture was produced");
    });

    await t.test("the authored unknown-importer destination reports unsupported", async () => {
      const output = "exports/outcomes/unsupported";
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output,
        selection: { kind: "members", include: [fixture.variants!.unsupported.selectedMember] },
      });
      const data = assertCompleteness(wire, result, "unsupported", "unsupported import");
      assert.equal(data.counts.nativeImports, 1);
      assert.equal(data.counts.exportUnsupported, 1);
      assert.equal(data.counts.exportSuccess, 0);
      assert.equal(data.artifactRoles.editableExports, 0);
      assert.equal(data.previews.unsupported.length, 1);
      await assertReportsAccessible(data);
      const nativeReport = await readJson(data.reports.native);
      assert.equal(nativeReport.not_converted.length, 1);
      assert.ok(nativeReport.unsupported_types.length > 0);
    });

    await t.test("mixing a valid script with a failed import yields partial with retained exact content", async () => {
      const output = "exports/outcomes/partial";
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output,
        selection: {
          kind: "members",
          include: [fixture.script.bytecodeMember, fixture.variants!.failed.selectedMember],
        },
      });
      const data = assertCompleteness(wire, result, "partial", "partial mixed export");
      assert.equal(data.counts.selectedMembers, 2);
      assert.equal(data.counts.nativeImports, 2);
      assert.equal(data.counts.exportSuccess, 1);
      assert.equal(data.counts.exportFailed, 1);
      assert.equal(data.artifactRoles.editableExports, 1);
      assert.equal(data.previews.failed.length, 1);
      assert.equal(await readFile(path.join(started.workspace, output, "main.gd"), "utf8"), fixture.script.expectedText);
      await assertReportsAccessible(data);
      const inventory = await readJson(result.paths.artifactInventory);
      assert.equal(inventory.complete, true);
      assert.equal(result.artifacts.complete, true);
    });

    await t.test("raw-only and metadata-only selections never become complete", async () => {
      for (const [label, member] of [
        ["raw-only", fixture.rawOnly.member],
        ["metadata-only", fixture.translation!.importMember],
      ] as const) {
        const output = `exports/outcomes/${label}`;
        const { wire, result } = await callExport(started, {
          inputs: packageInput("outcomes"),
          output,
          selection: { kind: "members", include: [member] },
        });
        const data = assertCompleteness(wire, result, "unsupported", label);
        assert.equal(data.counts.selectedMembers, 1);
        assert.equal(data.counts.nativeImports, 0);
        assert.equal(data.counts.unmappedMembers, 1);
        assert.equal(data.artifactRoles.editableExports, 0);
        assert.equal(data.artifactRoles.rawOrUnmappedMembers, 1);
        await assertMissing(
          path.join(started.workspace, output, "translations.csv"),
          `${label}: no editable translation output`,
        );
      }
      assert.equal(
        await readFile(path.join(started.workspace, "exports/outcomes/raw-only", "notes.txt"), "utf8"),
        fixture.rawOnly.text,
      );
    });

    await t.test("literal translation hint and string controls reach the accepted argv", async () => {
      const output = "exports/outcomes/hints";
      const hint = path.join(fixture.root, "hints.csv");
      await writeFile(hint, "key,en,zh\nHELLO,Hello,你好\n", "utf8");
      const hintHash = await sha256File(hint);
      const { wire, result } = await callExport(started, {
        inputs: packageInput("outcomes"),
        output,
        selection: translationSelection(fixture),
        translationHints: ["fixtures/outcomes/hints.csv"],
        collectResourceStrings: false,
        dumpResourceStrings: true,
      });
      const data = assertCompleteness(wire, result, "complete", "translation controls");
      assert.equal(
        await readFile(path.join(started.workspace, output, "translations.csv"), "utf8"),
        fixture.translation!.csvText,
      );
      const manifest = await readJson(result.paths.manifest);
      assert.deepEqual(manifest.invocation.argv, [
        "--headless",
        "--no-header",
        "--",
        `--recover=${fixture.packagePath}`,
        `--output=${path.join(started.workspace, output)}`,
        `--include=${fixture.translation!.binaryMembers[0]}`,
        `--include=${fixture.translation!.binaryMembers[1]}`,
        `--translation-hint=${hint}`,
        "--skip-loading-resource-strings",
        "--dump-resource-strings",
        "--setting=write_json_report=true",
      ]);
      assert.equal(manifest.parameterSources.translationHints, "call");
      assert.equal(manifest.parameterSources.collectResourceStrings, "call");
      assert.equal(manifest.parameterSources.dumpResourceStrings, "call");
      assert.deepEqual(manifest.effectiveParameters.translationHints, [{ kind: "path", path: hint }]);
      assert.equal(manifest.effectiveParameters.collectResourceStrings, false);
      assert.equal(manifest.effectiveParameters.dumpResourceStrings, true);
      const hintEvidence = (manifest.invocation.inputPaths as AnyRecord[]).find((entry) => entry.role === "hint");
      assert.equal(hintEvidence?.path, hint);
      assert.equal(hintEvidence?.sha256, hintHash);
      await assertReportsAccessible(data);
      assert.equal(await sha256File(hint), hintHash, "hint input unchanged");
    });

    assert.equal(await snapshotTree(fixture.sourceDirectory), sourceHash, "package fixture source unchanged");
    assert.equal(await sha256File(fixture.packagePath), pckHash, "package input unchanged");
  } finally {
    await closeClient(started);
  }
});

test("real stdio bounds inline samples while retaining complete export counts", async (t) => {
  const started = await startClient();
  try {
    const fixture = await fixtureAt(started, "bounded");
    const bytecode = await readFile(path.join(fixture.sourceDirectory, "main.gdc"));
    const members: { readonly relative: string; readonly bytes: Buffer }[] = [
      { relative: "project.godot", bytes: Buffer.from(fixture.projectText, "utf8") },
    ];
    for (let index = 0; index < 28; index += 1) {
      const name = `scripts/s${String(index).padStart(2, "0")}`;
      members.push({ relative: `${name}.gdc`, bytes: bytecode });
      members.push({
        relative: `${name}.gd.remap`,
        bytes: Buffer.from(`[remap]\n\npath="res://${name}.gdc"\n`, "utf8"),
      });
    }
    const pck = path.join(fixture.root, "many.pck");
    await writeIndependentPck(pck, members);

    await t.test("28 script imports remain complete while public samples truncate", async () => {
      const output = "exports/bounded";
      const { wire, result } = await callExport(started, {
        inputs: [{ kind: "path", path: "fixtures/bounded/many.pck" }],
        output,
        selection: { kind: "group", group: "scripts" },
      });
      const data = assertCompleteness(wire, result, "complete", "bounded scripts group");
      assert.equal(data.counts.completeMembers, members.length);
      assert.equal(data.counts.selectedMembers, 28);
      assert.equal(data.counts.nativeImports, 28);
      assert.equal(data.counts.exportSuccess, 28);
      assert.equal(data.artifactRoles.editableExports, 28);
      assert.equal(data.previews.editableExports.length, 8);
      assert.equal(result.artifacts.items.length, 32);
      assert.equal(result.artifacts.truncated, true);
      assert.equal(result.artifacts.complete, true);
      assert.ok(result.artifacts.count > 32);
      const inventory = await readJson(result.paths.artifactInventory);
      assert.equal(inventory.complete, true);
      assert.equal((inventory.entries as AnyRecord[]).length, result.artifacts.count);
      const adapter = await readJson(data.reports.adapter);
      assert.equal((adapter.imports as AnyRecord[]).length, 28);
      assert.equal(
        await readFile(path.join(started.workspace, output, "scripts", "s27.gd"), "utf8"),
        fixture.script.expectedText,
      );
    });
  } finally {
    await closeClient(started);
  }
});
