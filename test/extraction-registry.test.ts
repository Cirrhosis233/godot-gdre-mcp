import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  extractInputSchema,
  extractSemanticDataSchema,
  operationResultSchema,
} from "../src/schemas.js";
import {
  EXTRACT_ARGV_PREFIX,
  commandRegistry,
  extractCommand,
  getCommandById,
  getCommandByToolName,
} from "../src/registry.js";
import { generateCommandReference } from "../src/reference.js";

const inputs = [{ kind: "path", path: "packs/pack 空间.pck" }] as const;

test("extract input schema admits base fields plus typed selection fields", () => {
  const parsed = extractInputSchema.safeParse({
    inputs: [
      { kind: "path", path: "packs/pack 空间.pck" },
      { kind: "glob", pattern: "packs/**/*.pck" },
    ],
    output: "exports/out 空间",
    include: ["res://**/*.gd", "*.gdc"],
    exclude: ["res://addons/**"],
    selection: "all",
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    workspace: "D:/GDRE Work/示例",
    timeoutMs: 600_000,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.session, [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ]);
    assert.deepEqual(parsed.data.include, ["res://**/*.gd", "*.gdc"]);
    assert.deepEqual(parsed.data.exclude, ["res://addons/**"]);
  }

  const absoluteOutput = extractInputSchema.safeParse({
    inputs: [...inputs],
    output: "D:/GDRE Work/exports/out",
  });
  assert.equal(absoluteOutput.success, true);
  if (absoluteOutput.success) {
    assert.equal(Object.hasOwn(absoluteOutput.data, "selection"), false);
  }

  const scriptsMode = extractInputSchema.safeParse({
    inputs: [...inputs],
    selection: "scripts",
  });
  assert.equal(scriptsMode.success, true);

  for (const invalid of [
    {},
    { inputs: [] },
    { inputs: [{ kind: "path", path: "packs/format-*.pck" }] },
    { inputs: [...inputs], output: "exports/*" },
    { inputs: [...inputs], output: "'exports/out'" },
    { inputs: [...inputs], output: "~/exports/out" },
    { inputs: [...inputs], output: "%APPDATA%/exports/out" },
    { inputs: [...inputs], output: " exports/out" },
    { inputs: [...inputs], selection: "everything" },
    { inputs: [...inputs], include: ["res://[a].gd"] },
    { inputs: [...inputs], include: ["res://{a,b}.gd"] },
    { inputs: [...inputs], include: ["res://a**b.gd"] },
    { inputs: [...inputs], include: ["../secret.gd"] },
    { inputs: [...inputs], include: ["D:/packs/*.pck"] },
    { inputs: [...inputs], include: ["user://locales/*.xl"] },
    { inputs: [...inputs], include: ["other://x/*.gd"] },
    { inputs: [...inputs], include: ["C:relative/*.gd"] },
    { inputs: [...inputs], include: ["//server/share/*.gd"] },
    { inputs: [...inputs], include: ["\\\\server\\share\\*.gd"] },
    { inputs: [...inputs], include: ["res://a:b/*.gd"] },
    { inputs: [...inputs], include: ["'res://*.gd'"] },
    { inputs: [...inputs], include: ["res://*.gd "] },
    { inputs: [...inputs], selection: "scripts", exclude: ["res://**/*.tmp"] },
    { inputs: [...inputs], selection: "translations", include: ["res://*.xl"] },
    { inputs: [...inputs], key: "a".repeat(64) },
    { inputs: [...inputs], checksum: "skip" },
    { inputs: [...inputs], unexpected: true },
    { inputs: [...inputs], session: [{ kind: "setting", key: "x", value: true }] },
  ]) {
    assert.equal(
      extractInputSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("selection stays optional and omitted provenance is preserved in discovery and parse", () => {
  const schema = z.toJSONSchema(extractInputSchema) as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.equal(schema.required?.includes("selection") ?? false, false);
  assert.equal(Object.hasOwn(schema.properties ?? {}, "selection"), true);

  const omitted = extractInputSchema.safeParse({ inputs: [...inputs] });
  assert.equal(omitted.success, true);
  if (omitted.success) {
    assert.equal(Object.hasOwn(omitted.data, "selection"), false);
  }

  const explicit = extractInputSchema.safeParse({ inputs: [...inputs], selection: "all" });
  assert.equal(explicit.success, true);
  if (explicit.success) {
    assert.equal(explicit.data.selection, "all");
  }
});

test("extract semantic data is a strict bounded summary with the default checksum policy", () => {
  const parsed = extractSemanticDataSchema.safeParse({
    totalFiles: 3,
    selectedFiles: 2,
    extractedFiles: 2,
    outputPath: "D:/GDRE Work/exports/out 空间",
    checksum: "default",
    checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 },
  });
  assert.equal(parsed.success, true);

  for (const invalid of [
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "D:/out", checksum: "skip", checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 } },
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "D:/out", checksum: "md5", checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 } },
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "", checksum: "default", checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 } },
    { totalFiles: -1, selectedFiles: 0, extractedFiles: 0, outputPath: "D:/out", checksum: "default", checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 } },
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "D:/out", checksum: "default" },
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "D:/out", checksum: "default", checksumCoverage: { scope: "everything", verifiedFiles: 3, skippedFiles: 0 } },
    { totalFiles: 3, selectedFiles: 2, extractedFiles: 2, outputPath: "D:/out", checksum: "default", checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 }, files: [] },
  ]) {
    assert.equal(
      extractSemanticDataSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  }
});

const workspace = "D:/GDRE Work/示例";
const operation = "D:/GDRE Work/示例/.gdre/operations/op";

test("extract descriptor plans the exact contracted argv and defaults", () => {
  assert.equal(extractCommand.id, "extract");
  assert.equal(extractCommand.toolName, "gdre_extract");
  assert.equal(extractCommand.category, "application");
  assert.equal(extractCommand.routing, "application");
  assert.deepEqual(extractCommand.cliSpellings, ["--extract"]);
  assert.deepEqual(extractCommand.aliases, []);
  assert.deepEqual(EXTRACT_ARGV_PREFIX, ["--headless", "--no-header", "--"]);

  const validation = extractCommand.validate({
    inputs: [{ kind: "path", path: "packs/pack.pck" }],
    output: "exports/out",
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const plan = extractCommand.plan(validation.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: [
      "D:/fixtures/one.pck",
      "D:/fixtures/two 空间.pck",
    ],
    effectiveOutput: "D:/GDRE Work/exports/out",
  });
  assert.deepEqual(plan.argv, [
    ...EXTRACT_ARGV_PREFIX,
    "--disable-multithreading=true",
    "--disable-multithreading=false",
    "--extract=D:/fixtures/one.pck",
    "--extract=D:/fixtures/two 空间.pck",
    "--output=D:/GDRE Work/exports/out",
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, undefined);
  assert.deepEqual(plan.effects.reads, [
    "D:/fixtures/one.pck",
    "D:/fixtures/two 空间.pck",
  ]);
  assert.deepEqual(plan.effects.writes, [
    "D:/GDRE Work/exports/out",
    operation,
  ]);
  assert.equal(plan.effects.network, false);
  assert.equal(plan.effects.codeExecution, false);
  assert.equal(plan.effects.unknownScope, false);
});

test("extract planning requires resolved inputs and an effective destination and honors timeoutMs", () => {
  const validation = extractCommand.validate({
    inputs: [{ kind: "path", path: "packs/pack.pck" }],
    timeoutMs: 45_000,
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  assert.throws(
    () =>
      extractCommand.plan(validation.value, {
        workspace,
        operationDirectory: operation,
        effectiveOutput: "D:/out",
      }),
    /resolved extraction inputs/u,
  );
  assert.throws(
    () =>
      extractCommand.plan(validation.value, {
        workspace,
        operationDirectory: operation,
        resolvedInputs: ["D:/fixtures/one.pck"],
      }),
    /effective extraction output/u,
  );

  const plan = extractCommand.plan(validation.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  });
  assert.equal(plan.timeoutMs, 45_000);
  assert.deepEqual(plan.argv, [
    ...EXTRACT_ARGV_PREFIX,
    "--extract=D:/fixtures/one.pck",
    "--output=D:/out",
  ]);
});

test("extract descriptor exposes strict mutation metadata and selection fields", () => {
  assert.deepEqual(
    extractCommand.parameterDescriptors.map((parameter) => parameter.name),
    ["inputs", "output", "include", "exclude", "selection", "session", "workspace", "timeoutMs"],
  );
  const required = Object.fromEntries(
    extractCommand.parameterDescriptors.map((parameter) => [
      parameter.name,
      parameter.required,
    ]),
  );
  assert.deepEqual(required, {
    inputs: true,
    output: false,
    include: false,
    exclude: false,
    selection: false,
    session: false,
    workspace: false,
    timeoutMs: false,
  });
  const timeout = extractCommand.parameterDescriptors.find(
    (parameter) => parameter.name === "timeoutMs",
  );
  assert.equal(timeout?.defaultValue, undefined);
  const selection = extractCommand.parameterDescriptors.find(
    (parameter) => parameter.name === "selection",
  );
  assert.equal(selection?.defaultValue, "all");
  assert.deepEqual(extractCommand.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(extractCommand.inputSchema, extractInputSchema);
  assert.equal(extractCommand.exactArgv, extractCommand.argv);
  assert.deepEqual(extractCommand.argv, EXTRACT_ARGV_PREFIX);
  assert.ok(
    extractCommand.coverage.constraints.some((constraint) =>
      /key and checksum are deferred/u.test(constraint),
    ),
  );
  assert.ok(
    extractCommand.evidence.some(
      (evidence) =>
        evidence.status === "R+" &&
        evidence.source.includes("extraction-stdio.test.ts"),
    ),
  );

  const reference = generateCommandReference();
  assert.match(reference, /`gdre_extract`/u);
  assert.match(reference, /`extract`/u);
  assert.match(reference, /Supplied-key and checksum-override fields remain deferred/u);
});

test("extract planning emits ordered include/exclude patterns and the mode flag", () => {
  const filtered = extractCommand.validate({
    inputs: [{ kind: "path", path: "packs/pack.pck" }],
    include: ["res://**/*.gd", "*.gdc"],
    exclude: ["res://addons/**"],
  });
  assert.equal(filtered.ok, true);
  if (!filtered.ok) return;
  const filteredPlan = extractCommand.plan(filtered.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  });
  assert.deepEqual(filteredPlan.argv, [
    ...EXTRACT_ARGV_PREFIX,
    "--extract=D:/fixtures/one.pck",
    "--output=D:/out",
    "--include=res://**/*.gd",
    "--include=*.gdc",
    "--exclude=res://addons/**",
  ]);

  const scripts = extractCommand.validate({
    inputs: [{ kind: "path", path: "packs/pack.pck" }],
    selection: "scripts",
  });
  assert.equal(scripts.ok, true);
  if (!scripts.ok) return;
  const scriptsPlan = extractCommand.plan(scripts.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  });
  assert.deepEqual(scriptsPlan.argv, [
    ...EXTRACT_ARGV_PREFIX,
    "--extract=D:/fixtures/one.pck",
    "--output=D:/out",
    "--scripts-only",
  ]);

  const translations = extractCommand.validate({
    inputs: [{ kind: "path", path: "packs/pack.pck" }],
    selection: "translations",
  });
  assert.equal(translations.ok, true);
  if (!translations.ok) return;
  const translationsPlan = extractCommand.plan(translations.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/one.pck"],
    effectiveOutput: "D:/out",
  });
  assert.deepEqual(translationsPlan.argv, [
    ...EXTRACT_ARGV_PREFIX,
    "--extract=D:/fixtures/one.pck",
    "--output=D:/out",
    "--translation-only",
  ]);
});

test("extract is discoverable without displacing version, listing, or export-resources", () => {
  assert.equal(commandRegistry.length, 6);
  assert.equal(commandRegistry[0]?.toolName, "gdre_version");
  assert.equal(commandRegistry[1]?.toolName, "gdre_list_files");
  assert.equal(commandRegistry[2]?.toolName, "gdre_extract");
  assert.equal(commandRegistry[3]?.toolName, "gdre_export_resources");
  assert.equal(commandRegistry[4]?.toolName, "gdre_patch_translations");
  assert.equal(commandRegistry[5]?.toolName, "gdre_pck_patch");
  assert.equal(getCommandById("extract"), extractCommand);
  assert.equal(getCommandByToolName("gdre_extract"), extractCommand);
});

test("extract semantic evaluation refuses success without complete member and artifact evidence", async () => {
  const evaluation = await extractCommand.evaluate({
    exitCode: 0,
    signal: null,
    stdout: "Successfully loaded PCK!\nExtracted 2 files, no errors detected!\nExtraction operation complete in 00m00s\n",
    stderr: "",
    stdoutTruncated: false,
  });
  assert.equal(evaluation.status, "unknown");
  assert.equal(evaluation.rule, "gdre-extract-v1");
  assert.equal(evaluation.data, null);
  assert.match(evaluation.summary, /preflight|artifact|destination/u);
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

const successfulExtractResult = {
  schemaVersion: 1 as const,
  operationId: "550e8400-e29b-41d4-a716-446655440000",
  commandId: "extract" as const,
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
    rule: "gdre-extract-v1",
    summary: "Extraction evidence accepted.",
    evidence: [],
    data: {
      totalFiles: 2,
      selectedFiles: 2,
      extractedFiles: 2,
      outputPath: "D:/GDRE Work/exports/out",
      checksum: "default" as const,
      checksumCoverage: { scope: "all-members" as const, verifiedFiles: 2, skippedFiles: 0 },
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
  artifacts: { count: 2, items: [], truncated: false, complete: true },
  cleanup: { state: "confirmed" as const, trigger: null, actions: [], error: null },
  persistence: { state: "complete" as const, error: null },
  warnings: [],
};

test("extract output uses the shared envelope with typed extraction data", () => {
  const parsed = operationResultSchema.safeParse(successfulExtractResult);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  assert.equal(extractCommand.outputSchema, operationResultSchema);
  assert.equal(
    extractCommand.outputSchema.safeParse(successfulExtractResult).success,
    true,
  );

  assert.equal(
    operationResultSchema.safeParse({
      ...successfulExtractResult,
      commandId: "version",
    }).success,
    false,
  );
  assert.equal(
    operationResultSchema.safeParse({
      ...successfulExtractResult,
      commandId: "list-files",
    }).success,
    false,
  );
  assert.equal(
    operationResultSchema.safeParse({
      ...successfulExtractResult,
      semantic: { ...successfulExtractResult.semantic, data: null },
    }).success,
    true,
  );
});
