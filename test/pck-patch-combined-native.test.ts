import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OperationPaths } from "../src/storage.js";
import {
  inspectOwnedPck,
  nativePath,
  pckPatchFixtureExpectedMetadata,
  readIndependentFormat2PckFile,
  runOwnedPckCommand,
  sha256File,
  type PckInspectRun,
} from "./support/pck-patch-fixtures.js";
import {
  combinedFixtureExpectedExplicitEn,
  combinedFixtureExpectedOmittedJa,
  combinedFixtureExpectedOmittedJaFromZh,
  combinedFixtureExplicitEnCsv,
  combinedFixtureNewLocaleMember,
  combinedFixtureOmittedJaCsv,
  combinedFixtureOrdinaryTarget,
  combinedFixtureProjectMember,
  combinedFixtureReplacementBytes,
  combinedFixtureSourceFile,
  combinedFixtureValues,
  combinedPrepareScriptPath,
  combinedVerifyScriptPath,
  createCombinedTranslationFixture,
  runCombinedNative,
  type CombinedFixtureCsv,
  type CombinedTranslationFixture,
} from "./support/pck-patch-combined-fixtures.js";
import { readTranslationOutputs } from "./support/translation-fixtures.js";

const knownSyntheticDiagnostic = "OS_Windows::get_system_dir";

const normalizePath = (value: string): string =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

const assertNoUnexpectedNativeErrors = (stderrText: string): void => {
  const lines = stderrText.split(/\r?\n/u);
  const unexpected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("ERROR")) continue;
    if (lines[index + 1]?.includes(knownSyntheticDiagnostic) === true) continue;
    if (line.includes(knownSyntheticDiagnostic)) continue;
    unexpected.push(line);
  }
  assert.deepEqual(unexpected, [], `unexpected native stderr:\n${stderrText}`);
};

const assertNoUnexpectedStdoutErrors = (stdoutText: string, label: string): void => {
  assert.doesNotMatch(stdoutText, /^(?:ERROR|Error):/mu, `${label} printed an error line`);
};

/** Complete durable evidence, not the bounded preview in the run result. */
const readDurableStreams = async (
  operation: OperationPaths | string,
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const paths =
    typeof operation === "string"
      ? { stdoutText: path.join(operation, "stdout.txt"), stderrText: path.join(operation, "stderr.txt") }
      : { stdoutText: operation.stdoutText, stderrText: operation.stderrText };
  return { stdout: await readFile(paths.stdoutText, "utf8"), stderr: await readFile(paths.stderrText, "utf8") };
};

const prepareRequestKeys = [
  "error",
  "existingLocales",
  "mappings",
  "nativeCode",
  "ok",
  "outputs",
  "projectConfig",
  "retainedLocales",
  "source",
  "stage",
  "temp",
  "userData",
  "version",
];

const verifyRequestKeys = [
  "error",
  "nativeCode",
  "ok",
  "outputs",
  "package",
  "projectConfig",
  "retainedLocales",
  "stage",
  "temp",
  "userData",
  "version",
];

const assertStrictFailureReport = (
  report: Record<string, any>,
  expectedKeys: readonly string[],
  expectedStage?: string | readonly string[],
): void => {
  assert.deepEqual(Object.keys(report).sort(), [...expectedKeys].sort());
  assert.equal(report.version, 1);
  assert.equal(report.ok, false);
  assert.equal(typeof report.stage, "string");
  assert.equal(typeof report.error, "string");
  assert.ok((report.error as string).length > 0, "failure report must carry a truthful error");
  assert.equal(typeof report.nativeCode, "number");
  if (expectedStage !== undefined) {
    if (typeof expectedStage === "string") {
      assert.equal(report.stage, expectedStage);
    } else {
      assert.ok(
        expectedStage.includes(report.stage),
        `unexpected failure stage ${String(report.stage)}: ${String(report.error)}`,
      );
    }
  }
};

const buildPrepareRequest = (options: {
  readonly fixture: CombinedTranslationFixture;
  readonly csv: CombinedFixtureCsv;
  readonly csvPath: string;
  readonly locales: readonly string[];
  readonly ordinaryMembers?: readonly string[];
  readonly sourceMembers?: readonly string[];
}): Record<string, unknown> => ({
  version: 1,
  source: nativePath(options.fixture.packagePath),
  translations: [
    {
      resource: options.fixture.importSource,
      csv: nativePath(options.csvPath),
      columns: [...options.csv.columns],
      rows: options.csv.rows.map((row) => [...row]),
    },
  ],
  locales: [...options.locales],
  sourceMembers: [...(options.sourceMembers ?? options.fixture.sourceMembers)],
  ordinaryMembers: [...(options.ordinaryMembers ?? [])],
});

const writeCsvPair = async (
  directory: string,
  name: string,
  text: string,
): Promise<{
  readonly originalPath: string;
  readonly preparedPath: string;
  readonly originalSha256: string;
  readonly preparedSha256: string;
}> => {
  await mkdir(directory, { recursive: true });
  const originalPath = path.join(directory, `${name}-original.csv`);
  const preparedPath = path.join(directory, `${name}-prepared.csv`);
  const preparedBytes = Buffer.from(text, "utf8");
  const originalBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), preparedBytes]);
  await writeFile(originalPath, originalBytes, { flag: "wx" });
  await writeFile(preparedPath, preparedBytes, { flag: "wx" });
  return {
    originalPath,
    preparedPath,
    originalSha256: await sha256File(originalPath),
    preparedSha256: await sha256File(preparedPath),
  };
};

const assertInspectSuccess = async (
  run: PckInspectRun,
  packagePath: string,
): Promise<Record<string, any>> => {
  const { result } = run;
  assert.equal(result.exitCode, 0, `inspector stderr: ${result.stderrText.slice(-2_000)}`);
  assert.equal(result.cleanup.state, "confirmed");
  assert.equal(result.stdout.complete, true);
  assert.equal(result.stderr.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.captureError, null);
  assert.equal(result.storageError, null);
  const streams = await readDurableStreams(run.operation);
  assertNoUnexpectedNativeErrors(streams.stderr);
  assertNoUnexpectedStdoutErrors(streams.stdout, "inspector");
  const { report } = run;
  assert.ok(report !== null, `missing inspector report: ${run.reportPath}`);
  assert.equal(report!.ok, true, `inspector error: ${String(report!.error)}`);
  assert.equal(
    normalizePath(String(report!.packagePath)),
    normalizePath(packagePath),
    "inspector package identity",
  );
  return report as Record<string, any>;
};

const assertPatchProcessSuccess = async (
  run: { readonly result: PckInspectRun["result"]; readonly operation: OperationPaths },
  outputPath: string,
): Promise<void> => {
  const { result, operation } = run;
  assert.equal(
    result.exitCode,
    0,
    `combined CLI exited ${String(result.exitCode)}; stdout tail: ${result.stdoutText.slice(-2_000)}; stderr tail: ${result.stderrText.slice(-2_000)}`,
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanup.state, "confirmed", `cleanup: ${JSON.stringify(result.cleanup)}`);
  assert.equal(result.stdout.complete, true);
  assert.equal(result.stderr.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.captureError, null);
  assert.equal(result.storageError, null);
  const streams = await readDurableStreams(operation);
  assertNoUnexpectedNativeErrors(streams.stderr);
  assertNoUnexpectedStdoutErrors(streams.stdout, "combined CLI");
  const lines = streams.stdout.split(/[\r\n]+/u);
  assert.ok(
    lines.includes(`Patched PCK file: ${outputPath}`),
    `missing success marker in durable stdout; tail: ${streams.stdout.slice(-2_000)}`,
  );
};

interface DirectCliOptions {
  readonly root: string;
  readonly name: string;
  readonly source: string;
  readonly csvPath: string;
  readonly importSource: string;
  readonly locales?: readonly string[];
  readonly patchFile?: { readonly host: string; readonly member: string };
  readonly timeoutMs?: number;
}

/** Run the exact accepted direct combined CLI argv in a fresh operation profile. */
const runDirectCombinedCli = async (
  options: DirectCliOptions,
): Promise<{ readonly run: Awaited<ReturnType<typeof runOwnedPckCommand>>; readonly outputPath: string }> => {
  let outputPath = "";
  const run = await runOwnedPckCommand({
    workspace: path.join(options.root, "operations", options.name),
    name: options.name,
    timeoutMs: options.timeoutMs ?? 180_000,
    buildArgv: (paths: OperationPaths) => {
      outputPath = nativePath(path.join(paths.output, "combined-output.pck"));
      assert.equal(existsSync(outputPath), false, "combined output must be absent before launch");
      const argv = [
        "--headless",
        "--no-header",
        "--",
        `--pck-patch=${nativePath(options.source)}`,
        `--output=${outputPath}`,
      ];
      if (options.patchFile !== undefined) {
        argv.push(
          `--patch-file=${nativePath(options.patchFile.host)}=${options.patchFile.member}`,
        );
      }
      argv.push(`--patch-translations=${nativePath(options.csvPath)}=${options.importSource}`);
      if (options.locales !== undefined) argv.push(`--locales=${options.locales.join(",")}`);
      return argv;
    },
  });
  return { run, outputPath };
};

const verifyRequestFrom = (
  packagePath: string,
  prepareReport: Record<string, any>,
): Record<string, unknown> => ({
  version: 1,
  package: nativePath(packagePath),
  translations: (prepareReport.outputs as Record<string, any>[]).map((output) => ({
    resource: output.resource,
    member: output.member,
    locale: output.locale,
    desired: output.desired,
    expectedValues: output.expectedValues,
  })),
  retainedLocales: (prepareReport.retainedLocales as Record<string, any>[]).map((retained) => ({
    resource: retained.resource,
    member: retained.member,
    locale: retained.locale,
    expectedValues: retained.expectedValues,
  })),
  projectConfig: prepareReport.projectConfig,
});

test("combined native preparation and verification over a newer-version fixture", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-combined-native-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = await createCombinedTranslationFixture({
    root: path.join(root, "fixture"),
  });

  await t.test("fixture exposes independent newer-version literals", () => {
    assert.deepEqual(fixture.values.en, {
      A: "old",
      B: "keep",
      C: "newer-key-en",
    });
    assert.deepEqual(fixture.values.zh, {
      A: "旧值",
      B: "保留",
      C: "newer-key-zh",
    });
    assert.equal(fixture.importSource, combinedFixtureSourceFile);
    assert.equal(fixture.projectConfigMember, combinedFixtureProjectMember);
    assert.equal(fixture.defaultLocale, "en");
    assert.ok(fixture.sourceMembers.includes("res://translations.csv.import"));
    assert.ok(fixture.sourceMembers.includes(fixture.unrelatedMember));
    assert.ok(fixture.sourceMembers.includes(combinedFixtureOrdinaryTarget));
    assert.match(fixture.projectText, /locale\/fallback="en"/u);
    assert.match(fixture.projectText, /internationalization/u);
    assert.ok(combinedFixtureReplacementBytes.includes(0x00));
    assert.ok(combinedFixtureReplacementBytes.includes(0x80));
    assert.ok(combinedFixtureReplacementBytes.includes(0xff));
  });

  await t.test("prepare reports explicit en as existing/default with zh retained and C preserved", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "explicit-en"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const run = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "explicit-en"),
      name: "prepare-explicit-en",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    const report = run.report;
    assert.deepEqual(Object.keys(report).sort(), prepareRequestKeys);
    assert.equal(report.ok, true, `prepare failed: ${String(report.error)}`);
    assert.equal(report.stage, "complete");
    assert.equal(report.nativeCode, 0);
    assert.equal(report.error, null);
    assert.equal(normalizePath(String(report.source)), normalizePath(fixture.packagePath));
    assert.equal(typeof report.userData, "string");
    assert.equal(typeof report.temp, "string");

    assert.equal((report.mappings as any[]).length, 1);
    assert.deepEqual(Object.keys((report.mappings as any[])[0]!).sort(), [
      "csv",
      "defaultLocale",
      "locales",
      "resource",
    ]);
    assert.equal((report.mappings as any[])[0]!.resource, fixture.importSource);
    assert.equal(
      normalizePath(String((report.mappings as any[])[0]!.csv)),
      normalizePath(csv.preparedPath),
    );
    assert.equal((report.mappings as any[])[0]!.defaultLocale, "en");
    assert.deepEqual((report.mappings as any[])[0]!.locales, ["en"]);

    assert.deepEqual(report.existingLocales, [
      { locale: "en", member: fixture.translationMembers.en },
      { locale: "zh", member: fixture.translationMembers.zh },
    ]);

    assert.equal((report.outputs as any[]).length, 1);
    const output = (report.outputs as any[])[0]!;
    assert.deepEqual(Object.keys(output).sort(), [
      "desired",
      "expectedValues",
      "kind",
      "locale",
      "member",
      "resource",
    ]);
    assert.equal(output.resource, fixture.importSource);
    assert.equal(output.member, combinedFixtureExpectedExplicitEn.output.member);
    assert.equal(output.locale, "en");
    assert.equal(output.kind, "existing");
    assert.deepEqual(output.desired, combinedFixtureExpectedExplicitEn.output.desired);
    assert.deepEqual(
      [...(output.expectedValues as string[])].sort(),
      [...combinedFixtureExpectedExplicitEn.output.expectedValues].sort(),
    );
    assert.ok(
      (output.expectedValues as string[]).includes("newer-key-en"),
      "the newer omitted key C must be retained",
    );

    assert.equal((report.retainedLocales as any[]).length, 1);
    const retained = (report.retainedLocales as any[])[0]!;
    assert.deepEqual(Object.keys(retained).sort(), [
      "expectedValues",
      "locale",
      "member",
      "resource",
    ]);
    assert.equal(retained.resource, fixture.importSource);
    assert.equal(retained.member, combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member);
    assert.equal(retained.locale, "zh");
    assert.deepEqual(
      [...(retained.expectedValues as string[])].sort(),
      [...combinedFixtureExpectedExplicitEn.retainedLocales[0]!.expectedValues].sort(),
    );

    assert.notEqual(report.projectConfig, null);
    assert.deepEqual(report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedExplicitEn.registration,
    });
  });

  await t.test("prepare reports omission selection as only the new ja locale", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "omitted-ja"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const run = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "omitted-ja"),
      name: "prepare-omitted-ja",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: combinedFixtureOmittedJaCsv,
        csvPath: csv.preparedPath,
        locales: [],
      }),
    });
    const report = run.report;
    assert.equal(report.ok, true, `prepare failed: ${String(report.error)}`);
    assert.equal(report.stage, "complete");
    assert.equal((report.outputs as any[]).length, 1);
    const output = (report.outputs as any[])[0]!;
    assert.equal(output.kind, "new");
    assert.equal(output.locale, "ja");
    assert.equal(output.member, combinedFixtureNewLocaleMember);
    assert.equal(
      output.member,
      combinedFixtureExpectedOmittedJa.output.member,
      "new member is derived from the native en default resource path",
    );
    assert.deepEqual(output.desired, combinedFixtureExpectedOmittedJa.output.desired);
    assert.deepEqual(
      [...(output.expectedValues as string[])].sort(),
      [...combinedFixtureExpectedOmittedJa.output.expectedValues].sort(),
    );
    assert.ok((output.expectedValues as string[]).includes("newer-key-en"));

    assert.deepEqual(
      (report.retainedLocales as any[]).map((entry) => entry.locale),
      ["en", "zh"],
      "both existing locales remain retained when only ja is selected",
    );
    for (const expected of combinedFixtureExpectedOmittedJa.retainedLocales) {
      const actual = (report.retainedLocales as any[]).find(
        (entry) => entry.locale === expected.locale,
      );
      assert.ok(actual !== undefined, `missing retained ${expected.locale}`);
      assert.equal(actual.member, expected.member);
      assert.deepEqual(
        [...(actual.expectedValues as string[])].sort(),
        [...expected.expectedValues].sort(),
      );
    }
    assert.deepEqual(report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedOmittedJa.registration,
    });

    // Controlled CSV inputs remain byte-identical after preparation.
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
    assert.equal(
      (await readFile(csv.preparedPath)).subarray(0, 3).toString("latin1"),
      "key",
      "prepared CSV is the BOM-stripped copy",
    );
  });

  await t.test("prepare rejects conflicting or unrepresentable requests before any mutation", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "rejections"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const omitted = await writeCsvPair(
      path.join(root, "csv", "rejections-omitted"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const sourceSha256 = await sha256File(fixture.packagePath);

    const reject = async (
      label: string,
      request: Record<string, unknown>,
      expectedStage: string | readonly string[],
    ): Promise<Record<string, any>> => {
      const run = await runCombinedNative({
        workspace: path.join(root, "prepare-rejections", label),
        name: label,
        scriptPath: combinedPrepareScriptPath,
        request,
      });
      assertStrictFailureReport(run.report, prepareRequestKeys, expectedStage);
      assert.equal(run.result.exitCode, 0);
      assert.equal(await sha256File(fixture.packagePath), sourceSha256, "source must remain unchanged");
      return run.report;
    };

    await reject(
      "ordinary-exact-en-collision",
      buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
        ordinaryMembers: [fixture.translationMembers.en],
      }),
      "validate",
    );
    await reject(
      "ordinary-case-folded-en-collision",
      buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
        ordinaryMembers: ["res://.GODOT/imported/TRANSLATIONS.EN.translation"],
      }),
      "validate",
    );
    const absentLocale = await reject(
      "explicit-locale-absent-from-csv",
      buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["ja"],
      }),
      "validate",
    );
    assert.deepEqual(absentLocale.outputs, [], "derivation stops before any output identity is published");
    const noNewLocale = await reject(
      "omission-with-no-new-locale",
      buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: [],
      }),
      "validate",
    );
    assert.deepEqual(noNewLocale.outputs, []);
    await reject(
      "new-locale-already-in-source-members",
      buildPrepareRequest({
        fixture,
        csv: combinedFixtureOmittedJaCsv,
        csvPath: omitted.preparedPath,
        locales: [],
        sourceMembers: [...fixture.sourceMembers, combinedFixtureNewLocaleMember],
      }),
      "validate",
    );

    // Generated destination versus project configuration (case-folded).
    const collisionFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "generated-project-collision"),
      destinations: { zh: "res://Project.Godot" },
    });
    const collisionCsv = await writeCsvPair(
      path.join(root, "csv", "generated-project-collision"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const collisionRun = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "generated-project-collision"),
      name: "generated-project-collision",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: collisionFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: collisionCsv.preparedPath,
        locales: ["en"],
      }),
    });
    assertStrictFailureReport(collisionRun.report, prepareRequestKeys, "validate");
    assert.match(String(collisionRun.report.error), /collision|duplicate/iu);

    for (const [index, variant] of (
      [
        ["missing", "no unique native import metadata"],
        ["duplicate", "duplicate native import metadata"],
        ["wrong-importer", "csv_translation"],
      ] as const
    ).entries()) {
      const variantFixture = await createCombinedTranslationFixture({
        root: path.join(root, "fixtures", `import-${variant[0]}`),
        importMetadata: variant[0],
      });
      const variantCsv = await writeCsvPair(
        path.join(root, "csv", `import-${variant[0]}`),
        "explicit-en",
        combinedFixtureExplicitEnCsv.text,
      );
      const run = await runCombinedNative({
        workspace: path.join(root, "prepare-rejections", `import-${variant[0]}-${String(index)}`),
        name: `import-${variant[0]}`,
        scriptPath: combinedPrepareScriptPath,
        request: buildPrepareRequest({
          fixture: variantFixture,
          csv: combinedFixtureExplicitEnCsv,
          csvPath: variantCsv.preparedPath,
          locales: ["en"],
        }),
      });
      assertStrictFailureReport(run.report, prepareRequestKeys, "validate");
      assert.match(String(run.report.error), new RegExp(variant[1], "u"));
      assert.deepEqual(run.report.outputs, [], "import rejection precedes output derivation");
    }
  });

  await t.test("direct CLI translation-only output is inspectable and getter-verified", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "cli-translation-only"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "cli-translation-only"),
      name: "prepare-cli-translation-only",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);

    const sourceSha256 = await sha256File(fixture.packagePath);
    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-translation-only",
      source: fixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: fixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);
    assert.equal(existsSync(outputPath), true);

    // Original source package, original CSV and prepared CSV stay byte-identical.
    assert.equal(await sha256File(fixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
    assert.notEqual(sourceSha256, await sha256File(outputPath), "output must be separate");

    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "cli-translation-only"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    assert.deepEqual(inspectReport.metadata, pckPatchFixtureExpectedMetadata);

    const sourceByName = new Map(
      fixture.members.map((member) => [member.logicalMember, member] as const),
    );
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.deepEqual(
      [...outputByName.keys()].sort(),
      [...sourceByName.keys()].sort(),
      "translation-only output must not add or remove members",
    );
    for (const member of sourceByName.keys()) {
      if (member === fixture.translationMembers.en) continue;
      if (member === fixture.projectConfigMember) continue;
      assert.equal(
        outputByName.get(member)!.sha256,
        sourceByName.get(member)!.sha256,
        `${member} must be retained byte-identically`,
      );
    }
    assert.notEqual(
      outputByName.get(fixture.translationMembers.en)!.sha256,
      sourceByName.get(fixture.translationMembers.en)!.sha256,
      "regenerated selected translation bytes are not golden",
    );

    const parsed = await readIndependentFormat2PckFile(outputPath);
    const parsedByName = new Map(
      parsed.members.map((member) => [member.logicalMember, member] as const),
    );
    assert.deepEqual(
      parsedByName.get(fixture.unrelatedMember)?.bytes,
      fixture.unrelatedBytes,
    );
    assert.deepEqual(
      parsedByName.get(combinedFixtureOrdinaryTarget)?.bytes,
      fixture.ordinaryBytes,
    );
    assert.deepEqual(
      parsedByName.get(fixture.importMember)?.bytes,
      Buffer.from(fixture.importText, "utf8"),
    );

    const verifyRequest = verifyRequestFrom(outputPath, prepare.report);
    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "cli-translation-only"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequest,
    });
    const verifyReport = verify.report;
    assert.deepEqual(Object.keys(verifyReport).sort(), verifyRequestKeys);
    assert.equal(verifyReport.ok, true, `verify failed: ${String(verifyReport.error)}`);
    assert.equal(verifyReport.stage, "complete");
    assert.equal(verifyReport.nativeCode, 0);
    assert.equal(normalizePath(String(verifyReport.package)), normalizePath(outputPath));
    assert.equal((verifyReport.outputs as any[]).length, 1);
    const verified = (verifyReport.outputs as any[])[0]!;
    assert.deepEqual(Object.keys(verified).sort(), [
      "class",
      "locale",
      "member",
      "resource",
      "retainedContentVerified",
      "verifiedTexts",
    ]);
    assert.equal(verified.resource, fixture.importSource);
    assert.equal(verified.member, combinedFixtureExpectedExplicitEn.output.member);
    assert.equal(verified.locale, "en");
    assert.equal(verified.class, "OptimizedTranslation");
    assert.equal(verified.verifiedTexts, 2);
    assert.equal(verified.retainedContentVerified, true);
    assert.equal((verifyReport.retainedLocales as any[]).length, 1);
    assert.equal((verifyReport.retainedLocales as any[])[0]!.locale, "zh");
    assert.equal((verifyReport.retainedLocales as any[])[0]!.retainedContentVerified, true);
    assert.deepEqual(verifyReport.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedExplicitEn.registration,
    });

    // Truthful negative verification: mutate text, locale, multiset and registration.
    const mutations: readonly {
      readonly label: string;
      readonly mutate: (request: Record<string, any>) => void;
      readonly stage: string;
    }[] = [
      {
        label: "wrong-text",
        stage: "verify",
        mutate: (request) => {
          request.translations[0].desired.A = "not-the-written-text";
        },
      },
      {
        label: "wrong-locale",
        stage: "verify",
        mutate: (request) => {
          request.translations[0].locale = "fr";
        },
      },
      {
        label: "wrong-member",
        stage: "verify",
        mutate: (request) => {
          request.translations[0].member = fixture.translationMembers.zh;
        },
      },
      {
        label: "wrong-multiset",
        stage: "verify",
        mutate: (request) => {
          request.translations[0].expectedValues.push("unexpected-message");
        },
      },
      {
        label: "wrong-registration",
        stage: "project",
        mutate: (request) => {
          request.projectConfig.registration.push("res://localization/extra.translation");
        },
      },
    ];
    for (const mutation of mutations) {
      const mutated = JSON.parse(JSON.stringify(verifyRequest)) as Record<string, any>;
      mutation.mutate(mutated);
      const failed = await runCombinedNative({
        workspace: path.join(root, "verify-operations", `cli-translation-only-${mutation.label}`),
        name: `verify-${mutation.label}`,
        scriptPath: combinedVerifyScriptPath,
        request: mutated,
      });
      assertStrictFailureReport(failed.report, verifyRequestKeys, mutation.stage);
      assert.equal(failed.result.exitCode, 0);
    }

    // `projectConfig: null` means the output must actually have no configuration.
    const absentConfigRequest = JSON.parse(JSON.stringify(verifyRequest)) as Record<string, any>;
    absentConfigRequest.projectConfig = null;
    const unexpectedConfig = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "cli-translation-only-unexpected-config"),
      name: "verify-unexpected-config",
      scriptPath: combinedVerifyScriptPath,
      request: absentConfigRequest,
    });
    assertStrictFailureReport(unexpectedConfig.report, verifyRequestKeys, "project");

    assert.equal(await sha256File(fixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
  });

  await t.test("direct CLI mixed output replaces ordinary bytes exactly and keeps retained members", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "cli-mixed"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const replacementFile = path.join(root, "cli-mixed", "replacement.bin");
    await mkdir(path.dirname(replacementFile), { recursive: true });
    await writeFile(replacementFile, combinedFixtureReplacementBytes, { flag: "wx" });
    const replacementSha256 = await sha256File(replacementFile);

    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "cli-mixed"),
      name: "prepare-cli-mixed",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
        ordinaryMembers: [combinedFixtureOrdinaryTarget],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.deepEqual(prepare.report.outputs[0].desired, {
      A: "patched-en-A",
      B: "keep",
    });

    const sourceSha256 = await sha256File(fixture.packagePath);
    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-mixed",
      source: fixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: fixture.importSource,
      locales: ["en"],
      patchFile: { host: replacementFile, member: combinedFixtureOrdinaryTarget },
    });
    await assertPatchProcessSuccess(run, outputPath);

    assert.equal(await sha256File(fixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
    assert.equal(await sha256File(replacementFile), replacementSha256);

    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "cli-mixed"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    assert.deepEqual(inspectReport.metadata, pckPatchFixtureExpectedMetadata);

    const sourceByName = new Map(
      fixture.members.map((member) => [member.logicalMember, member] as const),
    );
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.deepEqual(
      [...outputByName.keys()].sort(),
      [...sourceByName.keys()].sort(),
      "mixed output must not add or remove members",
    );
    assert.equal(
      outputByName.get(combinedFixtureOrdinaryTarget)!.sha256,
      replacementSha256,
      "ordinary replacement bytes must match the host input exactly",
    );
    assert.notEqual(
      outputByName.get(combinedFixtureOrdinaryTarget)!.sha256,
      sourceByName.get(combinedFixtureOrdinaryTarget)!.sha256,
    );
    for (const member of sourceByName.keys()) {
      if (member === fixture.translationMembers.en) continue;
      if (member === fixture.projectConfigMember) continue;
      if (member === combinedFixtureOrdinaryTarget) continue;
      assert.equal(
        outputByName.get(member)!.sha256,
        sourceByName.get(member)!.sha256,
        `${member} must be retained byte-identically`,
      );
    }

    const parsed = await readIndependentFormat2PckFile(outputPath);
    const parsedByName = new Map(
      parsed.members.map((member) => [member.logicalMember, member] as const),
    );
    assert.deepEqual(
      parsedByName.get(combinedFixtureOrdinaryTarget)?.bytes,
      combinedFixtureReplacementBytes,
    );
    assert.deepEqual(
      parsedByName.get(fixture.unrelatedMember)?.bytes,
      fixture.unrelatedBytes,
    );

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "cli-mixed"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.equal(verify.report.stage, "complete");
    assert.equal((verify.report.outputs as any[])[0]!.verifiedTexts, 2);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedExplicitEn.registration,
    });

    assert.equal(await sha256File(fixture.packagePath), sourceSha256);
    assert.equal(await sha256File(replacementFile), replacementSha256);
  });

  await t.test("direct CLI omission adds exactly ja and verifies retained newer C", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "cli-omitted-ja"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "cli-omitted-ja"),
      name: "prepare-cli-omitted-ja",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: combinedFixtureOmittedJaCsv,
        csvPath: csv.preparedPath,
        locales: [],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.equal((prepare.report.mappings as any[])[0]!.defaultLocale, "en");
    const prepareOutput = (prepare.report.outputs as any[])[0]!;
    assert.equal(prepareOutput.member, combinedFixtureExpectedOmittedJa.output.member);
    assert.equal(prepareOutput.kind, "new");
    assert.deepEqual(prepareOutput.desired, combinedFixtureExpectedOmittedJa.output.desired);
    assert.deepEqual(
      [...(prepareOutput.expectedValues as string[])].sort(),
      [...combinedFixtureExpectedOmittedJa.output.expectedValues].sort(),
    );

    const sourceSha256 = await sha256File(fixture.packagePath);
    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-omitted-ja",
      source: fixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: fixture.importSource,
    });
    await assertPatchProcessSuccess(run, outputPath);
    const outputSha256 = await sha256File(outputPath);

    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "cli-omitted-ja"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    assert.deepEqual(inspectReport.metadata, pckPatchFixtureExpectedMetadata);
    const sourceByName = new Map(
      fixture.members.map((member) => [member.logicalMember, member] as const),
    );
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.deepEqual(
      [...outputByName.keys()].sort(),
      [...sourceByName.keys(), combinedFixtureExpectedOmittedJa.output.member].sort(),
      "omission adds exactly the derived new-locale member",
    );
    for (const [member, sourceMember] of sourceByName) {
      if (member === fixture.projectConfigMember) continue;
      assert.equal(
        outputByName.get(member)!.sha256,
        sourceMember.sha256,
        `${member} must be retained byte-identically by an omission patch`,
      );
    }
    const parsed = await readIndependentFormat2PckFile(outputPath);
    const parsedByName = new Map(
      parsed.members.map((member) => [member.logicalMember, member] as const),
    );
    for (const member of [
      fixture.unrelatedMember,
      fixture.importMember,
      fixture.translationMembers.en,
      fixture.translationMembers.zh,
    ]) {
      assert.deepEqual(parsedByName.get(member)?.bytes, sourceByName.get(member)!.bytes);
    }
    assert.ok(parsedByName.has(combinedFixtureExpectedOmittedJa.output.member));

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "cli-omitted-ja"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    const verified = (verify.report.outputs as any[])[0]!;
    assert.equal(verified.locale, "ja");
    assert.equal(verified.verifiedTexts, 2);
    assert.deepEqual(
      (verify.report.retainedLocales as any[]).map((entry) => entry.locale).sort(),
      ["en", "zh"],
    );
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedOmittedJa.registration,
    });
    assert.equal(await sha256File(outputPath), outputSha256, "verify must not mutate the output");
    assert.equal(await sha256File(fixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
  });

  await t.test("non-first configured fallback supplies omitted-key content", async () => {
    const fallbackFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "non-first-fallback"),
      fallbackLocale: "zh",
    });
    const csv = await writeCsvPair(
      path.join(root, "csv", "non-first-fallback"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "non-first-fallback"),
      name: "prepare-non-first-fallback",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: fallbackFixture,
        csv: combinedFixtureOmittedJaCsv,
        csvPath: csv.preparedPath,
        locales: [],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.equal(
      (prepare.report.mappings as any[])[0]!.defaultLocale,
      "zh",
      "the actual configured fallback resource locale must be reported",
    );
    const prepareOutput = (prepare.report.outputs as any[])[0]!;
    assert.deepEqual(prepareOutput.desired, combinedFixtureExpectedOmittedJaFromZh.output.desired);
    assert.deepEqual(
      [...(prepareOutput.expectedValues as string[])].sort(),
      [...combinedFixtureExpectedOmittedJaFromZh.output.expectedValues].sort(),
      "the omitted newer key C comes from the zh default resource",
    );
    assert.ok(
      (prepareOutput.expectedValues as string[]).includes("newer-key-zh"),
      "new-locale content must follow the actual configured default",
    );

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-non-first-fallback",
      source: fallbackFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: fallbackFixture.importSource,
    });
    await assertPatchProcessSuccess(run, outputPath);
    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "non-first-fallback"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedOmittedJaFromZh.registration,
    });
  });

  await t.test("binary project configuration keeps its actual identity", async () => {
    const binaryFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "binary-config"),
      projectConfig: "binary",
    });
    assert.equal(binaryFixture.projectConfigKind, "binary");
    assert.equal(binaryFixture.projectConfigMember, "res://project.binary");
    const csv = await writeCsvPair(
      path.join(root, "csv", "binary-config"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "binary-config"),
      name: "prepare-binary-config",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: binaryFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.deepEqual(prepare.report.projectConfig, {
      member: "res://project.binary",
      registration: combinedFixtureExpectedExplicitEn.registration,
    });

    const sourceSha256 = await sha256File(binaryFixture.packagePath);
    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-binary-config",
      source: binaryFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: binaryFixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);
    const outputSha256 = await sha256File(outputPath);

    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "binary-config"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    assert.deepEqual(inspectReport.metadata, pckPatchFixtureExpectedMetadata);
    const sourceByName = new Map(
      binaryFixture.members.map((member) => [member.logicalMember, member] as const),
    );
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.deepEqual(
      [...outputByName.keys()].sort(),
      [...sourceByName.keys()].sort(),
      "binary config patching must not add or remove members",
    );
    assert.notEqual(
      outputByName.get(binaryFixture.projectConfigMember)?.sha256,
      undefined,
      "the binary config remains a package member",
    );
    for (const [member, sourceMember] of sourceByName) {
      if (member === binaryFixture.projectConfigMember) continue;
      if (member === binaryFixture.translationMembers.en) continue;
      assert.equal(outputByName.get(member)!.sha256, sourceMember.sha256, `${member} must be retained`);
    }

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "binary-config"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.binary",
      registration: combinedFixtureExpectedExplicitEn.registration,
    });

    const wrongIdentity = JSON.parse(
      JSON.stringify(verifyRequestFrom(outputPath, prepare.report)),
    ) as Record<string, any>;
    wrongIdentity.projectConfig.member = "res://project.godot";
    const wrongIdentityRun = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "binary-config-wrong-identity"),
      name: "verify-wrong-identity",
      scriptPath: combinedVerifyScriptPath,
      request: wrongIdentity,
    });
    assertStrictFailureReport(wrongIdentityRun.report, verifyRequestKeys, "project");

    assert.equal(await sha256File(outputPath), outputSha256, "verify must not mutate the output");
    assert.equal(await sha256File(binaryFixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
  });

  await t.test("absent project configuration stays absent", async () => {
    const absentFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "absent-config"),
      projectConfig: "absent",
    });
    assert.equal(absentFixture.projectConfigKind, "absent");
    assert.equal(absentFixture.projectConfigMember, "");
    const csv = await writeCsvPair(
      path.join(root, "csv", "absent-config"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "absent-config"),
      name: "prepare-absent-config",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: absentFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.equal(prepare.report.projectConfig, null);

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-absent-config",
      source: absentFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: absentFixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);
    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "absent-config"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.equal(outputByName.has("res://project.godot"), false);
    assert.equal(outputByName.has("res://project.binary"), false);
    assert.equal(
      outputByName.size,
      absentFixture.members.length,
      "an absent config must not be invented by patching",
    );

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "absent-config"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.equal(verify.report.projectConfig, null);

    const unexpected = JSON.parse(
      JSON.stringify(verifyRequestFrom(outputPath, prepare.report)),
    ) as Record<string, any>;
    unexpected.projectConfig = {
      member: "res://project.godot",
      registration: combinedFixtureExpectedExplicitEn.registration,
    };
    const unexpectedRun = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "absent-config-unexpected"),
      name: "verify-unexpected",
      scriptPath: combinedVerifyScriptPath,
      request: unexpected,
    });
    assertStrictFailureReport(unexpectedRun.report, verifyRequestKeys, "project");
  });

  await t.test("source registration conflicts reject before mutation", async () => {
    const explicitCsv = await writeCsvPair(
      path.join(root, "csv", "registration-conflicts-en"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const omittedCsv = await writeCsvPair(
      path.join(root, "csv", "registration-conflicts-ja"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const reject = async (
      label: string,
      fixtureOptions: Omit<Parameters<typeof createCombinedTranslationFixture>[0], "root">,
      csv: (typeof combinedFixtureExplicitEnCsv) | (typeof combinedFixtureOmittedJaCsv),
      csvPath: string,
      locales: readonly string[],
    ): Promise<void> => {
      const variant = await createCombinedTranslationFixture({
        root: path.join(root, "fixtures", `registration-${label}`),
        ...fixtureOptions,
      });
      const sourceSha256 = await sha256File(variant.packagePath);
      const run = await runCombinedNative({
        workspace: path.join(root, "prepare-rejections", `registration-${label}`),
        name: `registration-${label}`,
        scriptPath: combinedPrepareScriptPath,
        request: buildPrepareRequest({ fixture: variant, csv, csvPath, locales }),
      });
      assertStrictFailureReport(run.report, prepareRequestKeys, "project");
      assert.equal(await sha256File(variant.packagePath), sourceSha256);
    };

    await reject(
      "exact-duplicate",
      {
        projectRegistration: [
          combinedFixtureExpectedExplicitEn.output.member,
          combinedFixtureExpectedExplicitEn.output.member,
        ],
      },
      combinedFixtureExplicitEnCsv,
      explicitCsv.preparedPath,
      ["en"],
    );
    await reject(
      "casefold-duplicate",
      {
        projectRegistration: [
          combinedFixtureExpectedExplicitEn.output.member,
          "res://.godot/imported/TRANSLATIONS.EN.translation",
        ],
      },
      combinedFixtureExplicitEnCsv,
      explicitCsv.preparedPath,
      ["en"],
    );
    await reject(
      "self-entry",
      {
        projectRegistration: [
          combinedFixtureExpectedExplicitEn.output.member,
          combinedFixtureProjectMember,
        ],
      },
      combinedFixtureExplicitEnCsv,
      explicitCsv.preparedPath,
      ["en"],
    );
    await reject(
      "generated-new-conflict",
      {
        projectRegistration: [
          combinedFixtureExpectedExplicitEn.output.member,
          combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
          "res://.godot/imported/TRANSLATIONS.JA.translation",
        ],
      },
      combinedFixtureOmittedJaCsv,
      omittedCsv.preparedPath,
      [],
    );
    await reject(
      "generated-existing-conflict",
      {
        projectRegistration: [
          combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
          "res://.godot/imported/TRANSLATIONS.EN.translation",
        ],
      },
      combinedFixtureExplicitEnCsv,
      explicitCsv.preparedPath,
      ["en"],
    );
  });

  await t.test("absent registration setting is a valid empty source list", async () => {
    const emptyRegistrationFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "empty-registration"),
      projectRegistration: null,
    });
    const csv = await writeCsvPair(
      path.join(root, "csv", "empty-registration"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "empty-registration"),
      name: "prepare-empty-registration",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: emptyRegistrationFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.deepEqual(prepare.report.projectConfig, {
      member: "res://project.godot",
      registration: [combinedFixtureExpectedExplicitEn.output.member],
    });

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-empty-registration",
      source: emptyRegistrationFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: emptyRegistrationFixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);
    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "empty-registration"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: [combinedFixtureExpectedExplicitEn.output.member],
    });
  });

  await t.test("present wrong-type or malformed config and bad requests fail truthfully", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "config-failures"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const wrongTypeFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "wrong-type-config"),
      projectRegistration: "wrong-type",
    });
    const wrongTypeSha256 = await sha256File(wrongTypeFixture.packagePath);
    const wrongType = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "wrong-type-config"),
      name: "wrong-type-config",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: wrongTypeFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assertStrictFailureReport(wrongType.report, prepareRequestKeys, ["project", "post-load"]);
    assert.equal(await sha256File(wrongTypeFixture.packagePath), wrongTypeSha256);

    const malformedFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "malformed-config"),
      projectConfig: "malformed",
    });
    const malformedSha256 = await sha256File(malformedFixture.packagePath);
    const malformed = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "malformed-config"),
      name: "malformed-config",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: malformedFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assertStrictFailureReport(malformed.report, prepareRequestKeys, ["load", "post-load"]);
    assert.equal(await sha256File(malformedFixture.packagePath), malformedSha256);

    const unknownField = buildPrepareRequest({
      fixture,
      csv: combinedFixtureExplicitEnCsv,
      csvPath: csv.preparedPath,
      locales: ["en"],
    }) as Record<string, any>;
    unknownField.unexpected = true;
    const unknownRun = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "unknown-request-field"),
      name: "unknown-request-field",
      scriptPath: combinedPrepareScriptPath,
      request: unknownField,
    });
    assertStrictFailureReport(unknownRun.report, prepareRequestKeys, "request");
  });

  await t.test("unrelated registration entries are preserved and compared order-insensitively", async () => {
    const unrelatedRegistration = "res://data/unrelated.txt";
    const unrelatedFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "unrelated-registration"),
      projectRegistration: [
        combinedFixtureExpectedExplicitEn.output.member,
        combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
        unrelatedRegistration,
      ],
    });
    const csv = await writeCsvPair(
      path.join(root, "csv", "unrelated-registration"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const expectedRegistration = [
      ...combinedFixtureExpectedExplicitEn.registration,
      unrelatedRegistration,
    ].sort();
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "unrelated-registration"),
      name: "prepare-unrelated-registration",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: unrelatedFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.deepEqual(prepare.report.projectConfig, {
      member: "res://project.godot",
      registration: expectedRegistration,
    });

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-unrelated-registration",
      source: unrelatedFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: unrelatedFixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);
    const verifyRequest = verifyRequestFrom(outputPath, prepare.report) as Record<string, any>;
    verifyRequest.projectConfig.registration = [...expectedRegistration].reverse();
    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "unrelated-registration"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequest,
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: expectedRegistration,
    });
  });

  await t.test("cardinality, source-key and native CSV disagreements reject", async () => {
    const csv = await writeCsvPair(
      path.join(root, "csv", "request-rejections"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const multi = buildPrepareRequest({
      fixture,
      csv: combinedFixtureExplicitEnCsv,
      csvPath: csv.preparedPath,
      locales: ["en"],
    }) as Record<string, any>;
    multi.translations.push(JSON.parse(JSON.stringify(multi.translations[0])));
    const multiRun = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "multiple-mappings"),
      name: "multiple-mappings",
      scriptPath: combinedPrepareScriptPath,
      request: multi,
    });
    assertStrictFailureReport(multiRun.report, prepareRequestKeys, "request");
    assert.match(String(multiRun.report.error), /exactly one/iu);

    const missingKeyCsv = {
      text: "key,en\nmissing-key,x\n",
      columns: ["key", "en"],
      rows: [["missing-key", "x"]],
    };
    const missingCsv = await writeCsvPair(
      path.join(root, "csv", "missing-source-key"),
      "missing-source-key",
      missingKeyCsv.text,
    );
    const missingRun = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "missing-source-key"),
      name: "missing-source-key",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture,
        csv: missingKeyCsv,
        csvPath: missingCsv.preparedPath,
        locales: ["en"],
      }),
    });
    assertStrictFailureReport(missingRun.report, prepareRequestKeys, "validate");
    assert.match(String(missingRun.report.error), /empty/iu);

    const disagreement = buildPrepareRequest({
      fixture,
      csv: combinedFixtureExplicitEnCsv,
      csvPath: csv.preparedPath,
      locales: ["en"],
    }) as Record<string, any>;
    disagreement.translations[0].rows[0][1] = "different-text";
    const disagreementRun = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "csv-disagreement"),
      name: "csv-disagreement",
      scriptPath: combinedPrepareScriptPath,
      request: disagreement,
    });
    assertStrictFailureReport(disagreementRun.report, prepareRequestKeys, "validate");
    assert.match(String(disagreementRun.report.error), /does not agree/iu);
  });

  await t.test("source preregistration of the exact new-locale destination is allowed", async () => {
    const preregisteredFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "preregistered-new-locale"),
      projectRegistration: [
        combinedFixtureExpectedExplicitEn.output.member,
        combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
        combinedFixtureExpectedOmittedJa.output.member,
      ],
    });
    const csv = await writeCsvPair(
      path.join(root, "csv", "preregistered-new-locale"),
      "omitted-ja",
      combinedFixtureOmittedJaCsv.text,
    );
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "preregistered-new-locale"),
      name: "prepare-preregistered-new-locale",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: preregisteredFixture,
        csv: combinedFixtureOmittedJaCsv,
        csvPath: csv.preparedPath,
        locales: [],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.deepEqual(prepare.report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedOmittedJa.registration,
    });

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-preregistered-new-locale",
      source: preregisteredFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: preregisteredFixture.importSource,
    });
    await assertPatchProcessSuccess(run, outputPath);
    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "preregistered-new-locale"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    const outputMembers = new Set(
      (inspectReport.members as Record<string, any>[]).map((member) => member.logicalMember as string),
    );
    assert.ok(outputMembers.has(combinedFixtureExpectedOmittedJa.output.member));

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "preregistered-new-locale"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(verify.report.projectConfig, {
      member: "res://project.godot",
      registration: combinedFixtureExpectedOmittedJa.registration,
    });
  });

  await t.test("non-string registration member fails rather than being coerced", async () => {
    const nonStringFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "non-string-registration"),
      projectRegistration: "non-string-member",
    });
    const csv = await writeCsvPair(
      path.join(root, "csv", "non-string-registration"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const sourceSha256 = await sha256File(nonStringFixture.packagePath);
    const run = await runCombinedNative({
      workspace: path.join(root, "prepare-rejections", "non-string-registration"),
      name: "non-string-registration",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: nonStringFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assertStrictFailureReport(run.report, prepareRequestKeys, ["project", "post-load"]);
    assert.match(String(run.report.error), /not a string array/iu);
    assert.equal(await sha256File(nonStringFixture.packagePath), sourceSha256);
  });

  await t.test("retained empty-locale resource uses filename identity during verification", async () => {
    const emptyLocaleFixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixtures", "empty-locale-retained"),
      emptyLocale: "zh",
    });
    const zhMember = emptyLocaleFixture.translationMembers.zh;
    assert.equal(path.posix.extname(zhMember), ".translation");

    // Prove the authored source is empty-locale while its filename identifies zh.
    const sourceRead = await readTranslationOutputs({
      fixture: emptyLocaleFixture as unknown as Parameters<typeof readTranslationOutputs>[0]["fixture"],
      workspace: path.join(root, "source-read", "empty-locale-retained"),
      outputs: [zhMember],
    });
    const rawSource = sourceRead.outputs[0]!;
    assert.equal(rawSource.locale, "", "the retained source resource locale must be empty");
    assert.equal(rawSource.A, "旧值");
    assert.equal(rawSource.B, "保留");
    assert.deepEqual(
      [...((rawSource.messages as Record<string, string[]>).zh ?? [])].sort(),
      [
        combinedFixtureValues.zh.A,
        combinedFixtureValues.zh.B,
        combinedFixtureValues.zh.C,
      ].sort(),
      "native message reading derives the zh locale from the filename",
    );

    const csv = await writeCsvPair(
      path.join(root, "csv", "empty-locale-retained"),
      "explicit-en",
      combinedFixtureExplicitEnCsv.text,
    );
    const sourceSha256 = await sha256File(emptyLocaleFixture.packagePath);
    const prepare = await runCombinedNative({
      workspace: path.join(root, "prepare-operations", "empty-locale-retained"),
      name: "prepare-empty-locale-retained",
      scriptPath: combinedPrepareScriptPath,
      request: buildPrepareRequest({
        fixture: emptyLocaleFixture,
        csv: combinedFixtureExplicitEnCsv,
        csvPath: csv.preparedPath,
        locales: ["en"],
      }),
    });
    assert.equal(prepare.report.ok, true, `prepare failed: ${String(prepare.report.error)}`);
    assert.ok(
      (prepare.report.existingLocales as any[]).some(
        (entry) => entry.locale === "zh" && entry.member === zhMember,
      ),
    );
    assert.deepEqual(
      (prepare.report.retainedLocales as any[]).map((entry) => entry.locale),
      ["zh"],
    );

    const { run, outputPath } = await runDirectCombinedCli({
      root,
      name: "cli-empty-locale-retained",
      source: emptyLocaleFixture.packagePath,
      csvPath: csv.preparedPath,
      importSource: emptyLocaleFixture.importSource,
      locales: ["en"],
    });
    await assertPatchProcessSuccess(run, outputPath);

    const inspect = await inspectOwnedPck({
      workspace: path.join(root, "inspect", "empty-locale-retained"),
      packagePath: outputPath,
      name: "output",
    });
    const inspectReport = await assertInspectSuccess(inspect, outputPath);
    const sourceByName = new Map(
      emptyLocaleFixture.members.map((member) => [member.logicalMember, member] as const),
    );
    const outputByName = new Map(
      (inspectReport.members as Record<string, any>[]).map(
        (member) => [member.logicalMember as string, member] as const,
      ),
    );
    assert.equal(
      outputByName.get(zhMember)!.sha256,
      sourceByName.get(zhMember)!.sha256,
      "the retained empty-locale zh resource must be byte-identical",
    );
    assert.notEqual(
      outputByName.get(emptyLocaleFixture.translationMembers.en)!.sha256,
      sourceByName.get(emptyLocaleFixture.translationMembers.en)!.sha256,
      "the selected en resource is regenerated",
    );
    const parsed = await readIndependentFormat2PckFile(outputPath);
    const parsedByName = new Map(
      parsed.members.map((member) => [member.logicalMember, member] as const),
    );
    assert.deepEqual(parsedByName.get(zhMember)?.bytes, sourceByName.get(zhMember)!.bytes);

    const verify = await runCombinedNative({
      workspace: path.join(root, "verify-operations", "empty-locale-retained"),
      name: "verify",
      scriptPath: combinedVerifyScriptPath,
      request: verifyRequestFrom(outputPath, prepare.report),
    });
    assert.equal(verify.report.ok, true, `verify failed: ${String(verify.report.error)}`);
    assert.deepEqual(
      (verify.report.retainedLocales as any[]).map((entry) => entry.locale),
      ["zh"],
      "verification must derive zh from the retained resource filename",
    );
    assert.equal(await sha256File(emptyLocaleFixture.packagePath), sourceSha256);
    assert.equal(await sha256File(csv.originalPath), csv.originalSha256);
    assert.equal(await sha256File(csv.preparedPath), csv.preparedSha256);
  });
});
