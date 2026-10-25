import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { CommandInvocation } from "../src/command-invocation.js";
import { ConfigError, loadConfig, type LoadedConfig } from "../src/config.js";
import { joinPath } from "../src/paths.js";
import { generateCommandReference } from "../src/reference.js";
import {
  commandRegistry,
  getCommandById,
  getCommandByToolName,
  patchTranslationsCommand,
} from "../src/registry.js";
import {
  operationResultSchema,
  patchTranslationsInputSchema,
  patchTranslationsSemanticDataSchema,
} from "../src/schemas.js";
import {
  PATCH_TRANSLATIONS_ARGV_PREFIX,
  patchTranslationsReportPath,
  patchTranslationsRequestPath,
} from "../src/translation-planning.js";
import type {
  PatchTranslationsInput,
  PatchTranslationMapping,
  VersionInput,
} from "../src/types.js";

const inputs = [{ kind: "path", path: "packs/game 空间.pck" }] as const;
const mappings = [
  { csv: "edits/translations zh.csv", resource: "res://translations.csv" },
  { csv: "D:/fixtures/menu.csv", resource: "res://i18n/menu.csv" },
] as const;
const key = "a1".repeat(32);
const operation = "D:/workspace/.gdre/operations/op";
const script = "D:/godre/native/gdre-patch-translations.gd";

const makeConfig = (overrides: Partial<LoadedConfig> = {}): LoadedConfig => ({
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

test("patch-translations is discoverable with the accepted command set", () => {
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
  assert.equal(getCommandById("patch-translations"), patchTranslationsCommand);
  assert.equal(
    getCommandByToolName("gdre_patch_translations"),
    patchTranslationsCommand,
  );

  const descriptor = patchTranslationsCommand;
  assert.equal(descriptor.id, "patch-translations");
  assert.equal(descriptor.toolName, "gdre_patch_translations");
  assert.equal(descriptor.category, "application");
  assert.equal(descriptor.routing, "application");
  assert.deepEqual(descriptor.cliSpellings, ["--script"]);
  assert.deepEqual(descriptor.aliases, []);
  assert.deepEqual(descriptor.argv, PATCH_TRANSLATIONS_ARGV_PREFIX);
  assert.equal(descriptor.inputSchema, patchTranslationsInputSchema);
  assert.equal(descriptor.outputSchema, operationResultSchema);
  assert.deepEqual(descriptor.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });

  assert.match(generateCommandReference(), /`gdre_patch_translations`/u);
});

test("patch input admits literal packages, ordered mappings, locales, and key", () => {
  const parsed = patchTranslationsInputSchema.safeParse({
    inputs: [...inputs],
    translations: [...mappings],
    output: "patch/out 空间",
    locales: ["zh", "pt-BR", "zh_CN"],
    key: key.toUpperCase(),
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    workspace: "D:/GDRE Work/示例",
    timeoutMs: 600_000,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  if (!parsed.success) return;
  assert.equal(parsed.data.key, key);
  assert.deepEqual(parsed.data.translations, [...mappings]);
  assert.deepEqual(parsed.data.locales, ["zh", "pt-BR", "zh_CN"]);

  const omitted = patchTranslationsInputSchema.safeParse({
    inputs: [...inputs],
    translations: [{ csv: "edits/translations.csv", resource: "res://translations.csv" }],
  });
  assert.equal(omitted.success, true, JSON.stringify(omitted.error?.issues));
  if (!omitted.success) return;
  assert.equal(omitted.data.locales, undefined);
  assert.equal(omitted.data.output, undefined);
});

test("standalone translation map grammar is not narrowed by combined CLI representability", () => {
  const parsed = patchTranslationsInputSchema.safeParse({
    inputs: [...inputs],
    translations: [
      {
        csv: "edits/trans=one.csv",
        resource: "res://i18n/trans'\"lations.csv",
      },
    ],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("patch input rejects unsupported, malformed, and ambiguous mappings", () => {
  const invalid = [
    {},
    { inputs: [...inputs] },
    { inputs: [], translations: [...mappings] },
    { inputs: [...inputs], translations: [] },
    { inputs: [{ kind: "glob", pattern: "packs/*.pck" }], translations: [...mappings] },
    { inputs: [{ kind: "path", path: "packs/*.pck" }], translations: [...mappings] },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://../translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/../translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n//translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n\\translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/*.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: " res://translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [
        { csv: "edits/one.csv", resource: "res://Translations.csv" },
        { csv: "edits/two.csv", resource: "res://translations.csv" },
      ],
    },
    {
      inputs: [...inputs],
      translations: [
        { csv: "edits/same.csv", resource: "res://one.csv" },
        { csv: "edits/same.csv", resource: "res://two.csv" },
      ],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/*.csv", resource: "res://translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/./translations.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/translations\t.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/translations\u007f.csv" }],
    },
    {
      inputs: [...inputs],
      translations: [{ csv: "edits/translations.csv", resource: "res://i18n/translations\u001f.csv" }],
    },
    { inputs: [...inputs], translations: [...mappings], locales: [] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh", "zh"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh CN"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh,en"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["../x"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["a/b"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["a\\b"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["."] },
    { inputs: [...inputs], translations: [...mappings], locales: ["a.b"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["1en"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["en-"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["en--US"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["en_US.UTF-8"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh\u0000"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh\u001f"] },
    { inputs: [...inputs], translations: [...mappings], locales: ["zh\u007f"] },
    { inputs: [...inputs], translations: [...mappings], key: "a".repeat(63) },
    { inputs: [...inputs], translations: [...mappings], output: "out/*" },
    { inputs: [...inputs], translations: [...mappings], translationHints: ["D:/hints.csv"] },
    { inputs: [...inputs], translations: [...mappings], collectResourceStrings: false },
    { inputs: [...inputs], translations: [...mappings], dumpResourceStrings: true },
    { inputs: [...inputs], translations: [...mappings], checksum: "skip" },
    { inputs: [...inputs], translations: [...mappings], unexpected: true },
  ] as const;

  for (const value of invalid) {
    assert.equal(
      patchTranslationsInputSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
});

test("patch schema and descriptor metadata agree field by field", () => {
  const shape = patchTranslationsInputSchema.shape;
  const descriptorNames = patchTranslationsCommand.parameterDescriptors
    .map((parameter) => parameter.name)
    .sort();
  assert.deepEqual(Object.keys(shape).sort(), descriptorNames);

  const byName = Object.fromEntries(
    patchTranslationsCommand.parameterDescriptors.map((parameter) => [
      parameter.name,
      parameter,
    ]),
  );
  const expectedTypes: Record<string, string> = {
    inputs: "array",
    translations: "array",
    output: "string",
    locales: "array",
    key: "string",
    session: "array",
    workspace: "string",
    timeoutMs: "integer",
  };
  for (const [name, type] of Object.entries(expectedTypes)) {
    assert.equal(byName[name]?.type, type, name);
    const field = shape[name as keyof typeof shape];
    assert.ok(field !== undefined, name);
    assert.equal(field.isOptional(), !byName[name]?.required, name);
  }
  assert.equal(byName.inputs?.required, true);
  assert.equal(byName.translations?.required, true);
  assert.equal(byName.key?.sensitivity, "secret");
  assert.equal(byName.inputs?.pathRole, "input");
  assert.equal(byName.translations?.pathRole, "input");
  assert.equal(byName.output?.pathRole, "output");
  assert.equal(byName.workspace?.pathRole, "workspace");
  for (const parameter of patchTranslationsCommand.parameterDescriptors) {
    assert.ok(parameter.evidence.length > 0, parameter.name);
    assert.ok(parameter.description.length > 0, parameter.name);
    assert.ok(
      parameter.evidence.every(
        (reference) => !/\.scratch|\\Temp\/|C:\\Users/iu.test(reference.source),
      ),
      parameter.name,
    );
  }
  assert.ok(
    patchTranslationsCommand.evidence.every(
      (reference) => !/\.scratch|\\Temp\/|C:\\Users/iu.test(reference.source),
    ),
  );

  const jsonSchema = z.toJSONSchema(patchTranslationsInputSchema, {
    io: "input",
  }) as {
    readonly required?: readonly string[];
  };
  assert.ok(jsonSchema.required?.includes("inputs"));
  assert.ok(jsonSchema.required?.includes("translations"));
});

test("patch-translations defaults accept only timeoutMs and ordered session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-patch-"));
  const configPath = path.join(root, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceRoot: root,
        defaults: {
          "patch-translations": {
            timeoutMs: 45_000,
            session: [{ kind: "multithreading", disabled: true }],
          },
        },
      }),
      "utf8",
    );
    const config = await loadConfig(root, { GDRE_MCP_CONFIG: configPath });
    assert.deepEqual(config.defaults["patch-translations"], {
      timeoutMs: 45_000,
      session: [{ kind: "multithreading", disabled: true }],
    });

    for (const invalidDefaults of [
      { "patch-translations": { inputs: [{ kind: "path", path: "pack.pck" }] } },
      { "patch-translations": { translations: [{ csv: "a.csv", resource: "res://a.csv" }] } },
      { "patch-translations": { output: "patch/out" } },
      { "patch-translations": { locales: ["zh"] } },
      { "patch-translations": { key: "a".repeat(64) } },
      { "patch-translations": { session: [{ kind: "setting", key: "x", value: true }] } },
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

test("patch invocation records defaults, mapping provenance, and key redaction", () => {
  const config = makeConfig({
    defaults: {
      "patch-translations": {
        timeoutMs: 45_000,
        session: [{ kind: "multithreading", disabled: true }],
      },
    },
  });
  const requested: PatchTranslationsInput = {
    inputs: [...inputs],
    translations: [...mappings],
    output: "patch/out",
    locales: ["zh"],
    key,
  };
  const invocation = new CommandInvocation(
    patchTranslationsCommand,
    requested,
    config,
  );
  assert.equal(invocation.operationLabel, "GDRE patch translations");
  assert.equal(invocation.settingsRejection, null);
  assert.equal(invocation.knownKey, key);
  assert.equal(invocation.redactText?.(`--key=${key}`), "--key=<redacted>");
  assert.deepEqual(invocation.session, [
    { kind: "multithreading", disabled: true },
  ]);
  assert.deepEqual(
    (invocation.input as PatchTranslationsInput).session,
    [{ kind: "multithreading", disabled: true }],
  );
  assert.equal((invocation.input as PatchTranslationsInput).timeoutMs, 45_000);

  const effective = invocation.effectiveParameters(
    {
      workspace: "D:/workspace",
      resolvedInputs: ["D:/fixtures/game.pck"],
      resolvedTranslations: [
        { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
      ],
      effectiveOutput: "D:/patch/out",
    },
    45_000,
  );
  assert.deepEqual(effective, {
    workspace: "D:/workspace",
    session: [{ kind: "multithreading", disabled: true }],
    inputs: [{ kind: "path", path: "D:/fixtures/game.pck" }],
    output: "D:/patch/out",
    translations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
    ],
    locales: ["zh"],
    localeSelection: "explicit",
    key: { redacted: true },
    timeoutMs: 45_000,
  });
  assert.deepEqual(invocation.parameterSources, {
    workspace: "config",
    timeoutMs: "config",
    inputs: "call",
    translations: "call",
    session: "config",
    output: "call",
    locales: "call",
    key: "call",
  });

  const omitted = new CommandInvocation(
    patchTranslationsCommand,
    {
      inputs: [...inputs],
      translations: [...mappings],
      session: [],
    },
    config,
  );
  assert.deepEqual(omitted.session, []);
  const omittedEffective = omitted.effectiveParameters({
    workspace: "D:/workspace",
    resolvedInputs: ["D:/fixtures/game.pck"],
    resolvedTranslations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
    ],
    effectiveOutput: "D:/out",
  });
  assert.deepEqual(omittedEffective.locales, []);
  assert.equal(omittedEffective.localeSelection, "new-locales-only");
  assert.equal("key" in omittedEffective, false);
  assert.deepEqual(omitted.parameterSources, {
    workspace: "config",
    timeoutMs: "config",
    inputs: "call",
    translations: "call",
    session: "call",
    output: "builtin",
    locales: "builtin",
  });

  const withSettings = new CommandInvocation(
    patchTranslationsCommand,
    requested,
    makeConfig({
      settings: [
        { key: "General/download_plugins", type: "boolean", value: false },
      ],
    }),
  );
  assert.match(withSettings.settingsRejection ?? "", /gdre_patch_translations/u);
});

test("patch planner emits one fixed trusted native script launch", () => {
  const validation = patchTranslationsCommand.validate({
    inputs: [...inputs],
    translations: [...mappings],
    output: "patch/out",
    locales: ["zh"],
    key,
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    timeoutMs: 45_000,
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const requestPath = patchTranslationsRequestPath(operation);
  const reportPath = patchTranslationsReportPath(operation);
  const plan = patchTranslationsCommand.plan(validation.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/game.pck"],
    resolvedTranslations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
      { csv: "D:/fixtures/menu.csv", resource: "res://i18n/menu.csv" },
    ],
    effectiveOutput: "D:/patch/out",
    patchTranslationsScriptPath: script,
  });
  assert.deepEqual(plan.argv, [
    ...PATCH_TRANSLATIONS_ARGV_PREFIX,
    script,
    "--",
    requestPath,
    reportPath,
    `--key=${key}`,
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, 45_000);
  assert.deepEqual(plan.effects, {
    reads: [
      script,
      "D:/fixtures/game.pck",
      "D:/fixtures/translations.csv",
      "D:/fixtures/menu.csv",
    ],
    writes: ["D:/patch/out", requestPath, reportPath],
    network: false,
    codeExecution: false,
    unknownScope: false,
  });
  assert.equal(
    plan.argv.some(
      (token) =>
        token.startsWith("--disable-multithreading") ||
        token.startsWith("--patch-translations") ||
        token.startsWith("--pck="),
    ),
    false,
  );
  assert.equal(requestPath, joinPath(operation, "translation-patch", "request.json"));
  assert.equal(reportPath, joinPath(operation, "translation-patch", "report.json"));

  const minimal = patchTranslationsCommand.validate({
    inputs: [...inputs],
    translations: [mappings[0]],
  });
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  const minimalPlan = patchTranslationsCommand.plan(minimal.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/game.pck"],
    resolvedTranslations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
    ],
    effectiveOutput: "D:/out",
    patchTranslationsScriptPath: script,
  });
  assert.equal(
    minimalPlan.argv.some((token) => token.startsWith("--key=")),
    false,
  );
});

test("patch planner refuses missing or contradictory resolved context", () => {
  const validation = patchTranslationsCommand.validate({
    inputs: [...inputs],
    translations: [...mappings],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const base = {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/game.pck"],
    resolvedTranslations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://translations.csv" },
      { csv: "D:/fixtures/menu.csv", resource: "res://i18n/menu.csv" },
    ] as readonly PatchTranslationMapping[],
    effectiveOutput: "D:/out",
    patchTranslationsScriptPath: script,
  };

  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        patchTranslationsScriptPath: undefined,
      }),
    /fixed patch translations script path/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        patchTranslationsScriptPath: "native/gdre-patch-translations.gd",
      }),
    /absolute/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        resolvedInputs: undefined,
      }),
    /resolved package\/project inputs/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        resolvedTranslations: undefined,
      }),
    /resolved translation mappings/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        resolvedTranslations: [base.resolvedTranslations[0]!],
      }),
    /one resolved CSV\/resource mapping per translation/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        resolvedTranslations: [
          { csv: "D:/fixtures/translations.csv", resource: "res://other.csv" },
          base.resolvedTranslations[1]!,
        ],
      }),
    /logical resource does not match/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        resolvedTranslations: [
          { csv: "fixtures/translations.csv", resource: "res://translations.csv" },
          base.resolvedTranslations[1]!,
        ],
      }),
    /resolved CSV path must be an absolute/u,
  );
  assert.throws(
    () =>
      patchTranslationsCommand.plan(validation.value, {
        ...base,
        effectiveOutput: undefined,
      }),
    /effective translation output/u,
  );
});

test("patch semantic data is bounded and descriptor-only evaluation stays unknown", () => {
  const data = {
    completeness: "partial" as const,
    outputPath: "D:/patch/out",
    localeSelection: { mode: "explicit" as const, locales: ["zh"] },
    counts: {
      mappings: 2,
      outputs: 1,
      verifiedResources: 1,
      verifiedTexts: 3,
      unverifiedFiles: 0,
      preparedCsvs: 1,
    },
    reports: {
      request: "D:/workspace/.gdre/operations/op/translation-patch/request.json",
      native: "D:/workspace/.gdre/operations/op/translation-patch/report.json",
    },
    preparedCsvs: {
      items: [
        {
          original: "D:/fixtures/translations.csv",
          prepared: "D:/workspace/.gdre/operations/op/translation-patch/translations.csv",
          bomNormalized: true,
        },
      ],
      truncated: false,
    },
    samples: {
      mappings: ["res://translations.csv -> D:/fixtures/translations.csv"],
      outputs: ["D:/patch/out/translations.translation"],
      unverifiedFiles: [],
      truncated: false,
    },
    diagnostics: ["One mapping remains unverified."],
  };
  assert.equal(
    patchTranslationsSemanticDataSchema.safeParse(data).success,
    true,
    JSON.stringify(patchTranslationsSemanticDataSchema.safeParse(data).error?.issues),
  );
  assert.equal(
    patchTranslationsSemanticDataSchema.safeParse({
      ...data,
      completeness: "everything",
    }).success,
    false,
  );
  assert.equal(
    patchTranslationsSemanticDataSchema.safeParse({ completeness: "complete" }).success,
    false,
  );

  const evaluation = patchTranslationsCommand.evaluate({
    exitCode: 0,
    signal: null,
    stdout: "translation patch completed\n",
    stderr: "",
    stdoutTruncated: false,
  });
  assert.equal(evaluation.status, "unknown");
  assert.equal(evaluation.data, null);
  assert.equal(evaluation.rule, "gdre-patch-translations-v1");
  assert.ok(
    evaluation.evidence.every((entry) => !/succeeded|verified/u.test(entry)),
  );
});

test("shared result envelope accepts patch data only for patch-translations", () => {
  const stream = {
    bytes: 0,
    text: "",
    truncated: false,
    utf8Valid: true,
    rawPath: "D:/workspace/.gdre/operations/op/stdout.bin",
    textPath: "D:/workspace/.gdre/operations/op/stdout.txt",
    complete: true,
  };
  const patchData = {
    completeness: "unknown" as const,
    outputPath: "D:/patch/out",
    localeSelection: { mode: "new-locales-only" as const, locales: [] },
    counts: {
      mappings: 1,
      outputs: 0,
      verifiedResources: 0,
      verifiedTexts: 0,
      unverifiedFiles: 0,
      preparedCsvs: 0,
    },
    reports: { request: null, native: null },
    preparedCsvs: { items: [], truncated: false },
    samples: { mappings: [], outputs: [], unverifiedFiles: [], truncated: false },
    diagnostics: [],
  };
  const result = {
    schemaVersion: 1 as const,
    operationId: "550e8400-e29b-41d4-a716-446655440000",
    commandId: "patch-translations" as const,
    success: false,
    status: "failed" as const,
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
      probe: { exitCode: 1, signal: null, stdout: stream, stderr: stream, error: null },
      warnings: [],
    },
    timing: {
      requestedAt: "2026-10-18T10:00:00.000Z",
      queuedAt: null,
      startedAt: null,
      processExitedAt: null,
      finishedAt: "2026-10-18T10:00:00.000Z",
      queueMs: 0,
      processMs: null,
      totalMs: 0,
    },
    process: { pid: null, exitCode: null, signal: null, spawnError: null },
    semantic: {
      status: "unknown" as const,
      rule: "gdre-patch-translations-v1",
      summary: "GDRE translation patch evidence was not evaluated.",
      evidence: [],
      data: null,
    },
    paths: {
      workspace: "D:/workspace",
      operation,
      output: joinPath(operation, "output"),
      effectiveDestination: "D:/patch/out",
      manifest: joinPath(operation, "manifest.json"),
      artifactInventory: joinPath(operation, "artifacts.json"),
    },
    stdout: stream,
    stderr: stream,
    artifacts: { count: 0, items: [], truncated: false, complete: true },
    cleanup: { state: "not_needed" as const, trigger: null, actions: [], error: null },
    persistence: { state: "complete" as const, error: null },
    warnings: [],
  };
  assert.equal(
    operationResultSchema.safeParse(result).success,
    true,
    JSON.stringify(operationResultSchema.safeParse(result).error?.issues),
  );

  assert.equal(
    operationResultSchema.safeParse({
      ...result,
      semantic: { ...result.semantic, data: patchData },
    }).success,
    true,
    JSON.stringify(
      operationResultSchema.safeParse({
        ...result,
        semantic: { ...result.semantic, data: patchData },
      }).error?.issues,
    ),
  );

  // Patch data must not satisfy another command's discriminator.
  assert.equal(
    operationResultSchema.safeParse({
      ...result,
      commandId: "export-resources",
      semantic: { ...result.semantic, data: patchData },
    }).success,
    false,
  );

  assert.equal(
    operationResultSchema.safeParse({
      ...result,
      commandId: "extract",
      semantic: { ...result.semantic, data: patchData },
    }).success,
    false,
  );

  const version: VersionInput = { timeoutMs: 1_000 };
  assert.equal(patchTranslationsCommand.validate(version).ok, false);
});
