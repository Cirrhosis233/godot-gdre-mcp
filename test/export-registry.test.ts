import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { CommandInvocation } from "../src/command-invocation.js";
import { ConfigError, loadConfig, type LoadedConfig } from "../src/config.js";
import { EXPORT_ARGV_PREFIX } from "../src/export-planning.js";
import {
  exportResourcesInputSchema,
  exportSemanticDataSchema,
  operationResultSchema,
} from "../src/schemas.js";
import {
  commandRegistry,
  exportResourcesCommand,
  getCommandById,
  getCommandByToolName,
} from "../src/registry.js";
import { generateCommandReference } from "../src/reference.js";
import type { ExportResourcesInput, VersionInput } from "../src/types.js";

const inputs = [{ kind: "path", path: "packs/pack 空间.pck" }] as const;

const makeConfig = (
  overrides: Partial<LoadedConfig> = {},
): LoadedConfig => ({
  installationRoot: "D:/godre",
  configFile: null,
  workspaceRoot: "D:/workspace",
  runtimeDirectory: "D:/godre/vendor/GDRE_tools",
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults: {},
  settings: [],
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: "builtin",
    settings: "builtin",
  },
  ...overrides,
});

test("export-resources is discoverable only with explicit selection", () => {
  assert.equal(commandRegistry.length, 6);
  assert.deepEqual(
    commandRegistry.map((command) => command.id),
    [
      "version",
      "list-files",
      "extract",
      "export-resources",
      "patch-translations",
      "pck-patch",
    ],
  );
  assert.equal(getCommandById("export-resources"), exportResourcesCommand);
  assert.equal(
    getCommandByToolName("gdre_export_resources"),
    exportResourcesCommand,
  );

  const descriptor = exportResourcesCommand;
  assert.equal(descriptor.id, "export-resources");
  assert.equal(descriptor.toolName, "gdre_export_resources");
  assert.equal(descriptor.category, "application");
  assert.equal(descriptor.routing, "application");
  assert.deepEqual(descriptor.cliSpellings, ["--recover"]);
  assert.deepEqual(descriptor.aliases, []);
  assert.deepEqual(descriptor.argv, EXPORT_ARGV_PREFIX);
  assert.equal(descriptor.inputSchema, exportResourcesInputSchema);
  assert.equal(descriptor.outputSchema, operationResultSchema);
  assert.deepEqual(descriptor.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(descriptor.validate({ inputs: [...inputs] }).ok, false);
  assert.equal(
    descriptor.validate({
      inputs: [...inputs],
      selection: { kind: "group", group: "translations" },
    }).ok,
    true,
  );

  assert.match(generateCommandReference(), /`gdre_export_resources`/u);
});

test("export schema and descriptor metadata agree field by field", () => {
  const shape = exportResourcesInputSchema.shape;
  const descriptorNames = exportResourcesCommand.parameterDescriptors
    .map((parameter) => parameter.name)
    .sort();
  assert.deepEqual(Object.keys(shape).sort(), descriptorNames);

  const byName = Object.fromEntries(
    exportResourcesCommand.parameterDescriptors.map((parameter) => [
      parameter.name,
      parameter,
    ]),
  );
  const expectedTypes: Record<string, string> = {
    inputs: "array",
    output: "string",
    selection: "object",
    session: "array",
    translationHints: "array",
    collectResourceStrings: "boolean",
    dumpResourceStrings: "boolean",
    workspace: "string",
    timeoutMs: "integer",
  };
  for (const [name, type] of Object.entries(expectedTypes)) {
    assert.equal(byName[name]?.type, type, name);
    const field = shape[name as keyof typeof shape];
    assert.ok(field !== undefined, name);
    assert.equal(field.isOptional(), !byName[name]?.required, name);
  }
  assert.equal(byName.selection?.required, true);
  assert.equal(byName.inputs?.required, true);
  assert.equal(byName.selection?.pathRole, "none");
  assert.equal(byName.inputs?.pathRole, "input");
  assert.equal(byName.translationHints?.pathRole, "input");
  assert.equal(byName.output?.pathRole, "output");
  for (const parameter of exportResourcesCommand.parameterDescriptors) {
    assert.equal(parameter.sensitivity, "public");
    assert.ok(parameter.evidence.length > 0, parameter.name);
    assert.ok(parameter.description.length > 0, parameter.name);
    assert.ok(
      parameter.evidence.every(
        (reference) =>
          !/\.scratch|\\Temp\/|C:\\Users/iu.test(reference.source),
      ),
      parameter.name,
    );
  }
  assert.ok(
    exportResourcesCommand.evidence.every(
      (reference) =>
        !/\.scratch|\\Temp\/|C:\\Users/iu.test(reference.source),
    ),
  );
  assert.ok(
    exportResourcesCommand.coverage.constraints.some((constraint) =>
      /selection/u.test(constraint),
    ),
  );

  const jsonSchema = z.toJSONSchema(exportResourcesInputSchema) as {
    readonly required?: readonly string[];
  };
  assert.ok(jsonSchema.required?.includes("selection"));
  assert.ok(jsonSchema.required?.includes("inputs"));
});

test("export input remains strict and rejects unsupported intent", () => {
  const accepted = exportResourcesInputSchema.safeParse({
    inputs: [...inputs],
    output: "exports/out 空间",
    selection: {
      kind: "members",
      include: ["res://**/*.gdc", "*.translation"],
      exclude: ["res://addons/**"],
    },
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    translationHints: ["D:/fixtures/hints.csv"],
    collectResourceStrings: false,
    dumpResourceStrings: true,
    workspace: "D:/GDRE Work/示例",
    timeoutMs: 600_000,
  });
  assert.equal(accepted.success, true, JSON.stringify(accepted.error?.issues));

  for (const invalid of [
    {},
    { selection: { kind: "group", group: "scripts" } },
    { inputs: [] , selection: { kind: "group", group: "scripts" } },
    { inputs: [...inputs] },
    { inputs: [...inputs], selection: { kind: "members", include: [] } },
    { inputs: [...inputs], selection: { kind: "members", exclude: ["res://*.tmp"] } },
    { inputs: [...inputs], selection: { kind: "group", group: "all" } },
    { inputs: [...inputs], selection: { kind: "members", include: ["res://*.gd"] }, key: "a".repeat(64) },
    { inputs: [...inputs], selection: { kind: "members", include: ["res://*.gd"] }, checksum: "skip" },
    { inputs: [...inputs], selection: { kind: "members", include: ["res://*.gd"] }, unexpected: true },
    { inputs: [...inputs], selection: { kind: "members", include: ["../secret.gd"] } },
    { inputs: [...inputs], selection: { kind: "members", include: ["res://[a].gd"] } },
    { inputs: [...inputs], selection: { kind: "group", group: "scripts" }, translationHints: ["D:/fixtures/*.csv"] },
    { inputs: [...inputs], selection: { kind: "group", group: "scripts" }, collectResourceStrings: "yes" },
  ]) {
    assert.equal(
      exportResourcesInputSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("export descriptor plans the actual filtered recovery argv from resolved context", () => {
  const validation = exportResourcesCommand.validate({
    inputs: [...inputs],
    output: "exports/out",
    selection: {
      kind: "members",
      include: ["res://main.gdc", "res://.godot/imported/*.translation"],
      exclude: ["res://.godot/imported/*zh*"],
    },
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    translationHints: ["fixtures/hints.csv"],
    collectResourceStrings: false,
    dumpResourceStrings: true,
    timeoutMs: 45_000,
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const plan = exportResourcesCommand.plan(validation.value, {
    workspace: "D:/GDRE Work/示例",
    operationDirectory: "D:/operations/op",
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/GDRE Work/exports/out",
    resolvedHints: ["D:/fixtures/hints.csv"],
  });
  assert.deepEqual(plan.argv, [
    ...EXPORT_ARGV_PREFIX,
    "--disable-multithreading=true",
    "--disable-multithreading=false",
    "--recover=D:/fixtures/one.pck",
    "--output=D:/GDRE Work/exports/out",
    "--include=res://main.gdc",
    "--include=res://.godot/imported/*.translation",
    "--exclude=res://.godot/imported/*zh*",
    "--translation-hint=D:/fixtures/hints.csv",
    "--skip-loading-resource-strings",
    "--dump-resource-strings",
    "--setting=write_json_report=true",
  ]);
  assert.equal(plan.cwd, "D:/operations/op");
  assert.equal(plan.timeoutMs, 45_000);
  assert.deepEqual(plan.effects.reads, [
    "D:/fixtures/one.pck",
    "D:/fixtures/hints.csv",
  ]);
  assert.deepEqual(plan.effects.writes, ["D:/GDRE Work/exports/out"]);
  assert.equal(
    plan.argv.some((token) => token.startsWith("--key") || token.includes("checksum")),
    false,
  );

  const minimal = exportResourcesCommand.validate({
    inputs: [...inputs],
    selection: { kind: "group", group: "scripts" },
  });
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  const minimalPlan = exportResourcesCommand.plan(minimal.value, {
    workspace: "D:/workspace",
    operationDirectory: "D:/operations/op",
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  });
  assert.deepEqual(minimalPlan.argv, [
    ...EXPORT_ARGV_PREFIX,
    "--recover=D:/fixtures/one.pck",
    "--output=D:/out",
    "--scripts-only",
    "--setting=write_json_report=true",
  ]);
  assert.equal(
    minimalPlan.argv.some(
      (token) =>
        token.startsWith("--translation-hint=") ||
        token.startsWith("--skip-loading-resource-strings") ||
        token.startsWith("--dump-resource-strings"),
    ),
    false,
  );
});

test("export planning requires resolved inputs, destination, and requested hint paths", () => {
  const validation = exportResourcesCommand.validate({
    inputs: [...inputs],
    selection: { kind: "members", include: ["res://*.gdc"] },
    translationHints: ["fixtures/hints.csv"],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const base = {
    workspace: "D:/workspace",
    operationDirectory: "D:/operations/op",
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  };

  assert.throws(
    () =>
      exportResourcesCommand.plan(validation.value, {
        ...base,
        resolvedInputs: undefined,
      }),
    /resolved export inputs/u,
  );
  assert.throws(
    () =>
      exportResourcesCommand.plan(validation.value, {
        ...base,
        effectiveOutput: undefined,
      }),
    /effective export output/u,
  );
  assert.throws(
    () => exportResourcesCommand.plan(validation.value, base),
    /resolved export hint paths/u,
  );

  const plan = exportResourcesCommand.plan(validation.value, {
    ...base,
    resolvedHints: ["D:/fixtures/hints.csv"],
  });
  assert.ok(plan.argv.includes("--translation-hint=D:/fixtures/hints.csv"));
});

test("export defaults accept only timeoutMs and ordered session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-export-"));
  const configPath = path.join(root, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceRoot: root,
        defaults: {
          "export-resources": {
            timeoutMs: 45_000,
            session: [{ kind: "multithreading", disabled: true }],
          },
        },
      }),
      "utf8",
    );
    const config = await loadConfig(root, { GDRE_MCP_CONFIG: configPath });
    assert.deepEqual(config.defaults["export-resources"], {
      timeoutMs: 45_000,
      session: [{ kind: "multithreading", disabled: true }],
    });

    for (const invalidDefaults of [
      { "export-resources": { inputs: [{ kind: "path", path: "pack.pck" }] } },
      { "export-resources": { output: "exports/out" } },
      { "export-resources": { selection: { kind: "group", group: "scripts" } } },
      { "export-resources": { include: ["res://*"] } },
      { "export-resources": { translationHints: ["D:/hints.csv"] } },
      { "export-resources": { collectResourceStrings: false } },
      { "export-resources": { dumpResourceStrings: true } },
      { "export-resources": { key: "a".repeat(64) } },
      { "export-resources": { checksum: "skip" } },
      { "export-resources": { session: [{ kind: "setting", key: "x", value: true }] } },
    ]) {
      await writeFile(
        configPath,
        JSON.stringify({ workspaceRoot: root, defaults: invalidDefaults }),
        "utf8",
      );
      await assert.rejects(
        loadConfig(root, { GDRE_MCP_CONFIG: configPath }),
        ConfigError,
        JSON.stringify(invalidDefaults),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export invocation records effective defaults and resolved hint provenance", () => {
  const config = makeConfig({
    defaults: {
      "export-resources": {
        timeoutMs: 45_000,
        session: [{ kind: "multithreading", disabled: true }],
      },
    },
  });
  const requested: ExportResourcesInput = {
    inputs: [...inputs],
    selection: { kind: "members", include: ["res://main.gdc"] },
    translationHints: ["fixtures/hints.csv"],
  };
  const invocation = new CommandInvocation(exportResourcesCommand, requested, config);
  assert.equal(invocation.operationLabel, "GDRE export resources");
  assert.equal(invocation.settingsRejection, null);
  assert.deepEqual(invocation.session, [
    { kind: "multithreading", disabled: true },
  ]);
  assert.deepEqual(
    (invocation.input as ExportResourcesInput).session,
    [{ kind: "multithreading", disabled: true }],
  );
  assert.equal((invocation.input as ExportResourcesInput).timeoutMs, 45_000);

  const effective = invocation.effectiveParameters(
    {
      workspace: "D:/workspace",
      resolvedInputs: ["D:/fixtures/one.pck"],
      effectiveOutput: "D:/GDRE Work/exports/out",
      resolvedHints: ["D:/fixtures/hints.csv"],
    },
    45_000,
  );
  assert.deepEqual(effective, {
    workspace: "D:/workspace",
    session: [{ kind: "multithreading", disabled: true }],
    inputs: [{ kind: "path", path: "D:/fixtures/one.pck" }],
    output: "D:/GDRE Work/exports/out",
    translationHints: [{ kind: "path", path: "D:/fixtures/hints.csv" }],
    selection: { kind: "members", include: ["res://main.gdc"] },
    collectResourceStrings: true,
    dumpResourceStrings: false,
    timeoutMs: 45_000,
  });
  assert.deepEqual(invocation.parameterSources, {
    workspace: "config",
    timeoutMs: "config",
    inputs: "call",
    session: "config",
    output: "builtin",
    selection: "call",
    translationHints: "call",
    collectResourceStrings: "builtin",
    dumpResourceStrings: "builtin",
  });

  const cleared = new CommandInvocation(
    exportResourcesCommand,
    {
      inputs: [...inputs],
      selection: { kind: "group", group: "scripts" },
      session: [],
      collectResourceStrings: false,
      dumpResourceStrings: true,
    },
    config,
  );
  assert.deepEqual(cleared.session, []);
  assert.deepEqual(cleared.parameterSources, {
    workspace: "config",
    timeoutMs: "config",
    inputs: "call",
    session: "call",
    output: "builtin",
    selection: "call",
    translationHints: "builtin",
    collectResourceStrings: "call",
    dumpResourceStrings: "call",
  });
  const clearedEffective = cleared.effectiveParameters({
    workspace: "D:/workspace",
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
    resolvedHints: [],
  });
  assert.deepEqual(clearedEffective.translationHints, []);
  assert.equal(clearedEffective.collectResourceStrings, false);
  assert.equal(clearedEffective.dumpResourceStrings, true);

  const withSettings = new CommandInvocation(
    exportResourcesCommand,
    requested,
    makeConfig({
      settings: [
        { key: "General/download_plugins", type: "boolean", value: false },
      ],
    }),
  );
  assert.match(withSettings.settingsRejection ?? "", /gdre_export_resources/u);
});

const stream = {
  bytes: 0,
  text: "",
  truncated: false,
  utf8Valid: true,
  rawPath: "D:/workspace/.gdre/operations/op/stdout.bin",
  textPath: "D:/workspace/.gdre/operations/op/stdout.txt",
  complete: true,
};

const successfulExportResult = {
  schemaVersion: 1 as const,
  operationId: "550e8400-e29b-41d4-a716-446655440000",
  commandId: "export-resources" as const,
  success: true,
  status: "succeeded" as const,
  error: null,
  runtime: {
    health: "ready" as const,
    registryVersion: "2.8.0-beta.2",
    targetVersion: "2.8.0-beta.2",
    actualVersion: "2.8.0-beta.2",
    comparison: "match" as const,
    executable: "D:/godre/vendor/GDRE_tools/gdre_tools.exe",
    companions: [
      { path: "D:/godre/vendor/GDRE_tools/gdre_tools.exe", present: true, sha256: null },
      { path: "D:/godre/vendor/GDRE_tools/gdre_tools.pck", present: true, sha256: null },
      { path: "D:/godre/vendor/GDRE_tools/GodotMonoDecompNativeAOT.dll", present: true, sha256: null },
    ],
    exeSha256: null,
    baselineHashesMatch: null,
    checkedAt: "2026-10-18T10:00:00.000Z",
    evidencePath: null,
    probe: {
      exitCode: 1,
      signal: null,
      stdout: stream,
      stderr: stream,
      error: null,
    },
    warnings: [],
  },
  timing: {
    requestedAt: "2026-10-18T10:00:00.000Z",
    queuedAt: "2026-10-18T10:00:00.010Z",
    startedAt: "2026-10-18T10:00:00.020Z",
    processExitedAt: "2026-10-18T10:00:00.120Z",
    finishedAt: "2026-10-18T10:00:00.130Z",
    queueMs: 10,
    processMs: 100,
    totalMs: 130,
  },
  process: { pid: 1234, exitCode: 0, signal: null, spawnError: null },
  semantic: {
    status: "succeeded" as const,
    rule: "gdre-export-resources-v1",
    summary: "GDRE exported the selected resources.",
    evidence: [],
    data: {
      completeness: "complete" as const,
      outputPath: "D:/GDRE Work/exports/out",
      selection: { kind: "members" as const, group: null },
      counts: {
        completeMembers: 2,
        selectedMembers: 1,
        nativeImports: 1,
        exportSuccess: 1,
        exportFailed: 0,
        exportUnsupported: 0,
        unverifiedSuccess: 0,
        unaccountedImports: 0,
        unmappedMembers: 0,
        missingKeys: 0,
        totalKeys: 4,
      },
      artifactRoles: {
        editableExports: 1,
        unverifiedExports: 0,
        rawOrUnmappedMembers: 0,
        accompanying: 1,
        administrative: 2,
      },
      reports: {
        native: "D:/GDRE Work/exports/out/gdre_export.json",
        nativeLog: "D:/GDRE Work/exports/out/gdre_export.log",
        adapter: "D:/workspace/.gdre/operations/op/export-detail/report.json",
      },
      sideEffects: [],
      diagnostics: [],
      previews: { editableExports: ["D:/out/translations.csv"], failed: [], unsupported: [] },
    },
  },
  paths: {
    workspace: "D:/workspace",
    operation: "D:/workspace/.gdre/operations/op",
    output: "D:/workspace/.gdre/operations/op/output",
    effectiveDestination: "D:/GDRE Work/exports/out",
    manifest: "D:/workspace/.gdre/operations/op/manifest.json",
    artifactInventory: "D:/workspace/.gdre/operations/op/artifacts.json",
  },
  stdout: stream,
  stderr: stream,
  artifacts: { count: 3, items: [], truncated: false, complete: true },
  cleanup: { state: "confirmed" as const, trigger: null, actions: [], error: null },
  persistence: { state: "complete" as const, error: null },
  warnings: [],
};

test("export output uses the shared envelope with typed export data", () => {
  const parsed = operationResultSchema.safeParse(successfulExportResult);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(
    exportSemanticDataSchema.safeParse(successfulExportResult.semantic.data).success,
    true,
  );
  assert.equal(exportResourcesCommand.outputSchema, operationResultSchema);
  assert.equal(
    exportResourcesCommand.outputSchema.safeParse(successfulExportResult).success,
    true,
  );

  for (const commandId of ["version", "list-files", "extract"] as const) {
    assert.equal(
      operationResultSchema.safeParse({
        ...successfulExportResult,
        commandId,
      }).success,
      false,
      commandId,
    );
  }
  assert.equal(
    operationResultSchema.safeParse({
      ...successfulExportResult,
      semantic: { ...successfulExportResult.semantic, data: null },
    }).success,
    true,
  );
  assert.equal(
    exportSemanticDataSchema.safeParse({
      ...successfulExportResult.semantic.data,
      completeness: "everything",
    }).success,
    false,
  );
});

test("version input still excludes export selection fields", () => {
  const version: VersionInput = { timeoutMs: 1_000 };
  assert.deepEqual(exportResourcesCommand.validate(version).ok, false);
});
