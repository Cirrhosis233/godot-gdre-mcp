import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import {
  PckPatchOperation,
  PckPatchOperationError,
} from "../src/pck-patch-operation.js";
import type { RuntimeManager } from "../src/runtime.js";
import type { OperationResult, RuntimeState } from "../src/types.js";
import {
  PCK_PATCH_DEFAULT_OUTPUT_BYTES,
  PCK_PATCH_INSPECTOR_FILE,
  createPckPatchFaultRunner,
  type PckPatchFaultContext,
  type PckPatchInspectorReport,
  type PckPatchScenario,
} from "./support/pck-patch-faults.js";

/**
 * Host adaptation acceptance at the existing Execution/ProcessRunner seam.
 *
 * Every observation below is a controlled fault substitute: independently
 * authored report literals and known bytes, never real native transaction
 * success. This file does not import pending native fixture helpers.
 */

type AnyRecord = Record<string, any>;

const TARGET_MEMBER = "res://data/replace.txt";
const RETAINED_MEMBER = "res://data/keep.txt";

const SOURCE_BYTES = Buffer.from("GDPC authored source package bytes\n", "utf8");
const ORIGINAL_TARGET = Buffer.from("original target payload v1\n", "utf8");
const RETAINED_BYTES = Buffer.from(
  "retained member bytes: unchanged by replacement\n",
  "utf8",
);
const REPLACEMENT_BYTES = Buffer.concat([
  Buffer.from("replacement payload v2:"),
  Buffer.from([0x00, 0x01, 0xff]),
  Buffer.from(":end\n"),
]);

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Default package product beside the admitted source for one operation. */
const defaultPatchedOutput = (
  source: string,
  operationDirectory: string,
): string =>
  path.join(
    path.dirname(source),
    `${path.parse(source).name}-patched-${path.basename(operationDirectory)}.pck`,
  );

const metadata = {
  formatVersion: 2,
  engineVersion: { major: 4, minor: 4, patch: 0 },
  encrypted: false,
} as const;

const sourceReport = (
  packagePath: string,
  members: readonly { logicalMember: string; bytes: Buffer }[] = [
    { logicalMember: TARGET_MEMBER, bytes: ORIGINAL_TARGET },
    { logicalMember: RETAINED_MEMBER, bytes: RETAINED_BYTES },
  ],
): PckPatchInspectorReport => ({
  schemaVersion: 1,
  ok: true,
  packagePath,
  metadata: { ...metadata, engineVersion: { ...metadata.engineVersion } },
  members: members.map((member) => ({
    logicalMember: member.logicalMember,
    size: member.bytes.byteLength,
    sha256: sha256(member.bytes),
  })),
  error: null,
});

const outputReport = (
  packagePath: string,
  options: {
    readonly replacementBytes?: Buffer;
    readonly retainedBytes?: Buffer;
    readonly omitRetained?: boolean;
    readonly extraMember?: boolean;
    readonly formatVersion?: number;
  } = {},
): PckPatchInspectorReport => {
  const members = [
    {
      logicalMember: RETAINED_MEMBER,
      bytes: options.retainedBytes ?? RETAINED_BYTES,
    },
    {
      logicalMember: TARGET_MEMBER,
      bytes: options.replacementBytes ?? REPLACEMENT_BYTES,
    },
  ].filter(
    (member) =>
      !(options.omitRetained === true && member.logicalMember === RETAINED_MEMBER),
  );
  if (options.extraMember === true) {
    members.push({ logicalMember: "res://data/extra.txt", bytes: Buffer.from("x\n") });
  }
  return {
    schemaVersion: 1,
    ok: true,
    packagePath,
    metadata: {
      formatVersion: options.formatVersion ?? 2,
      engineVersion: { major: 4, minor: 4, patch: 0 },
      encrypted: false,
    },
    members: members.map((member) => ({
      logicalMember: member.logicalMember,
      size: member.bytes.byteLength,
      sha256: sha256(member.bytes),
    })),
    error: null,
  };
};

const successScenario = (): PckPatchScenario => ({
  sourceReport: (context) => sourceReport(context.packagePath!),
  outputReport: (context) => outputReport(context.packagePath!),
  patch: () => ({ outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES }),
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly inputs: string;
  readonly source: string;
  readonly replacement: string;
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-exec-"));
  const workspace = path.join(root, "workspace");
  const inputs = path.join(workspace, "fixtures");
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(
    path.join(root, "native", PCK_PATCH_INSPECTOR_FILE),
    "# controlled inert inspector placeholder\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "native", "gdre-pck-combined-prepare.gd"),
    "# controlled inert combined preparation placeholder\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "native", "gdre-pck-combined-verify.gd"),
    "# controlled inert combined verification placeholder\n",
    "utf8",
  );
  await mkdir(inputs, { recursive: true });
  const source = path.join(inputs, "source.pck");
  const replacement = path.join(inputs, "replacement.bin");
  await writeFile(source, SOURCE_BYTES);
  await writeFile(replacement, REPLACEMENT_BYTES);
  return { root, workspace, inputs, source, replacement };
};

const makeConfig = (root: string): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
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
});

const runtimeState = (root: string): RuntimeState => ({
  health: "ready",
  registryVersion: "2.8.0-beta.2",
  targetVersion: "2.8.0-beta.2",
  actualVersion: "2.8.0-beta.2",
  comparison: "match",
  executable: path.join(root, "runtime", "gdre_tools.exe"),
  companions: [
    { path: path.join(root, "runtime", "gdre_tools.exe"), present: true, sha256: "a".repeat(64) },
    { path: path.join(root, "runtime", "gdre_tools.pck"), present: true, sha256: "b".repeat(64) },
    { path: path.join(root, "runtime", "GodotMonoDecompNativeAOT.dll"), present: true, sha256: "c".repeat(64) },
  ],
  exeSha256: "a".repeat(64),
  baselineHashesMatch: true,
  checkedAt: new Date().toISOString(),
  evidencePath: null,
  probe: {
    exitCode: 1,
    signal: null,
    stdout: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    stderr: { bytes: 0, text: "", truncated: false, utf8Valid: true, rawPath: null, textPath: null, complete: false },
    error: null,
  },
  warnings: [],
});

const openExecution = (
  root: string,
  scenario: PckPatchScenario,
  config: LoadedConfig = makeConfig(root),
): {
  readonly execution: ExecutionImpl;
  readonly observed: readonly PckPatchFaultContext[];
} => {
  const state = runtimeState(root);
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  const harness = createPckPatchFaultRunner(scenario);
  return {
    execution: new ExecutionImpl(config, manager, {
      processRunner: harness.runner,
    }),
    observed: harness.observed,
  };
};

const inputFor = (
  value: Fixture,
  extra: AnyRecord = {},
): AnyRecord => ({
  source: value.source,
  patches: [{ hostSource: value.replacement, logicalMember: TARGET_MEMBER }],
  ...extra,
});

const execute = async (
  execution: ExecutionImpl,
  input: AnyRecord,
  signal?: AbortSignal,
): Promise<OperationResult> =>
  execution.execute("pck-patch", input, {
    signal: signal ?? new AbortController().signal,
  });

const close = async (execution: ExecutionImpl, root: string): Promise<void> => {
  await execution.close("shutdown");
  await rm(root, { recursive: true, force: true });
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const kinds = (observed: readonly PckPatchFaultContext[]): string[] =>
  observed.map((entry) => entry.kind);

const semanticData = (result: OperationResult): AnyRecord => {
  const data = result.semantic.data as AnyRecord | null;
  assert.ok(data, "expected package-patch semantic data");
  return data;
};

const combinedTranslation = (workspace: string): AnyRecord => ({
  csv: path.join(workspace, "missing", "translations.csv"),
  resource: "res://i18n/translations.csv",
});

const assertCombinedPreparationFailure = (
  result: OperationResult,
  observed: readonly PckPatchFaultContext[],
): void => {
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "validation_failed");
  assert.equal(result.error?.stage, "validating");
  assert.notEqual(result.error?.code, "unsupported_capability");
  assert.equal(result.semantic.status, "not_evaluated");
  assert.equal(result.semantic.data, null);
  assert.equal(result.process.pid, null);
  assert.deepEqual([...observed], []);
};

test("combined requests enter host preparation and fail closed before any native launch", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, successScenario());
  try {
    const missing = path.join(value.workspace, "missing");
    const translation = combinedTranslation(value.workspace);
    const cases: AnyRecord[] = [
      { source: path.join(missing, "source.pck"), translations: [translation] },
      {
        source: path.join(missing, "source.pck"),
        patches: [],
        translations: [translation],
      },
      {
        source: value.source,
        patches: [],
        translations: [translation],
      },
      {
        source: path.join(missing, "source.pck"),
        patches: [],
        translations: [translation],
        locales: ["en", "zh"],
      },
    ];
    for (const input of cases) {
      const result = await execute(execution, input);
      assertCombinedPreparationFailure(result, observed);
    }
  } finally {
    await close(execution, value.root);
  }
});

test("combined prelaunch guards still precede preparation", async () => {
  const value = await fixture();
  const translation = combinedTranslation(value.workspace);
  const combined: AnyRecord = {
    source: path.join(value.workspace, "missing", "source.pck"),
    patches: [],
    translations: [translation],
  };

  const withSettings = openExecution(value.root, successScenario(), {
    ...makeConfig(value.root),
    settings: [
      { key: "General/download_plugins", type: "boolean", value: false },
    ],
  });
  try {
    const result = await execute(withSettings.execution, combined);
    assert.equal(result.error?.code, "validation_failed");
    assert.match(result.error?.message ?? "", /settings/iu);
    assert.deepEqual([...withSettings.observed], []);
  } finally {
    await withSettings.execution.close("shutdown");
  }

  const budgeted = openExecution(value.root, successScenario(), {
    ...makeConfig(value.root),
    timeouts: { maxMs: 1_000 },
  });
  try {
    const result = await execute(budgeted.execution, {
      ...combined,
      timeoutMs: 2_000,
    });
    assert.equal(result.error?.code, "validation_failed");
    assert.match(result.error?.message ?? "", /timeoutMs|maximum/iu);
    assert.deepEqual([...budgeted.observed], []);
  } finally {
    await budgeted.execution.close("shutdown");
  }

  const { execution, observed } = openExecution(value.root, successScenario());
  try {
    const controller = new AbortController();
    controller.abort({ kind: "cancelled" });
    const cancelled = await execute(execution, combined, controller.signal);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error?.code, "cancelled");
    assert.match(cancelled.error?.message ?? "", /cancelled before allocation/iu);
    assert.equal(cancelled.semantic.data, null);
    assert.deepEqual([...observed], []);

    const invalid = await execute(execution, {
      ...combined,
      translations: [
        translation,
        { csv: path.join(value.workspace, "other.csv"), resource: "res://i18n/other.csv" },
      ],
    });
    assert.equal(invalid.error?.code, "validation_failed");
    assert.equal(invalid.semantic.data, null);
    assert.deepEqual([...observed], []);
  } finally {
    await close(execution, value.root);
  }
});

test("controlled success adapts complete inspection content and output-package role", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, successScenario());
  try {
    const result = await execute(execution, inputFor(value));
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    assert.equal(result.status, "succeeded");
    const operation = result.paths.operation!;
    const expectedOutput = defaultPatchedOutput(value.source, operation);
    assert.equal(path.dirname(expectedOutput), value.inputs);
    assert.notEqual(expectedOutput, path.join(operation, "output", "result.pck"));
    assert.equal(result.paths.effectiveDestination, expectedOutput);
    assert.equal(result.error, null);

    const data = semanticData(result);
    assert.equal(data.completeness, "complete");
    assert.equal(data.outputPath, expectedOutput);
    assert.deepEqual(data.counts, {
      mappings: 1,
      verifiedReplacements: 1,
      verifiedRetainedMembers: 1,
      unverifiedFiles: 0,
    });
    assert.equal(data.reports.sourceInspection, path.join(operation, "pck-source-inspection", "report.json"));
    assert.equal(data.reports.outputInspection, path.join(operation, "pck-output-inspection", "report.json"));
    assert.equal(data.reports.verification, path.join(operation, "pck-patch", "verification.json"));
    assert.deepEqual(data.samples.replacements, [TARGET_MEMBER]);
    assert.deepEqual(data.samples.retainedMembers, [RETAINED_MEMBER]);
    assert.equal(data.samples.truncated, false);

    assert.deepEqual(kinds(observed), ["source-inspection", "patch", "output-inspection"]);
    const patch = observed[1]!;
    assert.ok(patch.argv.includes(`--pck-patch=${value.source}`));
    assert.ok(patch.argv.includes(`--output=${expectedOutput}`));
    assert.ok(
      patch.argv.includes(`--patch-file=${value.replacement}=${TARGET_MEMBER}`),
    );

    // The verified output package is the artifact; inspection/verification are
    // administrative evidence, not additional output artifacts.
    assert.equal(result.artifacts.count, 1);
    assert.deepEqual(result.artifacts.items, [
      {
        path: expectedOutput,
        role: "output-package",
        bytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES.byteLength,
        sha256: sha256(PCK_PATCH_DEFAULT_OUTPUT_BYTES),
      },
    ]);
    assert.equal(result.artifacts.complete, true);

    // Originals are unchanged and every evidence file is retained.
    assert.deepEqual(await readFile(value.source), SOURCE_BYTES);
    assert.deepEqual(await readFile(value.replacement), REPLACEMENT_BYTES);
    assert.deepEqual(await readFile(expectedOutput), PCK_PATCH_DEFAULT_OUTPUT_BYTES);
    for (const file of Object.values(data.reports) as string[]) {
      assert.equal(await exists(file), true, file);
    }
    const verification = JSON.parse(
      await readFile(data.reports.verification, "utf8"),
    ) as AnyRecord;
    assert.equal(verification.schemaVersion, 1);
    assert.equal(verification.rule, "gdre-pck-patch-v1");
    assert.equal(verification.completeness, "complete");
    // Verification must label the direct patch and output inspection stages
    // with their own observations, not reuse the output inspector for both.
    assert.equal(verification.patchProcess.exitCode, 0);
    assert.ok(verification.patchProcess.stdoutBytes > 0);
    assert.equal(verification.outputInspectionProcess.exitCode, 0);
    assert.equal(verification.outputInspectionProcess.signal, null);

    const manifest = JSON.parse(
      await readFile(result.paths.manifest!, "utf8"),
    ) as AnyRecord;
    assert.equal(manifest.effectiveParameters.source, value.source);
    assert.deepEqual(manifest.effectiveParameters.patches, [
      { hostSource: value.replacement, logicalMember: TARGET_MEMBER },
    ]);
    assert.equal(manifest.effectiveParameters.output, expectedOutput);
    assert.ok(manifest.invocation.argv.includes(`--pck-patch=${value.source}`));
    assert.ok(manifest.effects.reads.includes(value.source));
    assert.ok(manifest.effects.reads.includes(value.replacement));
    assert.ok(manifest.effects.writes.includes(expectedOutput));
    assert.ok(manifest.effects.writes.includes(data.reports.verification));
  } finally {
    await close(execution, value.root);
  }
});

test("inventory-only retained member spellings survive source and output validation", async () => {
  const value = await fixture();
  // These are valid retained source identities, not CLI mapping components.
  // Mapping grammar (=, quotes, edge spaces, trailing-dot segments) must not be
  // applied to the fixed inspector's inventory.
  const retained = [
    { logicalMember: "res://data/equal=name.txt", bytes: Buffer.from("retained equals\n", "utf8") },
    { logicalMember: "res://data/quote'name.txt", bytes: Buffer.from("retained quote\n", "utf8") },
    { logicalMember: "res://data/ leading.txt", bytes: Buffer.from("retained leading space\n", "utf8") },
    { logicalMember: "res://data/trailing.txt ", bytes: Buffer.from("retained trailing space\n", "utf8") },
    { logicalMember: "res://data/trailing./segment.txt", bytes: Buffer.from("retained trailing dot\n", "utf8") },
  ] as const;
  const sourceMembers = [
    { logicalMember: TARGET_MEMBER, bytes: ORIGINAL_TARGET },
    ...retained,
  ];
  const outputMembers = [
    { logicalMember: TARGET_MEMBER, bytes: REPLACEMENT_BYTES },
    ...retained,
  ];
  const { execution } = openExecution(value.root, {
    ...successScenario(),
    sourceReport: (context) => sourceReport(context.packagePath!, sourceMembers),
    outputReport: (context) => sourceReport(context.packagePath!, outputMembers),
    patch: () => ({ outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES }),
  });
  try {
    const result = await execute(execution, inputFor(value));
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    const data = semanticData(result);
    assert.equal(data.completeness, "complete");
    assert.equal(data.counts.verifiedReplacements, 1);
    assert.equal(data.counts.verifiedRetainedMembers, retained.length);
    assert.equal(data.samples.truncated, false);
    assert.deepEqual(
      [...data.samples.retainedMembers].sort(),
      retained.map((member) => member.logicalMember).sort(),
    );

    const verification = JSON.parse(
      await readFile(data.reports.verification, "utf8"),
    ) as AnyRecord;
    const expectedSource = sourceMembers.map((member) => ({
      logicalMember: member.logicalMember,
      size: member.bytes.byteLength,
      sha256: sha256(member.bytes),
    }));
    const expectedOutput = [
      {
        logicalMember: TARGET_MEMBER,
        size: REPLACEMENT_BYTES.byteLength,
        sha256: sha256(REPLACEMENT_BYTES),
      },
      ...expectedSource.slice(1),
    ];
    assert.deepEqual(verification.sourceInspection.members, expectedSource);
    assert.deepEqual(verification.outputInspection.members, expectedOutput);
    assert.deepEqual(
      verification.verifiedRetainedMembers,
      retained.map((member) => member.logicalMember),
    );
    assert.deepEqual(verification.verifiedReplacements, [TARGET_MEMBER]);
  } finally {
    await close(execution, value.root);
  }
});

test("a safe explicit output is honored without overwriting", async () => {
  const value = await fixture();
  const outputDirectory = path.join(value.workspace, "out");
  await mkdir(outputDirectory, { recursive: true });
  const explicit = path.join(outputDirectory, "patched.pck");
  const { execution, observed } = openExecution(value.root, successScenario());
  try {
    const result = await execute(
      execution,
      inputFor(value, { output: "out/patched.pck" }),
    );
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.paths.effectiveDestination, explicit);
    assert.equal(semanticData(result).outputPath, explicit);
    assert.deepEqual(await readFile(explicit), PCK_PATCH_DEFAULT_OUTPUT_BYTES);
    assert.ok(observed[1]!.argv.includes(`--output=${explicit}`));
    assert.deepEqual(await readFile(value.source), SOURCE_BYTES);
  } finally {
    await close(execution, value.root);
  }
});

test("verified content is not published as complete when the output inventory is not accepted", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, {
    ...successScenario(),
    outputReport: async (context) => {
      const report = outputReport(context.packagePath!);
      // Content inspection succeeds, then the retained output disappears before
      // the normal inventory can accept it.
      await rm(context.packagePath!, { force: true });
      return report;
    },
  });
  try {
    const result = await execute(execution, inputFor(value));
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "process_failed", result.error?.message);
    assert.match(result.error?.message ?? "", /inventory/iu);
    assert.deepEqual(kinds(observed), [
      "source-inspection",
      "patch",
      "output-inspection",
    ]);
    const data = semanticData(result);
    assert.equal(result.semantic.status, "unknown");
    assert.equal(data.completeness, "unknown");
    // Acquired inspection references and verified content observations remain.
    assert.notEqual(data.reports.sourceInspection, null);
    assert.notEqual(data.reports.outputInspection, null);
    assert.equal(await exists(data.reports.verification), true);
    assert.equal(data.counts.verifiedReplacements, 1);
    assert.equal(data.counts.verifiedRetainedMembers, 1);
    assert.ok(
      data.diagnostics.some((line: string) => /inventory was not accepted/iu.test(line)),
    );
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, false);
  } finally {
    await close(execution, value.root);
  }
});

test("native forward-slash markers are accepted for backslash host outputs", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, {
    ...successScenario(),
    patch: (context) => {
      assert.ok(context.outputPath !== null);
      // Real GDRE prints the destination with forward slashes while the host
      // effective output on Windows keeps backslashes.
      assert.ok(context.outputPath!.includes("\\"), context.outputPath);
      return {
        stdout: `\rPatched PCK file: ${context.outputPath!.replaceAll("\\", "/")}\n`,
        outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
      };
    },
  });
  try {
    const omitted = await execute(execution, inputFor(value));
    assert.equal(omitted.success, true, JSON.stringify(omitted.error));
    assert.equal(
      semanticData(omitted).outputPath,
      defaultPatchedOutput(value.source, omitted.paths.operation!),
    );

    await mkdir(path.join(value.workspace, "out"), { recursive: true });
    const explicitRelative = await execute(
      execution,
      inputFor(value, { output: "out/native-marker.pck" }),
    );
    assert.equal(
      explicitRelative.success,
      true,
      JSON.stringify(explicitRelative.error),
    );
    const explicit = path.join(value.workspace, "out", "native-marker.pck");
    assert.equal(semanticData(explicitRelative).outputPath, explicit);
    assert.deepEqual(
      await readFile(explicit),
      PCK_PATCH_DEFAULT_OUTPUT_BYTES,
    );
    assert.equal(observed.filter((entry) => entry.kind === "patch").length, 2);
  } finally {
    await close(execution, value.root);
  }
});

test("malformed, contradictory, wrong-package, duplicate, and encrypted source reports never succeed or mutate", async () => {
  const cases: readonly {
    readonly name: string;
    readonly scenario: PckPatchScenario;
    readonly code: RegExp;
    readonly completeness: "unknown" | "failed";
    readonly reportAcquired: boolean;
    readonly reportsParsed: boolean;
  }[] = [
    {
      name: "malformed JSON",
      scenario: { ...successScenario(), sourceReport: () => "malformed" },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "missing report",
      scenario: { ...successScenario(), sourceReport: () => "missing" },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: false,
      reportsParsed: false,
    },
    {
      name: "native ok:false",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          schemaVersion: 1,
          ok: false,
          packagePath: context.packagePath!,
          error: "file is not a standalone PCK",
        }),
      },
      code: /semantic_failed/u,
      completeness: "failed",
      reportAcquired: true,
      reportsParsed: true,
    },
    {
      name: "wrong package path",
      scenario: {
        ...successScenario(),
        sourceReport: (context) =>
          sourceReport(path.join(path.dirname(context.packagePath!), "other.pck")),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: true,
    },
    {
      name: "duplicate member",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            { logicalMember: TARGET_MEMBER, size: ORIGINAL_TARGET.byteLength, sha256: sha256(ORIGINAL_TARGET) },
            { logicalMember: TARGET_MEMBER, size: ORIGINAL_TARGET.byteLength, sha256: sha256(ORIGINAL_TARGET) },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "control character member",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: "res://data/control\u0001.txt",
              size: 1,
              sha256: sha256(Buffer.from("x")),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "backslash member spelling",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: "res://data/back\\slash.txt",
              size: 1,
              sha256: sha256(Buffer.from("x")),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "ambiguous absolute member spelling",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: "/data/absolute.txt",
              size: 1,
              sha256: sha256(Buffer.from("x")),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "ambiguous scheme member spelling",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: "file://data/scheme.txt",
              size: 1,
              sha256: sha256(Buffer.from("x")),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "dot traversal member spelling",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: "res://data/../escape.txt",
              size: 1,
              sha256: sha256(Buffer.from("x")),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "case-folded member collision",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          members: [
            {
              logicalMember: RETAINED_MEMBER,
              size: RETAINED_BYTES.byteLength,
              sha256: sha256(RETAINED_BYTES),
            },
            {
              logicalMember: "res://DATA/KEEP.TXT",
              size: RETAINED_BYTES.byteLength,
              sha256: sha256(RETAINED_BYTES),
            },
          ],
        }),
      },
      code: /semantic_unknown/u,
      completeness: "unknown",
      reportAcquired: true,
      reportsParsed: false,
    },
    {
      name: "encrypted metadata",
      scenario: {
        ...successScenario(),
        sourceReport: (context) => ({
          ...sourceReport(context.packagePath!),
          metadata: { ...metadata, encrypted: true },
        }),
      },
      code: /semantic_failed/u,
      completeness: "failed",
      reportAcquired: true,
      reportsParsed: true,
    },
  ];

  for (const entry of cases) {
    const value = await fixture();
    const { execution, observed } = openExecution(value.root, entry.scenario);
    try {
      const result = await execute(execution, inputFor(value));
      assert.equal(result.success, false, entry.name);
      assert.match(result.error?.code ?? "", entry.code, entry.name);
      assert.deepEqual(kinds(observed), ["source-inspection"], entry.name);
      // Rejections retain bounded semantic data, report existence and an
      // adapter verification record; they never launch a patch or audit output.
      const data = semanticData(result);
      assert.equal(data.completeness, entry.completeness, entry.name);
      assert.equal(
        data.reports.sourceInspection === null,
        !entry.reportAcquired,
        entry.name,
      );
      assert.ok(data.reports.verification.endsWith("verification.json"), entry.name);
      assert.equal(await exists(data.reports.verification), true, entry.name);
      const verification = JSON.parse(
        await readFile(data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stage, "source-inspection", entry.name);
      assert.equal(verification.stopped, false, entry.name);
      assert.equal(verification.reportsParsed, entry.reportsParsed, entry.name);
      assert.equal(
        verification.sourceReportObservation.exists,
        entry.reportAcquired,
        entry.name,
      );
      assert.equal(result.artifacts.count, 0, entry.name);
      assert.deepEqual(await readFile(value.source), SOURCE_BYTES, entry.name);
      assert.deepEqual(await readFile(value.replacement), REPLACEMENT_BYTES, entry.name);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("a missing source member is rejected after read-only inspection before any patch launch", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, {
    ...successScenario(),
    sourceReport: (context) =>
      sourceReport(context.packagePath!, [
        { logicalMember: RETAINED_MEMBER, bytes: RETAINED_BYTES },
      ]),
  });
  try {
    const result = await execute(execution, inputFor(value));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "validation_failed", result.error?.message);
    assert.match(result.error?.message ?? "", /not an existing source member/u);
    assert.deepEqual(kinds(observed), ["source-inspection"]);
    const data = semanticData(result);
    assert.equal(data.completeness, "failed");
    assert.equal(
      data.reports.sourceInspection,
      path.join(result.paths.operation!, "pck-source-inspection", "report.json"),
    );
    assert.ok(data.reports.verification.endsWith("verification.json"));
    const verification = JSON.parse(
      await readFile(data.reports.verification, "utf8"),
    ) as AnyRecord;
    assert.equal(verification.stage, "source-inspection");
    assert.equal(verification.reportsParsed, true);
    assert.equal(verification.sourceInspection.packagePath, value.source);
    assert.equal(result.artifacts.count, 0);
    assert.deepEqual(await readFile(value.source), SOURCE_BYTES);
  } finally {
    await close(execution, value.root);
  }
});

test("preparation rejects invalid inputs, aliases, collisions, and unsafe destinations without launching", async () => {
  const scenarios: readonly {
    readonly name: string;
    readonly prepare: (value: Fixture) => Promise<AnyRecord>;
    readonly code: RegExp;
    readonly before?: (value: Fixture) => Promise<void>;
  }[] = [
    {
      name: "missing source",
      prepare: async () => ({}),
      code: /validation_failed/u,
    },
    {
      name: "source equals replacement",
      prepare: async (value) => ({
        patches: [{ hostSource: value.source, logicalMember: TARGET_MEMBER }],
      }),
      code: /validation_failed/u,
    },
    {
      name: "canonical alias of the source as a replacement",
      prepare: async (value) => ({
        patches: [
          {
            hostSource: path.join(value.inputs, "..", "fixtures", "source.pck"),
            logicalMember: TARGET_MEMBER,
          },
        ],
      }),
      code: /validation_failed/u,
    },
    {
      name: "canonical alias of one replacement",
      prepare: async (value) => ({
        patches: [
          { hostSource: value.replacement, logicalMember: TARGET_MEMBER },
          {
            hostSource: path.join(value.inputs, "..", "fixtures", "replacement.bin"),
            logicalMember: "res://data/other.txt",
          },
        ],
      }),
      code: /validation_failed/u,
    },
    {
      name: "hardlinked replacements",
      prepare: async (value) => {
        const hardlink = path.join(value.inputs, "replacement-hardlink.bin");
        await link(value.replacement, hardlink);
        return {
          patches: [
            { hostSource: value.replacement, logicalMember: TARGET_MEMBER },
            { hostSource: hardlink, logicalMember: "res://data/other.txt" },
          ],
        };
      },
      code: /validation_failed/u,
    },
    {
      name: "existing output",
      prepare: async (value) => {
        const outputDirectory = path.join(value.workspace, "occupied");
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(path.join(outputDirectory, "result.pck"), "occupied\n");
        return { output: "occupied/result.pck" };
      },
      code: /path_unsupported/u,
    },
    {
      name: "occupied output temporary sibling",
      prepare: async (value) => {
        const outputDirectory = path.join(value.workspace, "tmpoccup");
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(path.join(outputDirectory, "result.pck.tmp"), "occupied\n");
        return { output: "tmpoccup/result.pck" };
      },
      code: /path_unsupported/u,
    },
    {
      name: "output aliases the source",
      prepare: async (value) => ({ output: value.source }),
      code: /path_unsupported/u,
    },
    {
      name: "output overlaps operation administrative metadata",
      prepare: async () => ({ output: ".gdre/patched.pck" }),
      code: /path_unsupported/u,
    },
    {
      name: "missing explicit output parent",
      prepare: async () => ({ output: "missing-directory/patched.pck" }),
      code: /path_unsupported/u,
    },
  ];

  for (const entry of scenarios) {
    const value = await fixture();
    const { execution, observed } = openExecution(value.root, successScenario());
    try {
      const overrides = await entry.prepare(value);
      const input = {
        ...inputFor(value, overrides),
        ...(entry.name === "missing source"
          ? { source: path.join(value.inputs, "absent.pck") }
          : {}),
      };
      const result = await execute(execution, input);
      assert.equal(result.success, false, entry.name);
      assert.match(result.error?.code ?? "", entry.code, `${entry.name}: ${result.error?.message}`);
      assert.deepEqual(kinds(observed), [], entry.name);
      assert.deepEqual(await readFile(value.source), SOURCE_BYTES, entry.name);
      assert.deepEqual(await readFile(value.replacement), REPLACEMENT_BYTES, entry.name);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("missing fixed inspector fails closed before any native launch", async () => {
  const value = await fixture();
  await rm(path.join(value.root, "native", PCK_PATCH_INSPECTOR_FILE));
  const { execution, observed } = openExecution(value.root, successScenario());
  try {
    const result = await execute(execution, inputFor(value));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "unsupported_capability", result.error?.message);
    assert.match(result.error?.message ?? "", /inspector/u);
    assert.deepEqual(kinds(observed), []);
    assert.deepEqual(await readFile(value.source), SOURCE_BYTES);
  } finally {
    await close(execution, value.root);
  }
});

test("output inspection and content contradictions never become success", async () => {
  const cases: readonly {
    readonly name: string;
    readonly scenario: PckPatchScenario;
    readonly inspections: readonly string[];
  }[] = [
    {
      name: "malformed output report",
      scenario: { ...successScenario(), outputReport: () => "malformed" },
      inspections: ["source-inspection", "patch", "output-inspection"],
    },
    {
      name: "metadata mismatch",
      scenario: {
        ...successScenario(),
        outputReport: (context) => outputReport(context.packagePath!, { formatVersion: 3 }),
      },
      inspections: ["source-inspection", "patch", "output-inspection"],
    },
    {
      name: "wrong replacement bytes",
      scenario: {
        ...successScenario(),
        outputReport: (context) =>
          outputReport(context.packagePath!, { replacementBytes: Buffer.from("tampered\n") }),
      },
      inspections: ["source-inspection", "patch", "output-inspection"],
    },
    {
      name: "missing retained member",
      scenario: {
        ...successScenario(),
        outputReport: (context) =>
          outputReport(context.packagePath!, { omitRetained: true }),
      },
      inspections: ["source-inspection", "patch", "output-inspection"],
    },
    {
      name: "extra output member",
      scenario: {
        ...successScenario(),
        outputReport: (context) =>
          outputReport(context.packagePath!, { extraMember: true }),
      },
      inspections: ["source-inspection", "patch", "output-inspection"],
    },
    {
      name: "missing success marker",
      scenario: {
        ...successScenario(),
        patch: () => ({
          stdout: "patch completed without the marker\n",
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        }),
      },
      inspections: ["source-inspection", "patch"],
    },
    {
      name: "marker names a suffix lookalike destination",
      scenario: {
        ...successScenario(),
        patch: (context) => ({
          stdout: `\rPatched PCK file: ${context.outputPath!}.bak\n`,
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        }),
      },
      inspections: ["source-inspection", "patch"],
    },
    {
      name: "marker names a prefix lookalike destination",
      scenario: {
        ...successScenario(),
        patch: (context) => ({
          stdout: `\rPatched PCK file: ${context.outputPath!}-other.pck\n`,
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        }),
      },
      inspections: ["source-inspection", "patch"],
    },
    {
      name: "exit zero with patch error evidence",
      scenario: {
        ...successScenario(),
        patch: () => ({
          stdout: "Error: failed to write patching PCK: no space\n",
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        }),
      },
      inspections: ["source-inspection", "patch"],
    },
    {
      name: "success marker but missing output",
      scenario: {
        ...successScenario(),
        patch: () => ({
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
          removeOutputAfterWrite: true,
        }),
      },
      inspections: ["source-inspection", "patch"],
    },
    {
      name: "natural patch failure",
      scenario: {
        ...successScenario(),
        patch: () => ({ exitCode: 1, writeOutput: false }),
      },
      inspections: ["source-inspection", "patch"],
    },
  ];

  for (const entry of cases) {
    const value = await fixture();
    const { execution, observed } = openExecution(value.root, entry.scenario);
    try {
      const result = await execute(execution, inputFor(value));
      assert.equal(result.success, false, entry.name);
      assert.deepEqual(kinds(observed), entry.inspections, entry.name);
      assert.equal(result.artifacts.count, 0, entry.name);
      assert.equal(result.artifacts.complete, false, entry.name);
      assert.equal(
        await exists(path.join(result.paths.operation!, "output", "result.pck")),
        false,
        `${entry.name}: a failed product is never redirected to operation storage`,
      );
      const data = result.semantic.data as AnyRecord | null;
      if (data !== null) {
        assert.notEqual(data.completeness, "complete", entry.name);
        assert.ok(
          ["failed", "partial", "unknown"].includes(data.completeness),
          entry.name,
        );
        assert.equal(data.outputPath, result.paths.effectiveDestination, entry.name);
      }
      assert.deepEqual(await readFile(value.source), SOURCE_BYTES, entry.name);
      assert.deepEqual(await readFile(value.replacement), REPLACEMENT_BYTES, entry.name);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("natural stop and unconfirmed cleanup retain acquired evidence without post-stop audit", async () => {
  const cases: readonly {
    readonly name: string;
    readonly scenario: PckPatchScenario;
    readonly status: OperationResult["status"];
    readonly code: string;
  }[] = [
    {
      name: "timeout",
      scenario: {
        ...successScenario(),
        patch: () => ({ exitCode: null, trigger: "timeout", writeOutput: false }),
      },
      status: "timed_out",
      code: "execution_timeout",
    },
    {
      name: "cancellation",
      scenario: {
        ...successScenario(),
        patch: () => ({ exitCode: null, trigger: "cancel", writeOutput: false }),
      },
      status: "cancelled",
      code: "cancelled",
    },
    {
      name: "disconnect",
      scenario: {
        ...successScenario(),
        patch: () => ({ exitCode: null, trigger: "disconnect", writeOutput: false }),
      },
      status: "interrupted",
      code: "disconnected",
    },
    {
      name: "timeout after a partial output observation",
      scenario: {
        ...successScenario(),
        patch: () => ({
          exitCode: null,
          trigger: "timeout",
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        }),
      },
      status: "timed_out",
      code: "execution_timeout",
    },
    {
      name: "unconfirmed cleanup",
      scenario: {
        ...successScenario(),
        patch: () => ({
          exitCode: 0,
          cleanup: {
            state: "unconfirmed",
            trigger: null,
            actions: [],
            error: "owned process tree could not be confirmed clean",
          },
        }),
      },
      status: "failed",
      code: "cleanup_failed",
    },
  ];

  for (const entry of cases) {
    const value = await fixture();
    const { execution, observed } = openExecution(value.root, entry.scenario);
    try {
      const result = await execute(execution, inputFor(value));
      assert.equal(result.success, false, entry.name);
      assert.equal(result.status, entry.status, entry.name);
      assert.equal(result.error?.code, entry.code, entry.name);
      assert.deepEqual(kinds(observed), ["source-inspection", "patch"], entry.name);
      // Acquired streams and the source inspection report remain available.
      assert.ok(result.stdout.rawPath !== null && result.stdout.textPath !== null, entry.name);
      const operation = result.paths.operation!;
      assert.equal(
        await exists(path.join(operation, "pck-source-inspection", "report.json")),
        true,
        entry.name,
      );
      assert.equal(result.artifacts.count, 0, entry.name);
      assert.equal(result.artifacts.complete, false, entry.name);
      if (entry.name === "timeout after a partial output observation") {
        // Available residue is retained as unverified, never as a verified
        // output and never via an exhaustive post-stop audit.
        const data = result.semantic.data as AnyRecord;
        assert.ok(data, entry.name);
        assert.notEqual(data.completeness, "complete", entry.name);
        assert.ok(data.counts.unverifiedFiles >= 1, entry.name);
        const expectedOutput = defaultPatchedOutput(
          value.source,
          result.paths.operation!,
        );
        assert.ok(
          data.samples.unverifiedFiles.some(
            (file: string) =>
              path.resolve(file) === path.resolve(expectedOutput),
          ),
          entry.name,
        );
      }
    } finally {
      await close(execution, value.root);
    }
  }
});

test("stopped launches keep bounded unverified observations without parsing reports or re-fingerprinting inputs", async () => {
  const patchStops = [
    {
      name: "timeout",
      reason: { kind: "timeout" as const },
      trigger: "timeout" as const,
      status: "timed_out" as const,
      code: "execution_timeout",
    },
    {
      name: "cancellation",
      reason: "cancel",
      trigger: "cancel" as const,
      status: "cancelled" as const,
      code: "cancelled",
    },
    {
      name: "disconnect",
      reason: "disconnect",
      trigger: "disconnect" as const,
      status: "interrupted" as const,
      code: "disconnected",
    },
  ];

  for (const entry of patchStops) {
    const value = await fixture();
    const controller = new AbortController();
    const { execution, observed } = openExecution(value.root, {
      ...successScenario(),
      patch: () => {
        // A real stop aborts the call-owned signal while the native process
        // may already have created partial output.
        controller.abort(entry.reason);
        return {
          exitCode: null,
          trigger: entry.trigger,
          outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES,
        };
      },
    });
    try {
      const result = await execute(execution, inputFor(value), controller.signal);
      assert.equal(result.success, false, entry.name);
      assert.equal(result.status, entry.status, entry.name);
      assert.equal(result.error?.code, entry.code, entry.name);
      assert.deepEqual(kinds(observed), ["source-inspection", "patch"], entry.name);
      const data = semanticData(result);
      assert.equal(data.completeness, "unknown", entry.name);
      assert.ok(data.counts.unverifiedFiles >= 1, entry.name);
      const expectedOutput = defaultPatchedOutput(
        value.source,
        result.paths.operation!,
      );
      assert.ok(
        data.samples.unverifiedFiles.some(
          (file: string) =>
            path.resolve(file) === path.resolve(expectedOutput),
        ),
        entry.name,
      );
      assert.equal(result.artifacts.count, 0, entry.name);
      assert.equal(result.artifacts.complete, false, entry.name);
      const verification = JSON.parse(
        await readFile(data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true, entry.name);
      assert.equal(verification.reportsParsed, false, entry.name);
      assert.equal(verification.inputFingerprintsRechecked, false, entry.name);
      assert.ok(
        (verification.availableFiles as AnyRecord[]).some(
          (file) =>
            file.exists === true &&
            path.resolve(String(file.path)) === path.resolve(expectedOutput),
        ),
        entry.name,
      );
    } finally {
      await close(execution, value.root);
    }
  }

  // A stopped source inspection retains acquired report existence without
  // parsing it, and never launches the patch.
  {
    const value = await fixture();
    const controller = new AbortController();
    const { execution, observed } = openExecution(value.root, {
      ...successScenario(),
      sourceReport: (context) => {
        controller.abort({ kind: "timeout" });
        return sourceReport(context.packagePath!);
      },
      inspectionOutcome: (context) =>
        context.kind === "source-inspection"
          ? { exitCode: 0, trigger: "timeout" }
          : {},
    });
    try {
      const result = await execute(execution, inputFor(value), controller.signal);
      assert.equal(result.success, false);
      assert.equal(result.status, "timed_out");
      assert.equal(result.error?.code, "execution_timeout");
      assert.deepEqual(kinds(observed), ["source-inspection"]);
      const data = semanticData(result);
      assert.equal(data.completeness, "unknown");
      assert.notEqual(data.reports.sourceInspection, null);
      assert.equal(result.artifacts.count, 0);
      const verification = JSON.parse(
        await readFile(data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "source-inspection");
      assert.equal(verification.reportsParsed, false);
      assert.equal(verification.inputFingerprintsRechecked, false);
      assert.equal(verification.sourceReportObservation.exists, true);
    } finally {
      await close(execution, value.root);
    }
  }

  // A stopped output inspection must not parse its report or re-fingerprint
  // inputs even when the runner reports exit code 0 alongside a stop trigger.
  const value = await fixture();
  const controller = new AbortController();
  const changedReplacement = Buffer.from("changed during stopped inspection\n");
  const { execution, observed } = openExecution(value.root, {
    ...successScenario(),
    outputReport: async () => {
      controller.abort({ kind: "timeout" });
      await writeFile(value.replacement, changedReplacement);
      return "malformed" as const;
    },
    inspectionOutcome: (context) =>
      context.kind === "output-inspection"
        ? { exitCode: 0, trigger: "timeout" }
        : {},
  });
  try {
    const result = await execute(execution, inputFor(value), controller.signal);
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.deepEqual(kinds(observed), ["source-inspection", "patch", "output-inspection"]);
    const data = semanticData(result);
    assert.equal(data.completeness, "unknown");
    // The unparsed report is not referenced as acquired inspection evidence.
    assert.equal(data.reports.outputInspection, null);
    assert.equal(result.artifacts.count, 0);
    const verification = JSON.parse(
      await readFile(data.reports.verification, "utf8"),
    ) as AnyRecord;
    assert.equal(verification.stopped, true);
    assert.equal(verification.stage, "output-inspection");
    assert.equal(verification.reportsParsed, false);
    assert.equal(verification.inputFingerprintsRechecked, false);
    assert.deepEqual(await readFile(value.replacement), changedReplacement);
  } finally {
    await close(execution, value.root);
  }
});

test("launch revalidation rejects replacement and destination changes after read-only inspection", async () => {
  const cases: readonly {
    readonly name: string;
    readonly code: RegExp;
  }[] = [
    { name: "replacement content changed", code: /path_unsupported/u },
    { name: "output appeared after preparation", code: /path_unsupported/u },
  ];

  for (const [index, entry] of cases.entries()) {
    const value = await fixture();
    const outputDirectory = path.join(value.workspace, "explicit");
    await mkdir(outputDirectory, { recursive: true });
    const explicit = path.join(outputDirectory, "patched.pck");
    const scenario: PckPatchScenario = {
      ...successScenario(),
      afterSourceInspection: async () => {
        if (index === 0) {
          await writeFile(value.replacement, Buffer.from("changed after inspection\n"));
        } else {
          await writeFile(explicit, "caller-created output\n");
        }
      },
    };
    const { execution, observed } = openExecution(value.root, scenario);
    try {
      const result = await execute(
        execution,
        inputFor(value, { output: "explicit/patched.pck" }),
      );
      assert.equal(result.success, false, entry.name);
      assert.match(result.error?.code ?? "", entry.code, entry.name);
      assert.deepEqual(kinds(observed), ["source-inspection"], entry.name);
      assert.equal(await exists(explicit), index === 1, entry.name);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("overlapping independent calls keep per-call state, evidence, and outputs", async () => {
  const value = await fixture();
  const secondInputs = path.join(value.workspace, "second");
  await mkdir(secondInputs, { recursive: true });
  const secondSource = path.join(secondInputs, "source-b.pck");
  const secondReplacement = path.join(secondInputs, "replacement-b.bin");
  await writeFile(secondSource, SOURCE_BYTES);
  await writeFile(secondReplacement, REPLACEMENT_BYTES);
  const scenario: PckPatchScenario = {
    ...successScenario(),
    sourceReport: (context) => sourceReport(context.packagePath!),
    outputReport: (context) => outputReport(context.packagePath!),
    inspectionKind: (context) =>
      path.basename(context.packagePath ?? "").includes("-patched-")
        ? "output-inspection"
        : "source-inspection",
  };
  const { execution, observed } = openExecution(value.root, scenario);
  try {
    const [first, second] = await Promise.all([
      execute(execution, inputFor(value)),
      execute(
        execution,
        {
          source: secondSource,
          patches: [
            { hostSource: secondReplacement, logicalMember: TARGET_MEMBER },
          ],
        },
      ),
    ]);
    for (const result of [first, second]) {
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(semanticData(result).completeness, "complete");
    }
    assert.notEqual(first.operationId, second.operationId);
    const firstOutput = semanticData(first).outputPath as string;
    const secondOutput = semanticData(second).outputPath as string;
    assert.notEqual(firstOutput, secondOutput);
    assert.equal(
      firstOutput,
      defaultPatchedOutput(value.source, first.paths.operation!),
    );
    assert.equal(
      secondOutput,
      defaultPatchedOutput(secondSource, second.paths.operation!),
    );
    assert.equal(path.dirname(firstOutput), value.inputs);
    assert.equal(path.dirname(secondOutput), secondInputs);
    assert.equal(await exists(firstOutput), true);
    assert.equal(await exists(secondOutput), true);
    assert.equal(kinds(observed).filter((kind) => kind === "patch").length, 2);
  } finally {
    await close(execution, value.root);
  }
});

test("sibling default collision fails at preparation without a Temp fallback", async () => {
  for (const occupiedKind of ["output", "temporary"] as const) {
    const value = await fixture();
    const operationDirectory = path.join(
      value.root,
      "operations",
      `fixed-${occupiedKind}`,
    );
    await mkdir(operationDirectory, { recursive: true });
    const expectedOutput = defaultPatchedOutput(
      value.source,
      operationDirectory,
    );
    const occupied =
      occupiedKind === "output" ? expectedOutput : `${expectedOutput}.tmp`;
    await writeFile(occupied, "occupied\n");
    const operation = new PckPatchOperation({
      workspace: value.workspace,
      operationDirectory,
      input: {
        source: value.source,
        patches: [
          { hostSource: value.replacement, logicalMember: TARGET_MEMBER },
        ],
      },
      signal: new AbortController().signal,
      inspectorScriptPath: path.join(
        value.root,
        "native",
        PCK_PATCH_INSPECTOR_FILE,
      ),
      prepareScriptPath: path.join(
        value.root,
        "native",
        "gdre-pck-combined-prepare.gd",
      ),
      verifyScriptPath: path.join(
        value.root,
        "native",
        "gdre-pck-combined-verify.gd",
      ),
    });
    try {
      await assert.rejects(
        operation.prepare(),
        (error: unknown) =>
          error instanceof PckPatchOperationError &&
          error.code === "path_unsupported" &&
          (occupiedKind === "output"
            ? /already exists/u
            : /temporary sibling is occupied/u
          ).test(error.message),
        occupiedKind,
      );
      assert.equal(await readFile(occupied, "utf8"), "occupied\n");
      assert.equal(
        await exists(path.join(operationDirectory, "output")),
        false,
        "no internal fallback destination was created",
      );
      assert.deepEqual(await readFile(value.source), SOURCE_BYTES);
      assert.deepEqual(await readFile(value.replacement), REPLACEMENT_BYTES);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});
