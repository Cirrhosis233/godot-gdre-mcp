import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArtifactEntry, ArtifactInventory } from "../src/artifacts.js";
import type { PreflightRunEvidence } from "../src/extraction-operation.js";
import { ExportOperation } from "../src/export-operation.js";
import { exportPreflightEvidencePath } from "../src/export-planning.js";
import type { ListingDirectoryInspector } from "../src/listing-paths.js";
import { prepareListingInputs } from "../src/listing-paths.js";
import { joinPath, pathIdentity } from "../src/paths.js";
import type { ExportResourcesInput, ProcessObservation } from "../src/types.js";

const benignInspector: ListingDirectoryInspector = {
  async inspect(directories) {
    return new Map(
      directories.map((directory) => [
        directory,
        { caseSensitive: false, reparsePoint: false },
      ]),
    );
  },
};

const translationImport = {
  path: "res://.godot/imported/translations.en.translation",
  import_md_path: "res://translations.csv.import",
  source_file: "res://translations.csv",
  importer: "csv_translation",
  type: "Translation",
  dest_files: [
    "res://.godot/imported/translations.en.translation",
    "res://.godot/imported/translations.zh.translation",
  ],
};

const scriptImport = {
  path: "res://main.gdc",
  import_md_path: "res://main.gd.remap",
  source_file: "res://main.gd",
  importer: "script_bytecode",
  type: "GDScript",
  dest_files: ["res://main.gdc"],
};

const files = [
  "res://project.godot",
  "res://translations.csv",
  "res://translations.csv.import",
  "res://.godot/imported/translations.en.translation",
  "res://.godot/imported/translations.zh.translation",
  "res://main.gdc",
  "res://main.gd.remap",
];

interface StoreWrite {
  readonly name: string;
  readonly file: string;
  readonly value: unknown;
  readonly target: string;
}

const makeStore = (root: string) => {
  const writes: StoreWrite[] = [];
  return {
    writes,
    async writeAuxiliaryJson(name: string, file: string, value: unknown): Promise<string> {
      const dir = joinPath(root, "store", name);
      await mkdir(dir, { recursive: true });
      const target = joinPath(dir, file);
      await writeFile(target, JSON.stringify(value, null, 2), "utf8");
      writes.push({ name, file, value, target });
      return target;
    },
  };
};

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly operationDirectory: string;
  readonly output: string;
  readonly realOutput: string;
  readonly preparedInputs: Awaited<ReturnType<typeof prepareListingInputs>>;
  readonly input: ExportResourcesInput;
  readonly operation: ExportOperation;
  readonly store: ReturnType<typeof makeStore>;
}

const create = async (options: {
  readonly label: string;
  readonly selection: ExportResourcesInput["selection"];
  readonly directoryInput?: boolean;
  readonly junctionOutput?: boolean;
}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `gdre-mcp-export-op-${options.label}-`));
  const workspace = path.join(root, "workspace");
  const operationDirectory = joinPath(workspace, ".gdre", "operations", "op");
  const inputPath = path.join(root, "fixtures", options.directoryInput === true ? "project" : "pack.pck");
  const realOutput =
    options.junctionOutput === true
      ? joinPath(root, "out-real")
      : joinPath(root, "out");
  const output =
    options.junctionOutput === true ? joinPath(root, "out-alias") : realOutput;
  await mkdir(workspace, { recursive: true });
  await mkdir(operationDirectory, { recursive: true });
  if (options.junctionOutput === true) {
    await mkdir(realOutput, { recursive: true });
    await symlink(realOutput, output, "junction");
  }
  if (options.directoryInput === true) {
    await mkdir(inputPath, { recursive: true });
    await writeFile(path.join(inputPath, "project.godot"), "config", "utf8");
  } else {
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, "pack", "utf8");
  }
  const preparedInputs = await prepareListingInputs(
    workspace,
    { inputs: [{ kind: "path", path: inputPath }] },
    undefined,
    undefined,
    { directoryInspector: benignInspector },
  );
  const input: ExportResourcesInput = {
    inputs: [{ kind: "path", path: inputPath }],
    output,
    selection: options.selection,
  };
  const store = makeStore(root);
  const operation = new ExportOperation({
    workspace,
    operationDirectory,
    input,
    preparedInputs,
    signal: new AbortController().signal,
    preflightScriptPath: joinPath(root, "native", "gdre-export-preflight.gd"),
    directoryInspector: benignInspector,
  });
  await operation.prepareDestination();
  return { root, workspace, operationDirectory, output, realOutput, preparedInputs, input, operation, store };
};

const writePreflight = async (
  operationDirectory: string,
  options: {
    readonly files?: readonly string[];
    readonly imports?: readonly Record<string, unknown>[];
    readonly text?: string;
  } = {},
): Promise<void> => {
  const directory = joinPath(operationDirectory, "export-preflight");
  await mkdir(directory, { recursive: true });
  const payload = {
    schemaVersion: 1,
    ok: true,
    file_count: (options.files ?? files).length,
    import_count: (options.imports ?? [translationImport, scriptImport]).length,
    files: [...(options.files ?? files)],
    imports: [...(options.imports ?? [translationImport, scriptImport])],
  };
  await writeFile(
    exportPreflightEvidencePath(operationDirectory),
    options.text ?? JSON.stringify(payload),
    "utf8",
  );
};

const runEvidence = (): PreflightRunEvidence => ({
  pid: 99,
  exitCode: 0,
  signal: null,
  spawnError: null,
  spawnedAt: "2026-10-22T00:00:00.000Z",
  exitedAt: "2026-10-22T00:00:01.000Z",
  spawnedAtMono: 100,
  exitedAtMono: 200,
  cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
  stdout: {
    bytes: 0,
    text: "",
    truncated: false,
    utf8Valid: true,
    rawPath: "D:/fixtures/stdout.bin",
    textPath: "D:/fixtures/stdout.txt",
    complete: true,
  },
  stderr: {
    bytes: 0,
    text: "",
    truncated: false,
    utf8Valid: true,
    rawPath: "D:/fixtures/stderr.bin",
    textPath: "D:/fixtures/stderr.txt",
    complete: true,
  },
});

const observation = (): ProcessObservation => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutEvidence: {
    rawPath: "D:/fixtures/stdout.bin",
    textPath: "D:/fixtures/stdout.txt",
    complete: true,
    utf8Valid: true,
  },
  stderrEvidence: {
    rawPath: "D:/fixtures/stderr.bin",
    textPath: "D:/fixtures/stderr.txt",
    complete: true,
    utf8Valid: true,
  },
});

const prepare = async (
  fixture: Fixture,
  overrides: {
    readonly processStopped?: boolean;
    readonly run?: Partial<PreflightRunEvidence>;
  } = {},
) =>
  fixture.operation.prepareFromPreflight({
    run: { ...runEvidence(), ...overrides.run },
    observation: observation(),
    processStopped: overrides.processStopped ?? false,
    executable: "D:/runtime/gdre_tools.exe",
    plan: fixture.operation.preflightPlan(),
    environmentProfile: null,
    statusPath: fixture.operation.preflightStatusPath,
    store: fixture.store,
  });

const cleanup = async (fixture: Fixture): Promise<void> => {
  await rm(fixture.root, { recursive: true, force: true });
};

test("preflight evidence derives selection, retains expectations, and enriches evaluation", async () => {
  const fixture = await create({
    label: "ready",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    await writePreflight(fixture.operationDirectory);
    const result = await prepare(fixture);
    assert.deepEqual(result, { ready: true });
    assert.equal(pathIdentity(fixture.operation.effectiveOutput!), pathIdentity(fixture.output));
    assert.deepEqual(fixture.operation.selectedMembers, [
      "res://.godot/imported/translations.en.translation",
      "res://.godot/imported/translations.zh.translation",
    ]);
    const record = fixture.operation.preflightEvidence;
    assert.ok(record !== null);
    assert.ok(record!["expectations"] !== undefined);
    assert.ok(record!["native"] !== undefined);

    const expectationWrite = fixture.store.writes.find(
      (write) => write.file === "export-expectations.json",
    );
    assert.ok(expectationWrite !== undefined);
    const value = expectationWrite!.value as Record<string, unknown>;
    assert.deepEqual(value["selectedMembers"], fixture.operation.selectedMembers);
    assert.equal(value["complete"], true);

    const enriched = fixture.operation.enrichObservation(observation());
    assert.deepEqual(enriched.expectedMembers, files);
    assert.deepEqual(enriched.expectedSelectedMembers, fixture.operation.selectedMembers);
    assert.equal(enriched.effectiveOutput, fixture.operation.effectiveOutput);

    const operationOutput = joinPath(fixture.operationDirectory, "output");
    assert.deepEqual(fixture.operation.inventoryRoots(operationOutput), [
      { path: operationOutput, role: "output" },
    ]);
    fixture.operation.markAttempted();
    assert.deepEqual(fixture.operation.inventoryRoots(operationOutput), [
      { path: operationOutput, role: "output" },
      { path: fixture.operation.effectiveOutput, role: "export-destination" },
    ]);
  } finally {
    await cleanup(fixture);
  }
});

test("no-match member selection is rejected before recovery", async () => {
  const fixture = await create({
    label: "no-match",
    selection: { kind: "members", include: ["res://missing/*.translation"] },
  });
  try {
    await writePreflight(fixture.operationDirectory);
    const result = await prepare(fixture);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "semantic_failed");
    assert.match(result.summary, /no package member|matched no member/iu);
    assert.equal(fixture.store.writes.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

test("an empty native group never falls through to full recovery", async () => {
  const fixture = await create({
    label: "empty-group",
    selection: { kind: "group", group: "translations" },
  });
  try {
    await writePreflight(fixture.operationDirectory, {
      files: ["res://project.godot", "res://main.gdc", "res://main.gd.remap"],
      imports: [scriptImport],
    });
    const result = await prepare(fixture);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "semantic_failed");
    assert.equal(fixture.store.writes.length, 0);
  } finally {
    await cleanup(fixture);
  }
});

test("directory path-qualified filters are rejected as unsupported", async () => {
  const fixture = await create({
    label: "directory",
    directoryInput: true,
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    await writePreflight(fixture.operationDirectory);
    const result = await prepare(fixture);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "unsupported_capability");
  } finally {
    await cleanup(fixture);
  }
});

test("a stopped or failed preflight is not evaluated and starts no recovery", async () => {
  const fixture = await create({
    label: "stopped",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    const result = await prepare(fixture, { processStopped: true });
    assert.deepEqual(result, { ready: false, stopped: true });
    assert.equal(fixture.store.writes.length, 0);
    assert.equal(fixture.operation.preflightEvidence?.["semantic"] instanceof Object, true);
  } finally {
    await cleanup(fixture);
  }
});

test("malformed or unsafe native metadata is rejected before the main launch", async () => {
  const malformed = await create({
    label: "malformed",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    await writePreflight(malformed.operationDirectory, { text: "{not json" });
    const result = await prepare(malformed);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "semantic_unknown");
  } finally {
    await cleanup(malformed);
  }

  const unsafe = await create({
    label: "unsafe",
    selection: { kind: "members", include: ["res://**/*.gdc"] },
  });
  try {
    await writePreflight(unsafe.operationDirectory, {
      files: ["res://../escape.gdc"],
      imports: [
        {
          path: "res://../escape.gdc",
          import_md_path: "res://escape.gd.remap",
          source_file: "res://escape.gd",
          importer: "script_bytecode",
          type: "GDScript",
          dest_files: ["res://../escape.gdc"],
        },
      ],
    });
    const result = await prepare(unsafe);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "path_unsupported");
  } finally {
    await cleanup(unsafe);
  }
});

test("administrative output collisions are rejected before writes", async () => {
  const fixture = await create({
    label: "admin-collision",
    selection: { kind: "members", include: ["res://gdre_export.json"] },
  });
  try {
    await writePreflight(fixture.operationDirectory, {
      files: ["res://gdre_export.json"],
      imports: [scriptImport],
    });
    const result = await prepare(fixture);
    assert.equal(result.ready, false);
    if (result.ready || result.stopped) return;
    if ("interrupted" in result) return;
    assert.equal(result.code, "path_unsupported");
    assert.match(result.summary, /administrative|gdre_export\.json/iu);
  } finally {
    await cleanup(fixture);
  }
});

test("evaluation writes a complete adapter detail report and references it", async () => {
  const fixture = await create({
    label: "evaluate",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    await writePreflight(fixture.operationDirectory);
    assert.deepEqual(await prepare(fixture), { ready: true });
    const output = fixture.operation.effectiveOutput!;
    const csv = joinPath(output, "translations.csv");
    const reportPath = joinPath(output, "gdre_export.json");
    const logPath = joinPath(output, "gdre_export.log");
    await mkdir(output, { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        report_version: 1,
        gdre_version: "v2.8.0-beta.2",
        output_dir: output,
        session_files_total: 1,
        log_file_location: logPath,
        translation_export_message: "",
        had_encryption_error: false,
        decompiled_scripts: [],
        failed_scripts: [],
        unsupported_types: [],
        failed_plugin_cfg_create: [],
        downloaded_plugins: [],
        failed: [],
        not_converted: [],
        success: [{
          import_info: {
            import_md_path: translationImport.import_md_path,
            preferred_import_path: translationImport.path,
          },
          exporter: "Translation",
          saved_path: csv,
          resources_used: translationImport.dest_files,
          extra_info: { missing_keys: 0, total_keys: 4 },
        }],
      }),
      "utf8",
    );
    await writeFile(logPath, "native log", "utf8");
    const hash = "a".repeat(64);
    const entry = (file: string): ArtifactEntry => ({
      path: file,
      role: "export-artifact",
      kind: "file",
      bytes: 10,
      sha256: hash,
      error: null,
    });
    const inventory: ArtifactInventory = {
      entries: [entry(csv), entry(reportPath), entry(logPath)],
      errors: [],
      complete: true,
      stopReason: null,
    };
    const evaluation = await fixture.operation.evaluate(observation(), inventory);
    assert.equal(evaluation.status, "succeeded", JSON.stringify(evaluation));
    assert.equal(evaluation.data?.completeness, "complete");
    const detailWrite = fixture.store.writes.find(
      (write) => write.file === "report.json" && write.name === "export-detail",
    );
    assert.ok(detailWrite !== undefined);
    assert.equal(evaluation.data?.reports.adapter, detailWrite!.target);
    const detail = detailWrite!.value as Record<string, unknown>;
    assert.equal(detail["completeness"], "complete");
    assert.ok(Array.isArray(detail["imports"]));
    assert.ok(Array.isArray(detail["inventory"]));
  } finally {
    await cleanup(fixture);
  }
});

test("inventory interpretation separates administrative evidence and records attempts", async () => {
  const fixture = await create({
    label: "inventory",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
  });
  try {
    await writePreflight(fixture.operationDirectory);
    assert.deepEqual(await prepare(fixture), { ready: true });
    const output = fixture.operation.effectiveOutput!;
    const entry = (file: string): ArtifactEntry => ({
      path: file,
      role: "output",
      kind: "file",
      bytes: 10,
      sha256: "b".repeat(64),
      error: null,
    });
    const interpretation = fixture.operation.interpretInventory({
      entries: [
        entry(joinPath(output, "gdre_export.log")),
        entry(joinPath(output, "gdre_export.json")),
        entry(joinPath(output, "translations.csv")),
        entry(
          joinPath(output, ".godot", "imported", "translations.en.translation"),
        ),
        entry(joinPath(output, "project.godot")),
      ],
      errors: [],
      complete: true,
      stopReason: null,
    });
    assert.deepEqual(
      interpretation.entries.map((item) => item.role),
      [
        "administrative-log",
        "administrative-report",
        "export-artifact",
        "selected-raw",
        "accompanying",
      ],
    );
  } finally {
    await cleanup(fixture);
  }
});

test("junction display output still matches real inventory and selected members", async () => {
  const fixture = await create({
    label: "junction",
    selection: { kind: "members", include: ["res://.godot/imported/*.translation"] },
    junctionOutput: true,
  });
  try {
    await writePreflight(fixture.operationDirectory);
    assert.deepEqual(await prepare(fixture), { ready: true });
    assert.notEqual(pathIdentity(fixture.output), pathIdentity(fixture.realOutput));
    assert.equal(
      pathIdentity(fixture.operation.effectiveOutput!),
      pathIdentity(fixture.output),
    );
    const entry = (file: string): ArtifactEntry => ({
      path: file,
      role: "output",
      kind: "file",
      bytes: 10,
      sha256: "c".repeat(64),
      error: null,
    });
    const interpretation = fixture.operation.interpretInventory({
      entries: [
        entry(joinPath(fixture.realOutput, "gdre_export.log")),
        entry(joinPath(fixture.realOutput, "gdre_export.json")),
        entry(
          joinPath(fixture.realOutput, ".godot", "imported", "translations.en.translation"),
        ),
        entry(joinPath(fixture.realOutput, "project.godot")),
        entry(joinPath(fixture.realOutput, "translations.csv")),
      ],
      errors: [],
      complete: true,
      stopReason: null,
    });
    assert.deepEqual(
      interpretation.entries.map((item) => item.role),
      [
        "administrative-log",
        "administrative-report",
        "selected-raw",
        "accompanying",
        "export-artifact",
      ],
    );
  } finally {
    await cleanup(fixture);
  }
});
