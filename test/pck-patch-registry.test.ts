import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { ConfigError, loadConfig, type LoadedConfig } from "../src/config.js";
import { CommandInvocation } from "../src/command-invocation.js";
import {
  PCK_PATCH_ARGV_PREFIX,
  buildPckPatchPlan,
} from "../src/pck-patch-planning.js";
import { generateCommandReference } from "../src/reference.js";
import {
  commandRegistry,
  getCommandById,
  getCommandByToolName,
  pckPatchCommand,
} from "../src/registry.js";
import {
  operationResultSchema,
  pckPatchInputSchema,
  pckPatchSemanticDataSchema,
} from "../src/schemas.js";
import type { PckPatchInput, PlanningContext } from "../src/types.js";

const expectedIds = [
  "version",
  "list-files",
  "extract",
  "export-resources",
  "patch-translations",
  "pck-patch",
] as const;

test("pck-patch is discoverable as the sixth typed command", () => {
  assert.equal(commandRegistry.length, 6);
  assert.deepEqual(
    commandRegistry.map((command) => command.id),
    [...expectedIds],
  );

  const command = getCommandById("pck-patch");
  assert.ok(command);
  assert.equal(getCommandByToolName("gdre_pck_patch"), command);
  assert.equal(command.id, "pck-patch");
  assert.equal(command.toolName, "gdre_pck_patch");
  assert.equal(command.category, "application");
  assert.equal(command.routing, "application");
  assert.deepEqual(command.cliSpellings, ["--pck-patch"]);
  assert.deepEqual(command.aliases, []);
  assert.deepEqual(command.argv, ["--headless", "--no-header", "--"]);
  assert.deepEqual(command.exactArgv, command.argv);
  assert.deepEqual(command.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.match(command.description, /standalone unencrypted PCK/u);
  assert.match(command.description, /separate output package/u);
  assert.match(command.description, /exact replacement\/retained content/u);
  assert.match(command.description, /typed.*translation mapping/iu);
  assert.match(
    command.description,
    /operation-owned BOM-stripped CSV|native getter verification/iu,
  );
  assert.doesNotMatch(command.description, /not yet executable|admission only/iu);
  assert.doesNotMatch(command.description, /unsupported_capability/u);
  const parameterNames = command.parameterDescriptors.map(
    (parameter) => parameter.name as string,
  );
  assert.ok(parameterNames.includes("translations"));
  assert.ok(parameterNames.includes("locales"));
  assert.ok(
    command.coverage.constraints.some((constraint) =>
      constraint.includes("fixed source/output inspection"),
    ),
  );
  assert.ok(
    command.coverage.constraints.some((constraint) =>
      constraint.includes("unchanged inputs and accepted normal-success inventory"),
    ),
  );
  assert.match(generateCommandReference(), /`gdre_pck_patch`/u);
});

const source = "packs/game = source.pck";
const output = "out/patched = output.pck";
const mappings = [
  { hostSource: "fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
  { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
] as const;

test("pck-patch input admits one literal source, ordered mappings, and optional fields", () => {
  const parsed = pckPatchInputSchema.safeParse({
    source,
    patches: [...mappings],
    output,
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    workspace: "D:/GDRE Work/示例",
    timeoutMs: 600_000,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  if (!parsed.success) return;
  assert.equal(parsed.data.source, source);
  assert.equal(parsed.data.output, output);
  assert.deepEqual(parsed.data.patches, [...mappings]);
  assert.equal(parsed.data.timeoutMs, 600_000);

  const minimal = pckPatchInputSchema.safeParse({
    source: "packs/game.pck",
    patches: [{ hostSource: "replacement.bin", logicalMember: "res://replace.txt" }],
  });
  assert.equal(minimal.success, true, JSON.stringify(minimal.error?.issues));
  if (!minimal.success) return;
  assert.equal(minimal.data.output, undefined);
  assert.equal(minimal.data.session, undefined);

  // Only SOURCE=DEST mapping components reject quotes; ordinary source/output
  // option values keep their existing parser-lossless grammar.
  const quotedOrdinaryPaths = pckPatchInputSchema.safeParse({
    source: 'packs/game "quoted".pck',
    patches: [{ hostSource: "replacement.bin", logicalMember: "res://replace.txt" }],
    output: "out/patched 'quoted'.pck",
  });
  assert.equal(
    quotedOrdinaryPaths.success,
    true,
    JSON.stringify(quotedOrdinaryPaths.error?.issues),
  );
});

const combinedTranslation = {
  csv: "edits/translations.csv",
  resource: "res://i18n/translations.csv",
} as const;

test("pck-patch admits translation-only and mixed typed combined requests", () => {
  const translationOnly = pckPatchInputSchema.safeParse({
    source: "packs/game.pck",
    translations: [combinedTranslation],
  });
  assert.equal(
    translationOnly.success,
    true,
    JSON.stringify(translationOnly.error?.issues),
  );
  if (!translationOnly.success) return;
  const translationData = translationOnly.data as unknown as {
    readonly patches: readonly unknown[];
    readonly translations: readonly unknown[];
    readonly locales: readonly unknown[] | undefined;
  };
  assert.deepEqual(translationData.patches, []);
  assert.deepEqual(translationData.translations, [combinedTranslation]);
  assert.equal(translationData.locales, undefined);

  const mixed = pckPatchInputSchema.safeParse({
    source: "packs/game.pck",
    patches: [...mappings],
    translations: [combinedTranslation],
    locales: ["en", "zh", "pt-BR"],
  });
  assert.equal(mixed.success, true, JSON.stringify(mixed.error?.issues));
  if (!mixed.success) return;
  const mixedData = mixed.data as unknown as {
    readonly patches: readonly unknown[];
    readonly translations: readonly unknown[];
    readonly locales: readonly unknown[] | undefined;
  };
  assert.deepEqual(mixedData.patches, [...mappings]);
  assert.deepEqual(mixedData.translations, [combinedTranslation]);
  assert.deepEqual(mixedData.locales, ["en", "zh", "pt-BR"]);

  // Omitted and explicitly empty ordinary patches both normalize to an array.
  for (const patches of [undefined, [] as const]) {
    const normalized = pckPatchInputSchema.safeParse({
      source: "packs/game.pck",
      patches,
      translations: [combinedTranslation],
    });
    assert.equal(
      normalized.success,
      true,
      JSON.stringify(normalized.error?.issues),
    );
    if (!normalized.success) continue;
    assert.deepEqual(normalized.data.patches, []);
  }
});

test("pck-patch rejects combined requests without a family, unrepresentable maps, and cross-family conflicts", () => {
  const valid = {
    source: "packs/game.pck",
    translations: [combinedTranslation],
  };
  const single = {
    hostSource: "replacement.bin",
    logicalMember: "res://replace.txt",
  };
  const invalid = [
    { source: "packs/game.pck" },
    { source: "packs/game.pck", patches: [] },
    { source: "packs/game.pck", translations: [] },
    {
      source: "packs/game.pck",
      translations: [
        combinedTranslation,
        { csv: "edits/other.csv", resource: "res://i18n/other.csv" },
      ],
    },
    { source: "packs/game.pck", patches: [single], locales: ["en"] },
    {
      source: "packs/game.pck",
      patches: [
        { hostSource: "a.bin", logicalMember: "res://I18n/Translations.csv" },
      ],
      translations: [
        { csv: "edits/t.csv", resource: "res://i18n/translations.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      patches: [single],
      translations: [{ csv: "edits/t.csv", resource: "res://replace.txt" }],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/trans=one.csv", resource: "res://i18n/translations.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        {
          csv: 'edits/trans"one.csv',
          resource: "res://i18n/translations.csv",
        },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        {
          csv: "edits/trans'one.csv",
          resource: "res://i18n/translations.csv",
        },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/t.csv", resource: "res://i18n/trans=one.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/t.csv", resource: "res://i18n/trans'one.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/t.csv", resource: 'res://i18n/trans"one.csv' },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/t.csv", resource: "translations.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      translations: [
        { csv: "edits/*.csv", resource: "res://i18n/translations.csv" },
      ],
    },
    { ...valid, locales: [] },
    { ...valid, locales: ["en", "en"] },
    { ...valid, locales: ["en US"] },
    { ...valid, locales: ["1en"] },
    { ...valid, key: "a".repeat(64) },
    { ...valid, include: ["res://*.csv"] },
    { ...valid, exclude: ["res://*.tmp"] },
    { ...valid, filters: { include: ["res://*.csv"] } },
    { ...valid, translationHints: ["D:/hints.csv"] },
    { ...valid, script: "native/caller.gd" },
    { ...valid, unexpected: true },
    {
      source: "packs/game.pck",
      patches: [single],
      translations: [{ ...combinedTranslation, unexpected: true }],
    },
  ] as const;

  for (const value of invalid) {
    assert.equal(
      pckPatchInputSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }
});

test("pck-patch input rejects empty, malformed, unsupported, and ambiguous requests", () => {
  const valid = { source: "packs/game.pck", patches: [...mappings] };
  const single = { hostSource: "replacement.bin", logicalMember: "res://replace.txt" };
  const invalid = [
    {},
    { source: "packs/game.pck" },
    { patches: [...mappings] },
    { source: "packs/game.pck", patches: [] },
    { source: "", patches: [...mappings] },
    { source: "packs/*.pck", patches: [...mappings] },
    { source: " packs/game.pck", patches: [...mappings] },
    { source: "'packs/game.pck'", patches: [...mappings] },
    { source: ["packs/game.pck"], patches: [...mappings] },
    { source: "packs/game.pck", patches: "replacement.bin" },
    { source: "packs/game.pck", patches: [{ hostSource: "a*.bin", logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a=b.bin", logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: 'a"b.bin', logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a'b.bin", logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: '"a.bin', logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin'", logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: 'res://data/a"b.txt' }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://data/a'b.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: 'res://data/"a.txt' }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: 'res://data/a.txt"' }] },
    { source: "packs/game.pck", patches: [{ hostSource: " a.bin", logicalMember: "res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "translations.csv" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://../a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/../a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n//a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n\\a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/*.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: " res://a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://a.txt " }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/./a.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/a\t.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/a\u001f.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/a\u007f.txt" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n/a.txt=tail" }] },
    { source: "packs/game.pck", patches: [{ hostSource: "a.bin", logicalMember: "res://i18n:bad/a.txt" }] },
    {
      source: "packs/game.pck",
      patches: [
        { hostSource: "same.bin", logicalMember: "res://one.txt" },
        { hostSource: "same.bin", logicalMember: "res://two.txt" },
      ],
    },
    {
      source: "packs/game.pck",
      patches: [
        { hostSource: "one.bin", logicalMember: "res://Translations.csv" },
        { hostSource: "two.bin", logicalMember: "res://translations.csv" },
      ],
    },
    {
      source: "packs/game.pck",
      patches: [{ hostSource: "a.bin", logicalMember: "res://a.txt", extra: true }],
    },
    { ...valid, include: ["res://*.txt"] },
    { ...valid, exclude: ["res://*.tmp"] },
    { ...valid, filters: { include: ["res://*.txt"] } },
    { ...valid, key: "a".repeat(64) },
    { ...valid, checksum: "skip" },
    { ...valid, translationHints: ["D:/hints.csv"] },
    { ...valid, collectResourceStrings: false },
    { ...valid, dumpResourceStrings: true },
    { ...valid, script: "native/caller.gd" },
    { ...valid, callerScript: "native/caller.gd" },
    { ...valid, unexpected: true },
    { ...valid, output: "out/*.pck" },
    { ...valid, output: " out/patched.pck" },
    { ...valid, workspace: "relative/workspace" },
    { ...valid, timeoutMs: 0 },
    { ...valid, timeoutMs: 3_600_001 },
    { ...valid, session: [{ kind: "setting", key: "x", value: true }] },
    { ...valid, session: [{ kind: "multithreading", disabled: "yes" }] },
  ] as const;

  for (const value of invalid) {
    assert.equal(
      pckPatchInputSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  }

  const maximum = {
    source: "packs/game.pck",
    patches: Array.from({ length: 256 }, (_, index) => ({
      hostSource: `fixtures/replacement-${String(index)}.bin`,
      logicalMember: `res://data/replacement-${String(index)}.txt`,
    })),
  };
  assert.equal(pckPatchInputSchema.safeParse(maximum).success, true);
  assert.equal(
    pckPatchInputSchema.safeParse({
      ...maximum,
      patches: [
        ...maximum.patches,
        { hostSource: "fixtures/one-too-many.bin", logicalMember: "res://data/one-too-many.txt" },
      ],
    }).success,
    false,
  );

  assert.equal(pckPatchInputSchema.safeParse({ ...valid, patches: [single] }).success, true);
});

test("pck-patch schema and descriptor metadata agree field by field", () => {
  const shape = pckPatchInputSchema.shape;
  const descriptorNames = pckPatchCommand.parameterDescriptors
    .map((parameter) => parameter.name)
    .sort();
  assert.deepEqual(Object.keys(shape).sort(), descriptorNames);

  const byName = Object.fromEntries(
    pckPatchCommand.parameterDescriptors.map((parameter) => [
      parameter.name,
      parameter,
    ]),
  ) as Record<
    string,
    {
      readonly type: string;
      readonly required: boolean;
      readonly pathRole: string;
      readonly description: string;
      readonly evidence: readonly { readonly source: string }[];
    }
  >;
  const expectedTypes: Record<string, string> = {
    source: "string",
    patches: "array",
    translations: "array",
    locales: "array",
    output: "string",
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
  assert.equal(byName.source?.required, true);
  assert.equal(byName.patches?.required, false);
  assert.equal(byName.translations?.required, false);
  assert.equal(byName.locales?.required, false);
  assert.equal(byName.source?.pathRole, "input");
  assert.equal(byName.patches?.pathRole, "input");
  assert.equal(byName.translations?.pathRole, "input");
  assert.equal(byName.locales?.pathRole, "none");
  assert.equal(byName.output?.pathRole, "output");
  assert.equal(byName.workspace?.pathRole, "workspace");
  const jsonSchema = z.toJSONSchema(pckPatchInputSchema, {
    io: "input",
  }) as {
    readonly required?: readonly string[];
  };
  assert.deepEqual([...(jsonSchema.required ?? [])], ["source"]);
  for (const parameter of pckPatchCommand.parameterDescriptors) {
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
    pckPatchCommand.evidence.every(
      (reference) => !/\.scratch|\\Temp\/|C:\\Users/iu.test(reference.source),
    ),
  );
  const publishedProvenance = [
    ...pckPatchCommand.evidence.map((reference) => reference.source),
    ...pckPatchCommand.parameterDescriptors.flatMap((parameter) =>
      parameter.evidence.map((reference) => reference.source),
    ),
    ...pckPatchCommand.coverage.constraints,
    ...pckPatchCommand.coverage.prerequisites,
  ];
  for (const source of publishedProvenance) {
    assert.ok(
      !/09r|2026-10-23|accepted existing-member|accepted route|\.scratch/iu.test(source),
      source,
    );
  }
  assert.ok(
    pckPatchCommand.evidence.some((reference) =>
      reference.source.startsWith("https://github.com/GDRETools/gdsdecomp/"),
    ),
  );
});

test("pck-patch defaults accept only timeoutMs and ordered session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-pck-patch-"));
  const configPath = path.join(root, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceRoot: root,
        defaults: {
          "pck-patch": {
            timeoutMs: 45_000,
            session: [{ kind: "multithreading", disabled: true }],
          },
        },
      }),
      "utf8",
    );
    const config = await loadConfig(root, { GDRE_MCP_CONFIG: configPath });
    assert.deepEqual(config.defaults["pck-patch"], {
      timeoutMs: 45_000,
      session: [{ kind: "multithreading", disabled: true }],
    });

    for (const invalidDefaults of [
      { "pck-patch": { source: "packs/game.pck" } },
      { "pck-patch": { patches: [{ hostSource: "a.bin", logicalMember: "res://a.txt" }] } },
      {
        "pck-patch": {
          translations: [{ csv: "edits/t.csv", resource: "res://i18n/t.csv" }],
        },
      },
      { "pck-patch": { locales: ["en"] } },
      { "pck-patch": { output: "out/patched.pck" } },
      { "pck-patch": { key: "a".repeat(64) } },
      { "pck-patch": { include: ["res://*.txt"] } },
      { "pck-patch": { session: [{ kind: "setting", key: "x", value: true }] } },
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

const makeConfig = (overrides: Partial<LoadedConfig> = {}): LoadedConfig => ({
  installationRoot: "D:/gdre",
  configFile: null,
  workspaceRoot: "D:/workspace",
  runtimeDirectory: "D:/gdre/vendor/GDRE_tools",
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

const operation = "D:/workspace/.gdre/operations/op";

const packagePatchSemanticPartial = {
  completeness: "partial" as const,
  outputPath: "D:/out/patched.pck",
  counts: {
    mappings: 2,
    verifiedReplacements: 1,
    verifiedRetainedMembers: 1,
    unverifiedFiles: 0,
  },
  reports: {
    sourceInspection: "D:/workspace/.gdre/operations/op/pck-patch/source-inspection.json",
    outputInspection: "D:/workspace/.gdre/operations/op/pck-patch/output-inspection.json",
    verification: "D:/workspace/.gdre/operations/op/pck-patch/verification.json",
  },
  samples: {
    replacements: ["res://data/replace.txt"],
    retainedMembers: ["res://data/keep.txt"],
    unverifiedFiles: [],
    truncated: false,
  },
  diagnostics: ["One replacement remains unverified."],
};

const validatedInput = () => {
  const validation = pckPatchCommand.validate({
    source,
    patches: [...mappings],
    output,
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    timeoutMs: 45_000,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) throw new Error("validation unexpectedly failed");
  return validation.value;
};

test("pck invocation records defaults, provenance, and prepared values", () => {
  const config = makeConfig({
    defaults: {
      "pck-patch": {
        timeoutMs: 45_000,
        session: [{ kind: "multithreading", disabled: true }],
      },
    },
  });
  const requestedDefaults = pckPatchCommand.validate({
    source,
    patches: [...mappings],
    output,
  });
  assert.equal(requestedDefaults.ok, true);
  if (!requestedDefaults.ok) return;
  const invocation = new CommandInvocation(
    pckPatchCommand,
    requestedDefaults.value,
    config,
  );
  assert.equal(invocation.operationLabel, "GDRE patch package members");
  assert.equal(invocation.settingsRejection, null);
  assert.equal(invocation.knownKey, undefined);
  assert.deepEqual(invocation.session, [
    { kind: "multithreading", disabled: true },
  ]);
  assert.deepEqual(
    (invocation.input as ReturnType<typeof validatedInput>).session,
    [{ kind: "multithreading", disabled: true }],
  );
  assert.equal(invocation.input.timeoutMs, 45_000);

  const effective = invocation.effectiveParameters(
    {
      workspace: "D:/workspace",
      resolvedPckSource: "D:/fixtures/game.pck",
      resolvedPatches: [
        { hostSource: "D:/fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
        { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
      ],
      effectiveOutput: "D:/out/patched.pck",
    },
    45_000,
  );
  assert.deepEqual(effective, {
    workspace: "D:/workspace",
    session: [{ kind: "multithreading", disabled: true }],
    source: "D:/fixtures/game.pck",
    patches: [
      { hostSource: "D:/fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
      { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
    ],
    output: "D:/out/patched.pck",
    timeoutMs: 45_000,
  });
  assert.deepEqual(invocation.parameterSources, {
    workspace: "config",
    timeoutMs: "config",
    source: "call",
    patches: "call",
    session: "config",
    output: "call",
  });

  const unresolved = new CommandInvocation(
    pckPatchCommand,
    validatedInput(),
    makeConfig(),
  ).effectiveParameters({ workspace: "D:/workspace" });
  assert.deepEqual(unresolved.source, { status: "unresolved" });
  assert.deepEqual(unresolved.patches, { status: "unresolved" });
  assert.deepEqual(unresolved.output, { status: "unresolved" });

  const withSettings = new CommandInvocation(
    pckPatchCommand,
    validatedInput(),
    makeConfig({
      settings: [
        { key: "General/download_plugins", type: "boolean", value: false },
      ],
    }),
  );
  assert.match(withSettings.settingsRejection ?? "", /gdre_pck_patch/u);
});

test("pck planner emits the exact ordered CLI mapping tokens", () => {
  const plan = pckPatchCommand.plan(validatedInput(), {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source=pack.pck",
    resolvedPatches: [
      { hostSource: "D:/fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
      { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
    ],
    effectiveOutput: "D:/out/patched=out.pck",
  });
  assert.deepEqual(plan.argv, [
    ...PCK_PATCH_ARGV_PREFIX,
    "--disable-multithreading=true",
    "--disable-multithreading=false",
    "--pck-patch=D:/fixtures/source=pack.pck",
    "--output=D:/out/patched=out.pck",
    "--patch-file=D:/fixtures/replacement one.bin=res://data/replace.txt",
    "--patch-file=D:/fixtures/menu.bin=res://i18n/menu.csv",
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, 45_000);
  assert.deepEqual(plan.effects, {
    reads: [
      "D:/fixtures/source=pack.pck",
      "D:/fixtures/replacement one.bin",
      "D:/fixtures/menu.bin",
    ],
    writes: ["D:/out/patched=out.pck"],
    network: false,
    codeExecution: false,
    unknownScope: false,
  });
  assert.equal(plan.argv.some((token) => /["']/u.test(token)), false);
});

test("pck planner refuses missing, relative, repeated, or contradictory resolved context", () => {
  const base = {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/game.pck",
    resolvedPatches: [
      { hostSource: "D:/fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
      { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
    ] as const,
    effectiveOutput: "D:/out/patched.pck",
  };
  const input = validatedInput();

  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPckSource: undefined }),
    /resolved package source/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPckSource: "" }),
    /resolved package source/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPckSource: "fixtures/game.pck" }),
    /absolute parser-lossless/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPckSource: '"D:/fixtures/game.pck"' }),
    /absolute parser-lossless/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPckSource: "D:/fixtures/game.pck\n" }),
    /absolute parser-lossless/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPatches: undefined }),
    /resolved package patch mappings/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, resolvedPatches: [base.resolvedPatches[0]] }),
    /one resolved host-source mapping per admitted patch/u,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(input, {
        ...base,
        resolvedPatches: [
          { hostSource: "D:/fixtures/replacement one.bin", logicalMember: "res://other.txt" },
          base.resolvedPatches[1],
        ],
      }),
    /logical member does not match/u,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(input, {
        ...base,
        resolvedPatches: [
          { hostSource: "fixtures/replacement one.bin", logicalMember: "res://data/replace.txt" },
          base.resolvedPatches[1],
        ],
      }),
    /absolute parser-lossless/u,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(input, {
        ...base,
        resolvedPatches: [
          { hostSource: "D:/fixtures/replace=one.bin", logicalMember: "res://data/replace.txt" },
          base.resolvedPatches[1],
        ],
      }),
    /representability policy|= or quotes/u,
  );
  for (const quotedHost of [
    'D:/fixtures/repla"cement.bin',
    "D:/fixtures/repla'cement.bin",
    'D:/fixtures/replacement.bin"',
    "D:/fixtures/replacement.bin'",
    '"D:/fixtures/replacement.bin',
  ]) {
    assert.throws(
      () =>
        pckPatchCommand.plan(input, {
          ...base,
          resolvedPatches: [
            { hostSource: quotedHost, logicalMember: "res://data/replace.txt" },
            base.resolvedPatches[1],
          ],
        }),
      /absolute parser-lossless|quote|mapping grammar/u,
      quotedHost,
    );
  }
  assert.throws(
    () =>
      pckPatchCommand.plan(input, {
        ...base,
        resolvedPatches: [
          { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://data/replace.txt" },
          { hostSource: "D:/fixtures/menu.bin", logicalMember: "res://i18n/menu.csv" },
        ],
      }),
    /repeat|duplicate/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, effectiveOutput: undefined }),
    /effective pck-patch output/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, effectiveOutput: "out/patched.pck" }),
    /absolute parser-lossless/u,
  );
  assert.throws(
    () => pckPatchCommand.plan(input, { ...base, effectiveOutput: " D:/out/patched.pck" }),
    /absolute parser-lossless/u,
  );
});

test("pck planner requires resolved spellings to identify absolute admitted paths", () => {
  const validation = pckPatchCommand.validate({
    source: "D:/Packs/./Game.pck",
    patches: [
      { hostSource: "D:/Packs/./Replacement.bin", logicalMember: "res://data/replace.txt" },
      { hostSource: "fixtures/relative.bin", logicalMember: "res://i18n/menu.csv" },
    ],
    output: "D:/Out/patched.pck",
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;

  const base = {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "d:\\packs\\game.pck",
    resolvedPatches: [
      { hostSource: "d:\\packs\\replacement.bin", logicalMember: "res://data/replace.txt" },
      { hostSource: "D:/workspace/fixtures/relative.bin", logicalMember: "res://i18n/menu.csv" },
    ] as const,
    effectiveOutput: "d:/out/PATCHED.pck",
  };

  // Equivalent Windows slash/case/dot spellings identify the admitted paths.
  const plan = pckPatchCommand.plan(validation.value, base);
  assert.deepEqual(plan.argv.slice(-4), [
    "--pck-patch=d:\\packs\\game.pck",
    "--output=d:/out/PATCHED.pck",
    "--patch-file=d:\\packs\\replacement.bin=res://data/replace.txt",
    "--patch-file=D:/workspace/fixtures/relative.bin=res://i18n/menu.csv",
  ]);

  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckSource: "D:/packs/Other.pck",
      }),
    /identify the admitted absolute source/u,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPatches: [
          { hostSource: "D:/packs/Other.bin", logicalMember: "res://data/replace.txt" },
          base.resolvedPatches[1],
        ],
      }),
    /identify the admitted absolute host source/u,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        effectiveOutput: "D:/out/Other.pck",
      }),
    /identify the admitted absolute output/u,
  );
});

test("pck invocation records combined translation provenance and locale semantics", () => {
  const validation = pckPatchCommand.validate({
    source,
    translations: [combinedTranslation],
    locales: ["en", "zh"],
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;

  const invocation = new CommandInvocation(
    pckPatchCommand,
    validation.value,
    makeConfig(),
  );
  assert.deepEqual(
    (invocation.input as unknown as { readonly patches: readonly unknown[] })
      .patches,
    [],
  );
  assert.deepEqual(invocation.parameterSources, {
    workspace: "config",
    source: "call",
    patches: "builtin",
    session: "builtin",
    output: "builtin",
    translations: "call",
    locales: "call",
  });

  const resolvedTranslations = [
    {
      csv: "D:/workspace/prepared/translations.csv",
      resource: "res://i18n/translations.csv",
    },
  ];
  const effective = invocation.effectiveParameters({
    workspace: "D:/workspace",
    resolvedPckSource: "D:/fixtures/game.pck",
    resolvedPatches: [],
    resolvedPckTranslations: resolvedTranslations,
    effectiveOutput: "D:/out/patched.pck",
  } as Parameters<typeof invocation.effectiveParameters>[0]);
  assert.deepEqual(effective.translations, resolvedTranslations);
  assert.deepEqual(effective.locales, ["en", "zh"]);
  assert.equal(effective.localeSelection, "explicit");
  assert.deepEqual(effective.patches, []);

  const omitted = new CommandInvocation(
    pckPatchCommand,
    {
      source,
      patches: [],
      translations: [combinedTranslation],
    } as unknown as PckPatchInput,
    makeConfig(),
  );
  const omittedEffective = omitted.effectiveParameters({
    workspace: "D:/workspace",
    resolvedPckSource: "D:/fixtures/game.pck",
    resolvedPatches: [],
    resolvedPckTranslations: resolvedTranslations,
    effectiveOutput: "D:/out/patched.pck",
  } as Parameters<typeof omitted.effectiveParameters>[0]);
  assert.deepEqual(omittedEffective.locales, []);
  assert.equal(omittedEffective.localeSelection, "new-locales-only");

  const unresolved = invocation.effectiveParameters({
    workspace: "D:/workspace",
  });
  assert.deepEqual(unresolved.translations, { status: "unresolved" });
});

test("pck planner emits ordered ordinary, translation, and exact locale tokens", () => {
  const validation = pckPatchCommand.validate({
    source,
    patches: [
      {
        hostSource: "fixtures/replacement.bin",
        logicalMember: "res://data/replace.txt",
      },
    ],
    translations: [combinedTranslation],
    locales: ["en", "zh"],
    session: [{ kind: "multithreading", disabled: false }],
    timeoutMs: 30_000,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;

  const preparedCsv =
    "D:/workspace/.gdre/operations/op/prepared translations.csv";
  const plan = pckPatchCommand.plan(validation.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [
      {
        hostSource: "D:/fixtures/replacement.bin",
        logicalMember: "res://data/replace.txt",
      },
    ],
    resolvedPckTranslations: [
      {
        csv: "D:/workspace/edits/translations.csv",
        resource: "res://i18n/translations.csv",
      },
    ],
    preparedPckTranslations: [
      { csv: preparedCsv, resource: "res://i18n/translations.csv" },
    ],
    effectiveOutput: "D:/out/patched.pck",
  } as PlanningContext);
  assert.deepEqual(plan.argv, [
    ...PCK_PATCH_ARGV_PREFIX,
    "--disable-multithreading=false",
    "--pck-patch=D:/fixtures/source.pck",
    "--output=D:/out/patched.pck",
    "--patch-file=D:/fixtures/replacement.bin=res://data/replace.txt",
    `--patch-translations=${preparedCsv}=res://i18n/translations.csv`,
    "--locales=en,zh",
  ]);
  assert.deepEqual(plan.effects.reads, [
    "D:/fixtures/source.pck",
    "D:/fixtures/replacement.bin",
    preparedCsv,
  ]);
  assert.deepEqual(plan.effects.writes, ["D:/out/patched.pck"]);

  // Translation-only plans have no ordinary tokens and no expansion of omitted
  // locales; the emitted CSV is the resolved absolute context value, not the
  // admitted relative spelling or a guessed generated destination.
  const translationOnly = pckPatchCommand.validate({
    source,
    translations: [combinedTranslation],
  });
  assert.equal(translationOnly.ok, true, JSON.stringify(translationOnly));
  if (!translationOnly.ok) return;
  const translationPlan = pckPatchCommand.plan(translationOnly.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [],
    resolvedPckTranslations: [
      { csv: "D:/fixtures/host translations.csv", resource: "res://i18n/translations.csv" },
    ],
    effectiveOutput: "D:/out/patched.pck",
  } as PlanningContext);
  assert.deepEqual(translationPlan.argv, [
    ...PCK_PATCH_ARGV_PREFIX,
    "--pck-patch=D:/fixtures/source.pck",
    "--output=D:/out/patched.pck",
    "--patch-translations=D:/fixtures/host translations.csv=res://i18n/translations.csv",
  ]);
  assert.equal(
    translationPlan.argv.some((token) => token.startsWith("--patch-file=")),
    false,
  );
  assert.equal(
    translationPlan.argv.some((token) => token.startsWith("--locales=")),
    false,
  );
});

test("pck planner rejects missing or mismatched combined translation context", () => {
  const validation = pckPatchCommand.validate({
    source,
    translations: [combinedTranslation],
    locales: ["en"],
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;

  const base = {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [],
    resolvedPckTranslations: [
      { csv: "D:/fixtures/translations.csv", resource: "res://i18n/translations.csv" },
    ],
    effectiveOutput: "D:/out/patched.pck",
  } as PlanningContext;

  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: undefined,
      } as PlanningContext),
    /resolved package translation/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: [],
      } as PlanningContext),
    /one resolved CSV\/resource mapping per admitted translation/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: [
          { csv: "D:/fixtures/translations.csv", resource: "res://i18n/other.csv" },
        ],
      } as PlanningContext),
    /logical translation resource does not match/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: [
          { csv: "fixtures/translations.csv", resource: "res://i18n/translations.csv" },
        ],
      } as PlanningContext),
    /absolute parser-lossless/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: [
          {
            csv: "D:/fixtures/trans=one.csv",
            resource: "res://i18n/translations.csv",
          },
        ],
      } as PlanningContext),
    /representability policy|= or quotes/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPckTranslations: [
          {
            csv: "D:/fixtures/trans'one.csv",
            resource: "res://i18n/translations.csv",
          },
        ],
      } as PlanningContext),
    /representability policy|= or quotes/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        resolvedPatches: undefined,
      } as PlanningContext),
    /resolved package patch mappings/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        preparedPckTranslations: [],
      } as PlanningContext),
    /one prepared CSV\/resource mapping per admitted translation/i,
  );
  assert.throws(
    () =>
      pckPatchCommand.plan(validation.value, {
        ...base,
        preparedPckTranslations: [
          {
            csv: "D:/workspace/prepared/translations.csv",
            resource: "res://i18n/other.csv",
          },
        ],
      } as PlanningContext),
    /prepared logical translation resource does not match/i,
  );
  for (const badPreparedCsv of [
    "workspace/prepared/translations.csv",
    "D:/workspace/prepared/trans=one.csv",
    "D:/workspace/prepared/trans'one.csv",
  ]) {
    assert.throws(
      () =>
        pckPatchCommand.plan(validation.value, {
          ...base,
          preparedPckTranslations: [
            {
              csv: badPreparedCsv,
              resource: "res://i18n/translations.csv",
            },
          ],
        } as PlanningContext),
      /absolute parser-lossless|representability policy|= or quotes/i,
      badPreparedCsv,
    );
  }

  const emptyAdmission = {
    source,
    patches: [],
  } as unknown as PckPatchInput;
  assert.throws(
    () =>
      buildPckPatchPlan({
        input: emptyAdmission,
        resolvedPckSource: "D:/fixtures/source.pck",
        resolvedPatches: [],
        resolvedPckTranslations: [],
        effectiveOutput: "D:/out/patched.pck",
        operationDirectory: operation,
      } as unknown as Parameters<typeof buildPckPatchPlan>[0]),
    /at least one admitted mapping family/i,
  );
});

test("pck planner keeps original CSV provenance while prepared staging drives the CLI", () => {
  const admittedCsv = "D:/fixtures/translations.csv";
  const original = {
    csv: admittedCsv,
    resource: "res://i18n/translations.csv",
  };
  const prepared = {
    csv: "D:/workspace/.gdre/operations/op/prepared/translations.csv",
    resource: "res://i18n/translations.csv",
  };
  const validation = pckPatchCommand.validate({
    source,
    translations: [original],
    locales: ["en"],
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  if (!validation.ok) return;

  const invocation = new CommandInvocation(
    pckPatchCommand,
    validation.value,
    makeConfig(),
  );
  const effective = invocation.effectiveParameters({
    workspace: "D:/workspace",
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [],
    resolvedPckTranslations: [original],
    effectiveOutput: "D:/out/patched.pck",
  });
  assert.deepEqual(effective.translations, [original]);

  const plan = pckPatchCommand.plan(validation.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [],
    resolvedPckTranslations: [original],
    preparedPckTranslations: [prepared],
    effectiveOutput: "D:/out/patched.pck",
  } as PlanningContext);
  assert.deepEqual(plan.argv, [
    ...PCK_PATCH_ARGV_PREFIX,
    "--pck-patch=D:/fixtures/source.pck",
    "--output=D:/out/patched.pck",
    `--patch-translations=${prepared.csv}=res://i18n/translations.csv`,
    "--locales=en",
  ]);
  assert.deepEqual(plan.effects.reads, [
    "D:/fixtures/source.pck",
    prepared.csv,
  ]);

  const originalCsvPlan = pckPatchCommand.plan(validation.value, {
    workspace: "D:/workspace",
    operationDirectory: operation,
    resolvedPckSource: "D:/fixtures/source.pck",
    resolvedPatches: [],
    resolvedPckTranslations: [original],
    effectiveOutput: "D:/out/patched.pck",
  } as PlanningContext);
  assert.ok(
    originalCsvPlan.argv.includes(
      `--patch-translations=${admittedCsv}=res://i18n/translations.csv`,
    ),
  );
});

test("pck semantic data is bounded and descriptor-only evaluation stays unknown", () => {
  const data = packagePatchSemanticPartial;
  assert.equal(
    pckPatchSemanticDataSchema.safeParse(data).success,
    true,
    JSON.stringify(pckPatchSemanticDataSchema.safeParse(data).error?.issues),
  );
  for (const invalid of [
    { ...data, completeness: "everything" },
    { ...data, completeness: "unsupported" },
    { ...data, outputPath: "" },
    { ...data, counts: { ...data.counts, mappings: -1 } },
    { ...data, reports: { ...data.reports, sourceInspection: "" } },
    { ...data, samples: { ...data.samples, replacements: Array.from({ length: 9 }, (_, index) => `res://${String(index)}.txt`) } },
    { ...data, diagnostics: Array.from({ length: 17 }, () => "diagnostic") },
    { ...data, unexpected: true },
  ]) {
    assert.equal(pckPatchSemanticDataSchema.safeParse(invalid).success, false);
  }

  const evaluation = pckPatchCommand.evaluate({
    exitCode: 0,
    signal: null,
    stdout: "Patched PCK file: D:/out/patched.pck\n",
    stderr: "",
    stdoutTruncated: false,
  });
  assert.equal(evaluation.status, "unknown");
  assert.equal(evaluation.data, null);
  assert.equal(evaluation.rule, "gdre-pck-patch-v1");
  assert.ok(
    evaluation.evidence.every((entry) => !/succeeded|verified/u.test(entry)),
  );

  assert.equal(
    operationResultSchema.shape.commandId.safeParse("pck-patch").success,
    true,
  );
});

test("package-patch semantic data round-trips through the result envelope only for pck-patch", () => {
  const stream = {
    bytes: 0,
    text: "",
    truncated: false,
    utf8Valid: true,
    rawPath: "D:/workspace/.gdre/operations/op/stdout.bin",
    textPath: "D:/workspace/.gdre/operations/op/stdout.txt",
    complete: true,
  };
  const pckData = packagePatchSemanticPartial;
  const envelope = (commandId: "pck-patch" | "extract", data: unknown) => ({
    schemaVersion: 1 as const,
    operationId: "550e8400-e29b-41d4-a716-446655440000",
    commandId,
    success: false,
    status: "failed" as const,
    error: null,
    runtime: {
      health: "ready" as const,
      registryVersion: "2.8.0-beta.2",
      targetVersion: "2.8.0-beta.2",
      actualVersion: "2.8.0-beta.2",
      comparison: "match" as const,
      executable: "D:/gdre/vendor/GDRE_tools/gdre_tools.exe",
      companions: [
        { path: "D:/gdre/vendor/GDRE_tools/gdre_tools.exe", present: true, sha256: null },
        { path: "D:/gdre/vendor/GDRE_tools/gdre_tools.pck", present: true, sha256: null },
        { path: "D:/gdre/vendor/GDRE_tools/GodotMonoDecompNativeAOT.dll", present: true, sha256: null },
      ],
      exeSha256: null,
      baselineHashesMatch: null,
      checkedAt: "2026-10-23T10:00:00.000Z",
      evidencePath: null,
      probe: { exitCode: 1, signal: null, stdout: stream, stderr: stream, error: null },
      warnings: [],
    },
    timing: {
      requestedAt: "2026-10-23T10:00:00.000Z",
      queuedAt: null,
      startedAt: null,
      processExitedAt: null,
      finishedAt: "2026-10-23T10:00:00.000Z",
      queueMs: 0,
      processMs: null,
      totalMs: 0,
    },
    process: { pid: null, exitCode: null, signal: null, spawnError: null },
    semantic: {
      status: "unknown" as const,
      rule: "gdre-pck-patch-v1",
      summary: "Package-patch evidence was not evaluated.",
      evidence: [],
      data,
    },
    paths: {
      workspace: "D:/workspace",
      operation,
      output: `${operation}/output`,
      effectiveDestination: "D:/out/patched.pck",
      manifest: `${operation}/manifest.json`,
      artifactInventory: `${operation}/artifacts.json`,
    },
    stdout: stream,
    stderr: stream,
    artifacts: { count: 0, items: [], truncated: false, complete: true },
    cleanup: { state: "not_needed" as const, trigger: null, actions: [], error: null },
    persistence: { state: "complete" as const, error: null },
    warnings: [],
  });

  const parsed = operationResultSchema.safeParse(envelope("pck-patch", pckData));
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  if (parsed.success) {
    assert.deepEqual(parsed.data.semantic.data, pckData);
  }

  assert.equal(
    operationResultSchema.safeParse(envelope("extract", pckData)).success,
    false,
    "package-patch data must not satisfy another command discriminator",
  );
  assert.equal(
    operationResultSchema.safeParse(
      envelope("pck-patch", {
        completeness: "unknown",
        outputPath: "D:/out/patched.pck",
        localeSelection: { mode: "new-locales-only", locales: [] },
        counts: {
          mappings: 0,
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
      }),
    ).success,
    false,
    "translation-patch data must not satisfy the pck-patch command",
  );
});
