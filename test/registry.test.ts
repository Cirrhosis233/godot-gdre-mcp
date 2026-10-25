import assert from "node:assert/strict";
import test from "node:test";
import {
  commandRegistry,
  extractCommand,
  getCommandById,
  listFilesCommand,
  versionCommand,
} from "../src/registry.js";
import { operationResultSchema, versionInputSchema } from "../src/schemas.js";
import { generateCommandReference } from "../src/reference.js";
const stream = {
  bytes: 0,
  text: "",
  truncated: false,
  utf8Valid: true,
  rawPath: "D:/workspace/.gdre/operations/op/stdout.bin",
  textPath: "D:/workspace/.gdre/operations/op/stdout.txt",
  complete: true,
};

const successfulVersionResult = {
  schemaVersion: 1 as const,
  operationId: "550e8400-e29b-41d4-a716-446655440000",
  commandId: "version",
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
      {
        path: "D:/godre/vendor/GDRE_tools/gdre_tools.exe",
        present: true,
        sha256: "598c75267729aca4b7aa7bcc06ddd428dbe76760cbed0d0fdcdb02a089d7983d",
      },
      {
        path: "D:/godre/vendor/GDRE_tools/gdre_tools.pck",
        present: true,
        sha256: "188f88b0e9bf581c445a2ac2280ed09d8987ff28311c971609e7c5cc6f3b5992",
      },
      {
        path: "D:/godre/vendor/GDRE_tools/GodotMonoDecompNativeAOT.dll",
        present: true,
        sha256: "9e23279a04ba98032398ec83454e4b9402393ea8a77d425ed4ef691ace8cd5a9",
      },
    ],
    exeSha256: "598c75267729aca4b7aa7bcc06ddd428dbe76760cbed0d0fdcdb02a089d7983d",
    baselineHashesMatch: true,
    checkedAt: "2026-10-18T10:00:00.000Z",
    evidencePath: "D:/workspace/.gdre/startup/op.json",
    probe: {
      exitCode: 1,
      signal: null,
      stdout: { ...stream, bytes: 30, text: "Godot RE Tools v2.8.0-beta.2\r\n" },
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
  process: { pid: 1234, exitCode: 1, signal: null, spawnError: null },
  semantic: {
    status: "succeeded" as const,
    rule: "gdre-version-line-v1",
    summary: "GDRE version reported successfully.",
    evidence: ["Natural exit 1; recognized version line."],
    data: { version: "2.8.0-beta.2" },
  },
  paths: {
    workspace: "D:/workspace",
    operation: "D:/workspace/.gdre/operations/op",
    output: "D:/workspace/.gdre/operations/op/output",
    effectiveDestination: null,
    manifest: "D:/workspace/.gdre/operations/op/manifest.json",
    artifactInventory: "D:/workspace/.gdre/operations/op/artifacts.json",
  },
  stdout: { ...stream, bytes: 30, text: "Godot RE Tools v2.8.0-beta.2\r\n" },
  stderr: stream,
  artifacts: { count: 0, items: [], truncated: false, complete: true },
  cleanup: { state: "not_needed" as const, trigger: null, actions: [], error: null },
  persistence: { state: "complete" as const, error: null },
  warnings: [],
};

test("registry contains the version, accepted list-files, extract, export-resources, patch-translations, and pck-patch descriptors", () => {
  assert.equal(commandRegistry.length, 6);
  assert.equal(commandRegistry[0]?.id, "version");
  assert.equal(commandRegistry[0]?.toolName, "gdre_version");
  assert.equal(commandRegistry[1]?.id, "list-files");
  assert.equal(commandRegistry[1]?.toolName, "gdre_list_files");
  assert.equal(commandRegistry[2]?.id, "extract");
  assert.equal(commandRegistry[2]?.toolName, "gdre_extract");
  assert.equal(commandRegistry[3]?.id, "export-resources");
  assert.equal(commandRegistry[3]?.toolName, "gdre_export_resources");
  assert.equal(commandRegistry[4]?.id, "patch-translations");
  assert.equal(commandRegistry[4]?.toolName, "gdre_patch_translations");
  assert.equal(commandRegistry[5]?.id, "pck-patch");
  assert.equal(commandRegistry[5]?.toolName, "gdre_pck_patch");
  assert.equal(getCommandById("version"), versionCommand);
  assert.equal(getCommandById("extract"), extractCommand);
});

test("version input is strict and bounded", () => {
  assert.equal(versionInputSchema.safeParse({}).success, true);
  assert.equal(
    versionInputSchema.safeParse({ workspace: "D:/GDRE Work/示例", timeoutMs: 10_000 })
      .success,
    true,
  );
  assert.equal(
    versionInputSchema.safeParse({ workspace: "relative/workspace" }).success,
    false,
  );
  assert.equal(versionInputSchema.safeParse({ timeoutMs: 0 }).success, false);
  assert.equal(versionInputSchema.safeParse({ timeoutMs: 3_600_001 }).success, false);
  assert.equal(versionInputSchema.safeParse({ args: ["--version"] }).success, false);
  assert.equal(versionInputSchema.safeParse({ output: "out" }).success, false);
});

test("registry descriptors are the authoritative MCP input schema", () => {
  const shape = versionInputSchema.shape;
  const schemaNames = Object.keys(shape).sort();
  const descriptorNames = versionCommand.parameterDescriptors.map((parameter) => parameter.name).sort();
  assert.deepEqual(schemaNames, descriptorNames);
  for (const descriptor of versionCommand.parameterDescriptors) {
    const field = shape[descriptor.name];
    assert.ok(field !== undefined);
    assert.equal(field.isOptional(), !descriptor.required);
  }
  const timeout = versionCommand.parameterDescriptors.find((parameter) => parameter.name === "timeoutMs");
  assert.equal(timeout?.defaultValue, undefined);
  assert.equal(versionInputSchema.safeParse({ timeoutMs: 3_600_000 }).success, true);
  assert.equal(versionInputSchema.safeParse({ timeoutMs: 3_600_001 }).success, false);
  assert.equal(versionCommand.inputSchema, versionInputSchema);
  assert.equal(versionCommand.outputSchema, operationResultSchema);
});

test("aliases, exact argv, and generated reference agree", () => {
  assert.deepEqual(versionCommand.aliases, ["--version"]);
  assert.deepEqual(versionCommand.cliSpellings, ["--gdre-version", "--version"]);
  assert.deepEqual(versionCommand.argv, ["--headless", "--gdre-version"]);
  assert.deepEqual(versionCommand.exactArgv, versionCommand.argv);

  const reference = generateCommandReference();
  assert.match(reference, /`gdre_version`/u);
  assert.match(reference, /`version`/u);
  assert.ok(reference.includes('`["--headless","--gdre-version"]`'));
  assert.match(reference, /read-only=true, destructive=false, idempotent=true, open-world=false/u);
});

test("generated reference links sources and separates expandable coverage lists", () => {
  const reference = generateCommandReference();
  assert.ok(reference.includes("[`gdre_version`](#gdre_version)"));
  assert.ok(reference.includes("**R+** for successful runtime fixtures"));
  assert.ok(reference.includes("<details>\n<summary>Evidence and coverage</summary>\n\n"));
  assert.ok(reference.includes("[test/stdio.test.ts](../test/stdio.test.ts)"));
  assert.ok(reference.includes("[native/gdre-export-preflight.gd](../native/gdre-export-preflight.gd)"));
  assert.ok(reference.includes("[docs/operation-contract.md](../docs/operation-contract.md) §2.2"));
  assert.ok(reference.includes("\n##### Constraints\n\n- "));
  assert.ok(reference.includes("\n##### Prerequisites\n\n- "));
  assert.equal((reference.match(/<details>/gu) ?? []).length, commandRegistry.length);
  assert.equal((reference.match(/<\/details>/gu) ?? []).length, commandRegistry.length);
  for (const command of commandRegistry) {
    for (const constraint of command.coverage.constraints) {
      assert.ok(reference.includes(`- ${constraint}\n`));
    }
    for (const prerequisite of command.coverage.prerequisites) {
      assert.ok(reference.includes(`- ${prerequisite}\n`));
    }
  }
});

test("output schema accepts a literal successful contract result", () => {
  const parsed = operationResultSchema.safeParse(successfulVersionResult);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.semantic.data, { version: "2.8.0-beta.2" });
  }

  assert.equal(
    operationResultSchema.safeParse({ ...successfulVersionResult, unexpected: true }).success,
    false,
  );
});

test("public plans apply only explicitly supplied timeout policies", () => {
  const context = {
    workspace: "D:/workspace",
    operationDirectory: "D:/workspace/.gdre/operations/op",
    resolvedInputs: ["D:/workspace/input.pck"],
    effectiveOutput: "D:/workspace/output",
  };
  for (const timeoutMs of [undefined, 1250]) {
    assert.equal(versionCommand.plan({ timeoutMs }, context).timeoutMs, timeoutMs);
    const input = { inputs: [{ kind: "path" as const, path: "input.pck" }], timeoutMs };
    assert.equal(listFilesCommand.plan(input, context).timeoutMs, timeoutMs);
    assert.equal(extractCommand.plan(input, context).timeoutMs, timeoutMs);
  }
});

test("typed hooks preserve the version invocation and semantic rule", () => {
  const validation = versionCommand.validate({ timeoutMs: 10_000 });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const plan = versionCommand.plan(validation.value, {
    workspace: "D:/workspace",
    operationDirectory: "D:/workspace/.gdre/operations/op",
  });
  assert.deepEqual(plan.argv, ["--headless", "--gdre-version"]);
  assert.equal(plan.timeoutMs, 10_000);

  const evaluation = versionCommand.evaluate({
    exitCode: 1,
    signal: null,
    stdout: "﻿Godot RE Tools v2.8.0-beta.2\r\n",
    stderr: "",
    stdoutTruncated: false,
  });
  assert.equal(evaluation.status, "succeeded");
  assert.deepEqual(evaluation.data, { version: "2.8.0-beta.2" });
});

test("version evaluation refuses a truncated stdout observation", () => {
  const evaluation = versionCommand.evaluate({
    exitCode: 1,
    signal: null,
    stdout: "Godot RE Tools v2.8.0-beta.2",
    stderr: "",
    stdoutTruncated: true,
  });
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /truncated/u);
  assert.equal(evaluation.data, null);
});
