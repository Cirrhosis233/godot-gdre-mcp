import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import { prepareNativeOwnershipHelper } from "../src/process-tree.js";
import type { RuntimeManager } from "../src/runtime.js";
import type { OperationResult, RuntimeState } from "../src/types.js";
import {
  combinedFixtureDefaultDestinations,
  combinedFixtureExplicitEnCsv,
  combinedFixtureExpectedExplicitEn,
  combinedFixtureExpectedOmittedJa,
  combinedFixtureNewLocaleMember,
  combinedFixtureOmittedJaCsv,
  combinedFixtureOrdinaryTarget,
  combinedFixtureReplacementBytes,
  combinedFixtureSha256,
  combinedVerifyScriptPath,
  createCombinedTranslationFixture,
  runCombinedNative,
  sortedUnique,
} from "./support/pck-patch-combined-fixtures.js";
import {
  PCK_PATCH_DEFAULT_OUTPUT_BYTES,
  createPckPatchFaultRunner,
  type CombinedReportDelivery,
  type PckPatchFaultContext,
  type PckPatchInspectorReport,
  type PckPatchScenario,
} from "./support/pck-patch-faults.js";
import { defaultTranslationRuntimeExecutable } from "./support/translation-fixtures.js";
import {
  nativePath,
  readIndependentFormat2PckFile,
  sha256File,
} from "./support/pck-patch-fixtures.js";

/**
 * C2a acceptance tracer: one real fixed-runtime Execution call for a
 * translation-only combined patch with an explicit existing locale.
 *
 * The fixture, expected values and retained payloads are independently authored
 * by the accepted C1 support module. Every native launch is the real GDRE
 * executable through the production Execution and owned ProcessRunner; nothing
 * here substitutes a report.
 */

type AnyRecord = Record<string, any>;

/** Default package product beside the admitted source for one operation. */
const defaultPatchedOutput = (
  source: string,
  operationDirectory: string,
): string =>
  path.join(
    path.dirname(source),
    `${path.parse(source).name}-patched-${path.basename(operationDirectory)}.pck`,
  );

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const runtimeState = (): RuntimeState =>
  ({
    health: "ready",
    registryVersion: "2.8.0-beta.2",
    targetVersion: "2.8.0-beta.2",
    actualVersion: "2.8.0-beta.2",
    comparison: "match",
    executable: defaultTranslationRuntimeExecutable,
    companions: [
      {
        path: defaultTranslationRuntimeExecutable,
        present: true,
        sha256: "a".repeat(64),
      },
      { path: `${defaultTranslationRuntimeExecutable}.pck`, present: true, sha256: "b".repeat(64) },
      { path: `${defaultTranslationRuntimeExecutable}.dll`, present: true, sha256: "c".repeat(64) },
    ],
    exeSha256: "a".repeat(64),
    baselineHashesMatch: true,
    checkedAt: new Date().toISOString(),
    evidencePath: null,
    probe: {
      exitCode: 1,
      signal: null,
      stdout: {
        bytes: 0,
        text: "",
        truncated: false,
        utf8Valid: true,
        rawPath: null,
        textPath: null,
        complete: false,
      },
      stderr: {
        bytes: 0,
        text: "",
        truncated: false,
        utf8Valid: true,
        rawPath: null,
        textPath: null,
        complete: false,
      },
      error: null,
    },
    warnings: [],
  }) as RuntimeState;

const makeConfig = (workspace: string): LoadedConfig => ({
  installationRoot: repositoryRoot,
  configFile: null,
  workspaceRoot: workspace,
  runtimeDirectory: path.dirname(defaultTranslationRuntimeExecutable),
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

const openExecution = (workspace: string): ExecutionImpl => {
  const state = runtimeState();
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  return new ExecutionImpl(makeConfig(workspace), manager, {});
};

const execute = async (
  execution: ExecutionImpl,
  input: AnyRecord,
  signal: AbortSignal,
): Promise<OperationResult> =>
  execution.execute("pck-patch", input, { signal });

test(
  "combined translation-only explicit existing en patch is getter- and byte-verified",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-execution-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const fixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixture"),
    });
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const originalCsvPath = path.join(workspace, "translations-original.csv");
    const originalCsvBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(combinedFixtureExplicitEnCsv.text, "utf8"),
    ]);
    await writeFile(originalCsvPath, originalCsvBytes, { flag: "wx" });
    const sourceSha256 = await sha256File(fixture.packagePath);
    const originalCsvSha256 = await sha256File(originalCsvPath);

    await prepareNativeOwnershipHelper(
      path.join(repositoryRoot, "native", "gdre-job-object.ps1"),
    );

    const execution = openExecution(workspace);
    try {
      const result = await execute(
        execution,
        {
          source: fixture.packagePath,
          patches: [],
          translations: [
            { csv: originalCsvPath, resource: fixture.importSource },
          ],
          locales: ["en"],
          workspace,
          timeoutMs: 600_000,
        },
        new AbortController().signal,
      );
      assert.equal(
        result.success,
        true,
        JSON.stringify({ error: result.error, semantic: result.semantic }),
      );
      assert.equal(result.status, "succeeded");
      assert.equal(result.error, null);

      const operation = result.paths.operation!;
      const outputPath = defaultPatchedOutput(fixture.packagePath, operation);
      assert.equal(path.dirname(outputPath), fixture.root);
      const preparedCsvPath = path.join(operation, "pck-patch", "prepared-0.csv");
      assert.equal(result.paths.effectiveDestination, outputPath);
      assert.ok(
        result.stdout.text.includes(
          `Patched PCK file: ${outputPath.replaceAll("\\", "/")}`,
        ),
        "the direct patch stdout marker must survive the later verification launch",
      );
      assert.equal(result.cleanup.state, "confirmed");

      const data = result.semantic.data as AnyRecord;
      assert.equal(result.semantic.status, "succeeded");
      assert.equal(data.completeness, "complete");
      assert.equal(data.outputPath, outputPath);
      assert.deepEqual(data.counts, {
        mappings: 0,
        verifiedReplacements: 0,
        verifiedRetainedMembers: 4,
        unverifiedFiles: 0,
      });
      assert.deepEqual(data.reports, {
        sourceInspection: path.join(
          operation,
          "pck-source-inspection",
          "report.json",
        ),
        outputInspection: path.join(
          operation,
          "pck-output-inspection",
          "report.json",
        ),
        verification: path.join(operation, "pck-patch", "verification.json"),
      });
      assert.deepEqual(data.samples.replacements, []);
      assert.deepEqual(data.samples.retainedMembers.sort(), [
        "res://data/replace.bin",
        "res://data/unrelated.txt",
        "res://.godot/imported/translations.zh.translation",
        "res://translations.csv.import",
      ].sort());

      assert.deepEqual(data.translations.localeSelection, {
        mode: "explicit",
        locales: ["en"],
      });
      assert.deepEqual(data.translations.counts, {
        mappings: 1,
        outputs: 1,
        verifiedResources: 1,
        verifiedTexts: 2,
        retainedLocales: 1,
        permittedAdditions: 0,
      });
      assert.deepEqual(data.translations.preparedCsvs, {
        items: [
          {
            original: originalCsvPath,
            prepared: preparedCsvPath,
            bomNormalized: true,
          },
        ],
        truncated: false,
      });
      assert.deepEqual(data.translations.reports, {
        preparation: path.join(
          operation,
          "pck-combined-preparation",
          "report.json",
        ),
        verification: path.join(
          operation,
          "pck-combined-verification",
          "report.json",
        ),
      });
      assert.deepEqual(data.translations.samples, {
        outputs: [combinedFixtureExpectedExplicitEn.output.member],
        permittedAdditions: [],
        retainedLocales: [
          combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
        ],
        truncated: false,
      });
      assert.ok(Array.isArray(data.translations.diagnostics));

      // Original provenance is preserved while the direct CLI consumed only the
      // operation-owned BOM-stripped copy. No ordinary replacement token exists.
      const manifest = JSON.parse(
        await readFile(result.paths.manifest!, "utf8"),
      ) as AnyRecord;
      const argv = manifest.invocation.argv as string[];
      assert.ok(
        argv.includes(
          `--patch-translations=${preparedCsvPath}=${fixture.importSource}`,
        ),
        JSON.stringify(argv),
      );
      assert.ok(!argv.some((token) => token.startsWith("--patch-file=")));
      assert.ok(argv.includes("--locales=en"));
      assert.deepEqual(manifest.effectiveParameters.translations, [
        { csv: originalCsvPath, resource: fixture.importSource },
      ]);
      assert.deepEqual(manifest.effectiveParameters.locales, ["en"]);
      assert.equal(manifest.effectiveParameters.localeSelection, "explicit");

      // The original CSV keeps its BOM and is unchanged; the prepared copy is
      // the BOM-stripped staging file consumed by the CLI.
      assert.equal(await sha256File(originalCsvPath), originalCsvSha256);
      assert.deepEqual(await readFile(originalCsvPath), originalCsvBytes);
      assert.deepEqual(
        await readFile(preparedCsvPath),
        Buffer.from(combinedFixtureExplicitEnCsv.text, "utf8"),
      );
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);

      // Independent package bytes: exact member set, changed selected payload,
      // byte-identical retained/non-target payloads and a distinct output.
      const parsed = await readIndependentFormat2PckFile(outputPath);
      const sourceByName = new Map(
        fixture.members.map((member) => [member.logicalMember, member] as const),
      );
      const outputByName = new Map(
        parsed.members.map((member) => [member.logicalMember, member] as const),
      );
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys()].sort(),
      );
      assert.notEqual(
        outputByName.get(fixture.translationMembers.en)!.sha256,
        sourceByName.get(fixture.translationMembers.en)!.sha256,
        "the selected en translation was regenerated",
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
      assert.deepEqual(
        outputByName.get(fixture.unrelatedMember)!.bytes,
        fixture.unrelatedBytes,
      );
      assert.deepEqual(
        outputByName.get(combinedFixtureOrdinaryTarget)!.bytes,
        fixture.ordinaryBytes,
      );
      assert.deepEqual(
        outputByName.get(fixture.importMember)!.bytes,
        Buffer.from(fixture.importText, "utf8"),
      );

      // Independent native getter readback against hand-authored literals:
      // changed A/B, omitted newer C retained, and zh retained.
      const verify = await runCombinedNative({
        workspace: path.join(root, "independent-verify"),
        name: "tracer-verify",
        scriptPath: combinedVerifyScriptPath,
        request: {
          version: 1,
          package: nativePath(outputPath),
          translations: [
            {
              resource: fixture.importSource,
              member: combinedFixtureExpectedExplicitEn.output.member,
              locale: "en",
              desired: combinedFixtureExpectedExplicitEn.output.desired,
              expectedValues:
                combinedFixtureExpectedExplicitEn.output.expectedValues,
            },
          ],
          retainedLocales:
            combinedFixtureExpectedExplicitEn.retainedLocales.map((entry) => ({
              resource: fixture.importSource,
              member: entry.member,
              locale: entry.locale,
              expectedValues: entry.expectedValues,
            })),
          projectConfig: {
            member: "res://project.godot",
            registration: combinedFixtureExpectedExplicitEn.registration,
          },
        },
      });
      assert.equal(
        verify.report.ok,
        true,
        `independent getter verification failed: ${String(verify.report.error)}`,
      );
      assert.equal((verify.report.outputs as AnyRecord[]).length, 1);
      assert.equal(
        (verify.report.outputs as AnyRecord[])[0]!.verifiedTexts,
        2,
      );
      assert.equal(
        (verify.report.outputs as AnyRecord[])[0]!.retainedContentVerified,
        true,
      );
      assert.equal(
        (verify.report.retainedLocales as AnyRecord[])[0]!
          .retainedContentVerified,
        true,
      );

      // The acquired native reports are retained at the declared references.
      const preparationReport = JSON.parse(
        await readFile(data.translations.reports.preparation, "utf8"),
      ) as AnyRecord;
      assert.equal(preparationReport.ok, true);
      const verificationReport = JSON.parse(
        await readFile(data.translations.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verificationReport.ok, true);
    } finally {
      await execution.close("shutdown");
    }
  },
);

// --- C2b focused host cases -------------------------------------------------

const FAULT_RESOURCE = "res://i18n/translations.csv";
const FAULT_MEMBERS = {
  en: "res://.godot/imported/translations.en.translation",
  zh: "res://.godot/imported/translations.zh.translation",
  import: "res://translations.csv.import",
  unrelated: "res://data/unrelated.txt",
  ordinary: "res://data/replace.bin",
} as const;
const FAULT_SOURCE_BYTES = {
  en: Buffer.from("fault source en\n", "utf8"),
  zh: Buffer.from("故障源 zh\n", "utf8"),
  import: Buffer.from("fault import metadata\n", "utf8"),
  unrelated: Buffer.from("fault unrelated payload\n", "utf8"),
  ordinary: Buffer.from("fault ordinary payload\n", "utf8"),
} as const;
const FAULT_OUTPUT_EN = Buffer.from("fault output en\n", "utf8");
const FAULT_OUTPUT_JA = Buffer.from("fault output ja\n", "utf8");
const FAULT_METADATA = {
  formatVersion: 2,
  engineVersion: { major: 4, minor: 4, patch: 0 },
  encrypted: false,
} as const;
const FAULT_EXPLICIT_EN_CSV = "key,en\nA,new-A\n";
const SOURCE_BYTES = Buffer.from(
  "combined fault source package bytes\n",
  "utf8",
);

const faultMembers = (
  extra: readonly { readonly logicalMember: string; readonly bytes: Buffer }[] = [],
): { readonly logicalMember: string; readonly bytes: Buffer }[] => [
  { logicalMember: FAULT_MEMBERS.en, bytes: FAULT_SOURCE_BYTES.en },
  { logicalMember: FAULT_MEMBERS.zh, bytes: FAULT_SOURCE_BYTES.zh },
  { logicalMember: FAULT_MEMBERS.import, bytes: FAULT_SOURCE_BYTES.import },
  { logicalMember: FAULT_MEMBERS.unrelated, bytes: FAULT_SOURCE_BYTES.unrelated },
  { logicalMember: FAULT_MEMBERS.ordinary, bytes: FAULT_SOURCE_BYTES.ordinary },
  ...extra,
];

const faultSourceReport = (packagePath: string): PckPatchInspectorReport => ({
  schemaVersion: 1,
  ok: true,
  packagePath,
  metadata: {
    ...FAULT_METADATA,
    engineVersion: { ...FAULT_METADATA.engineVersion },
  },
  members: faultMembers().map((member) => ({
    logicalMember: member.logicalMember,
    size: member.bytes.byteLength,
    sha256: combinedFixtureSha256(member.bytes),
  })),
  error: null,
});

const faultOutputReport = (
  packagePath: string,
  options: {
    readonly extraMembers?: readonly {
      readonly logicalMember: string;
      readonly bytes: Buffer;
    }[];
  } = {},
): PckPatchInspectorReport => {
  const members = [
    { logicalMember: FAULT_MEMBERS.en, bytes: FAULT_OUTPUT_EN },
    { logicalMember: FAULT_MEMBERS.zh, bytes: FAULT_SOURCE_BYTES.zh },
    { logicalMember: FAULT_MEMBERS.import, bytes: FAULT_SOURCE_BYTES.import },
    {
      logicalMember: FAULT_MEMBERS.unrelated,
      bytes: FAULT_SOURCE_BYTES.unrelated,
    },
    {
      logicalMember: FAULT_MEMBERS.ordinary,
      bytes: FAULT_SOURCE_BYTES.ordinary,
    },
    ...(options.extraMembers ?? []),
  ];
  return {
    schemaVersion: 1,
    ok: true,
    packagePath,
    metadata: {
      ...FAULT_METADATA,
      engineVersion: { ...FAULT_METADATA.engineVersion },
    },
    members: members.map((member) => ({
      logicalMember: member.logicalMember,
      size: member.bytes.byteLength,
      sha256: combinedFixtureSha256(member.bytes),
    })),
    error: null,
  };
};

const readFaultRequest = async (
  context: PckPatchFaultContext,
): Promise<AnyRecord> =>
  JSON.parse(await readFile(context.requestPath!, "utf8")) as AnyRecord;

const ownedEnvironmentFrom = (
  environment: NodeJS.ProcessEnv,
): { readonly userData: string; readonly temp: string } => ({
  userData: path.join(
    environment.APPDATA!,
    "Godot",
    "app_userdata",
    "Godot RE Tools",
  ),
  temp: environment.TEMP!,
});

const faultPrepareReport = async (
  context: PckPatchFaultContext,
  options: {
    readonly locales?: readonly string[];
    readonly projectRegistration?: readonly string[];
  } = {},
): Promise<AnyRecord> => {
  const request = await readFaultRequest(context);
  const csv = request.translations[0] as AnyRecord;
  const columns = csv.columns as string[];
  const keyIndex = columns.indexOf("key");
  const rows = csv.rows as string[][];
  const selected =
    options.locales ??
    (request.locales.length > 0
      ? (request.locales as string[])
      : columns.filter(
          (column) => column !== "key" && column !== "en" && column !== "zh",
        ));
  const existingLocales = [
    { locale: "en", member: FAULT_MEMBERS.en },
    { locale: "zh", member: FAULT_MEMBERS.zh },
  ];
  const outputs = selected.map((locale) => {
    const columnIndex = columns.indexOf(locale);
    const desired = Object.fromEntries(
      rows.map((row) => [row[keyIndex]!, row[columnIndex]!]),
    ) as Record<string, string>;
    return {
      resource: csv.resource,
      member:
        locale === "en"
          ? FAULT_MEMBERS.en
          : `res://.godot/imported/translations.${locale}.translation`,
      locale,
      kind: existingLocales.some((entry) => entry.locale === locale)
        ? "existing"
        : "new",
      desired,
      expectedValues: [...Object.values(desired), "keep", "newer"],
    };
  });
  const projectConfig =
    options.projectRegistration === undefined
      ? null
      : {
          member: "res://project.godot",
          registration: sortedUnique([
            ...options.projectRegistration,
            ...outputs.map((output) => output.member),
          ]),
        };
  const owned = ownedEnvironmentFrom(context.environment);
  return {
    version: 1,
    ok: true,
    stage: "complete",
    error: null,
    nativeCode: 0,
    source: request.source,
    userData: owned.userData,
    temp: owned.temp,
    mappings: [
      {
        resource: csv.resource,
        csv: csv.csv,
        defaultLocale: "en",
        locales: selected,
      },
    ],
    existingLocales,
    outputs,
    retainedLocales: existingLocales
      .filter((entry) => !selected.includes(entry.locale))
      .map((entry) => ({
        resource: csv.resource,
        member: entry.member,
        locale: entry.locale,
        expectedValues: ["旧值", "保留"],
      })),
    projectConfig,
  };
};

const faultCombinedFailureReport = async (
  context: PckPatchFaultContext,
  kind: "prepare" | "verify",
): Promise<AnyRecord> => {
  const request = await readFaultRequest(context);
  const owned = ownedEnvironmentFrom(context.environment);
  const common = {
    version: 1,
    ok: false,
    stage: "validate",
    error: "controlled native rejection",
    nativeCode: -1,
    userData: owned.userData,
    temp: owned.temp,
    outputs: [],
    retainedLocales: [],
    projectConfig: null,
  };
  return kind === "prepare"
    ? {
        ...common,
        source: request.source,
        mappings: [],
        existingLocales: [],
      }
    : { ...common, package: request.package };
};

const faultVerifyReport = async (
  context: PckPatchFaultContext,
): Promise<AnyRecord> => {
  const request = await readFaultRequest(context);
  const owned = ownedEnvironmentFrom(context.environment);
  return {
    version: 1,
    ok: true,
    stage: "complete",
    error: null,
    nativeCode: 0,
    package: request.package,
    userData: owned.userData,
    temp: owned.temp,
    outputs: (request.translations as AnyRecord[]).map((entry) => ({
      resource: entry.resource,
      member: entry.member,
      locale: entry.locale,
      class: "OptimizedTranslation",
      verifiedTexts: Object.keys(entry.desired as Record<string, string>).length,
      retainedContentVerified: true,
    })),
    retainedLocales: (request.retainedLocales as AnyRecord[]).map((entry) => ({
      resource: entry.resource,
      member: entry.member,
      locale: entry.locale,
      retainedContentVerified: true,
    })),
    projectConfig: request.projectConfig,
  };
};

const combinedFaultScenario = (
  overrides: Partial<PckPatchScenario> = {},
): PckPatchScenario => ({
  sourceReport: (context) => faultSourceReport(context.packagePath!),
  outputReport: (context) => faultOutputReport(context.packagePath!),
  patch: () => ({ outputBytes: PCK_PATCH_DEFAULT_OUTPUT_BYTES }),
  combinedPreparationReport: (context) => faultPrepareReport(context),
  combinedVerificationReport: (context) => faultVerifyReport(context),
  ...overrides,
});

interface FaultFixture {
  readonly root: string;
  readonly workspace: string;
  readonly source: string;
  readonly csv: string;
  readonly replacement: string;
}

const faultFixture = async (
  options: {
    readonly withScripts?: boolean;
    readonly csvText?: string;
    readonly includeReplacement?: boolean;
  } = {},
): Promise<FaultFixture> => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "gdre-mcp-combined-fault-"),
  );
  const workspace = path.join(root, "workspace");
  const native = path.join(root, "native");
  await mkdir(native, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(native, "gdre-pck-inspect.gd"),
    "# controlled inert inspector placeholder\n",
    "utf8",
  );
  if (options.withScripts !== false) {
    await writeFile(
      path.join(native, "gdre-pck-combined-prepare.gd"),
      "# controlled inert preparation placeholder\n",
      "utf8",
    );
    await writeFile(
      path.join(native, "gdre-pck-combined-verify.gd"),
      "# controlled inert verification placeholder\n",
      "utf8",
    );
  }
  const source = path.join(workspace, "source.pck");
  const csv = path.join(workspace, "translations-original.csv");
  const replacement = path.join(workspace, "replacement.bin");
  await writeFile(source, SOURCE_BYTES);
  await writeFile(
    csv,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(options.csvText ?? FAULT_EXPLICIT_EN_CSV, "utf8"),
    ]),
    { flag: "wx" },
  );
  if (options.includeReplacement === true) {
    await writeFile(replacement, combinedFixtureReplacementBytes, {
      flag: "wx",
    });
  }
  return { root, workspace, source, csv, replacement };
};

const makeFaultConfig = (root: string): LoadedConfig => ({
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

const openFaultExecution = (
  root: string,
  scenario: PckPatchScenario,
): {
  readonly execution: ExecutionImpl;
  readonly observed: readonly PckPatchFaultContext[];
} => {
  const state = runtimeState();
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  const harness = createPckPatchFaultRunner(scenario);
  return {
    execution: new ExecutionImpl(makeFaultConfig(root), manager, {
      processRunner: harness.runner,
    }),
    observed: harness.observed,
  };
};

const faultInput = (
  fixture: FaultFixture,
  extra: AnyRecord = {},
): AnyRecord => ({
  source: fixture.source,
  patches: [],
  translations: [{ csv: fixture.csv, resource: FAULT_RESOURCE }],
  locales: ["en"],
  workspace: fixture.workspace,
  ...extra,
});

const closeFault = async (
  execution: ExecutionImpl,
  root: string,
): Promise<void> => {
  await execution.close("shutdown");
  await rm(root, { recursive: true, force: true });
};

const faultKinds = (observed: readonly PckPatchFaultContext[]): string[] =>
  observed.map((entry) => entry.kind);

// --- C2b tests --------------------------------------------------------------

test("combined own dictionary keys survive into the verification request and count", async () => {
  const fixture = await faultFixture({
    csvText: "key,en\n__proto__,proto-text\n",
  });
  const { execution, observed } = openFaultExecution(
    fixture.root,
    combinedFaultScenario(),
  );
  try {
    const result = await execute(
      execution,
      faultInput(fixture),
      new AbortController().signal,
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    const data = result.semantic.data as AnyRecord;
    assert.equal(data.translations.counts.verifiedTexts, 1);
    const verifyRequest = JSON.parse(
      await readFile(
        path.join(result.paths.operation!, "pck-patch", "verify-request.json"),
        "utf8",
      ),
    ) as AnyRecord;
    const desired = verifyRequest.translations[0].desired as AnyRecord;
    assert.equal(Object.hasOwn(desired, "__proto__"), true);
    assert.equal(
      Object.getOwnPropertyDescriptor(desired, "__proto__")?.value,
      "proto-text",
    );
    assert.deepEqual(faultKinds(observed), [
      "source-inspection",
      "combined-preparation",
      "patch",
      "output-inspection",
      "combined-verification",
    ]);
  } finally {
    await closeFault(execution, fixture.root);
  }
});

test("a final successful verification re-confirms input identity", async () => {
  const fixture = await faultFixture();
  let mutated = false;
  const { execution } = openFaultExecution(
    fixture.root,
    combinedFaultScenario({
      afterCombinedVerification: async () => {
        await writeFile(
          fixture.csv,
          "key,en\nA,changed-after-verify\n",
          "utf8",
        );
        mutated = true;
      },
    }),
  );
  try {
    const result = await execute(
      execution,
      faultInput(fixture),
      new AbortController().signal,
    );
    assert.equal(mutated, true);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "semantic_unknown");
    assert.equal(result.semantic.status, "unknown");
  } finally {
    await closeFault(execution, fixture.root);
  }
});

test("omitted selection must equal CSV locales absent from native existing locales", async () => {
  const csvText = "key,en,zh,ja,fr\nA,a,b,c,d\n";
  const cases: readonly {
    readonly name: string;
    readonly locales: readonly string[];
    readonly extraMembers: readonly {
      readonly logicalMember: string;
      readonly bytes: Buffer;
    }[];
  }[] = [
    {
      name: "arbitrary subset omits a new locale",
      locales: ["ja"],
      extraMembers: [
        {
          logicalMember:
            "res://.godot/imported/translations.ja.translation",
          bytes: FAULT_OUTPUT_JA,
        },
      ],
    },
    {
      name: "old locale is reported as a new selection",
      locales: ["en"],
      extraMembers: [],
    },
  ];
  for (const entry of cases) {
    const fixture = await faultFixture({ csvText });
    const { execution, observed } = openFaultExecution(
      fixture.root,
      combinedFaultScenario({
        outputReport: (context) =>
          faultOutputReport(context.packagePath!, {
            extraMembers: entry.extraMembers,
          }),
        combinedPreparationReport: (context) =>
          faultPrepareReport(context, { locales: entry.locales }),
      }),
    );
    try {
      const result = await execute(
        execution,
        faultInput(fixture, { locales: undefined }),
        new AbortController().signal,
      );
      assert.equal(result.success, false, entry.name);
      assert.equal(result.error?.code, "semantic_unknown", entry.name);
      assert.ok(
        !faultKinds(observed).includes("patch"),
        `${entry.name}: no patch must launch`,
      );
    } finally {
      await closeFault(execution, fixture.root);
    }
  }
});

test("natural nonzero combined rejection reports stay truthful evidence", async () => {
  const prepareFixture = await faultFixture();
  const prepareExecution = openFaultExecution(
    prepareFixture.root,
    combinedFaultScenario({
      combinedPreparationReport: (context) =>
        faultCombinedFailureReport(context, "prepare"),
      combinedPreparationOutcome: () => ({ exitCode: 1 }),
    }),
  );
  try {
    const result = await execute(
      prepareExecution.execution,
      faultInput(prepareFixture),
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(
      result.error?.code,
      "semantic_failed",
      JSON.stringify(result.error),
    );
    assert.ok(!faultKinds(prepareExecution.observed).includes("patch"));
    const data = result.semantic.data as AnyRecord;
    assert.equal(data.completeness, "failed");
    assert.notEqual(data.translations.reports.preparation, null);
  } finally {
    await closeFault(prepareExecution.execution, prepareFixture.root);
  }

  const verifyFixture = await faultFixture();
  const verifyExecution = openFaultExecution(
    verifyFixture.root,
    combinedFaultScenario({
      combinedVerificationReport: (context) =>
        faultCombinedFailureReport(context, "verify"),
      combinedVerificationOutcome: () => ({ exitCode: 1 }),
    }),
  );
  try {
    const result = await execute(
      verifyExecution.execution,
      faultInput(verifyFixture),
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(
      result.error?.code,
      "semantic_failed",
      JSON.stringify(result.error),
    );
    assert.ok(
      result.stdout.text.includes(
        `Patched PCK file: ${result.paths.effectiveDestination!}`,
      ),
      "the direct patch marker must survive a later failed verification report",
    );
    const data = result.semantic.data as AnyRecord;
    assert.notEqual(data.translations.reports.verification, null);
  } finally {
    await closeFault(verifyExecution.execution, verifyFixture.root);
  }
});

test("malformed or mismatched combined verification reports never become success", async () => {
  const cases: readonly {
    readonly name: string;
    readonly scenario: Partial<PckPatchScenario>;
  }[] = [
    {
      name: "malformed verification JSON",
      scenario: { combinedVerificationReport: () => "malformed" },
    },
    {
      name: "mismatched verification member",
      scenario: {
        combinedVerificationReport: async (context) => {
          const report = await faultVerifyReport(context);
          (report.outputs as AnyRecord[])[0]!.member =
            "res://.godot/imported/other.en.translation";
          return report;
        },
      },
    },
    {
      name: "wrong verified text count",
      scenario: {
        combinedVerificationReport: async (context) => {
          const report = await faultVerifyReport(context);
          (report.outputs as AnyRecord[])[0]!.verifiedTexts = 2;
          return report;
        },
      },
    },
  ];
  for (const entry of cases) {
    const fixture = await faultFixture();
    const { execution } = openFaultExecution(
      fixture.root,
      combinedFaultScenario(entry.scenario),
    );
    try {
      const result = await execute(
        execution,
        faultInput(fixture),
        new AbortController().signal,
      );
      assert.equal(result.success, false, entry.name);
      assert.equal(result.error?.code, "semantic_unknown", entry.name);
      assert.ok(
        result.stdout.text.includes(
          `Patched PCK file: ${result.paths.effectiveDestination!}`,
        ),
        `${entry.name}: the direct patch marker must remain`,
      );
      const data = result.semantic.data as AnyRecord;
      assert.notEqual(
        data.translations.reports.verification,
        null,
        `${entry.name}: the acquired report remains referenced`,
      );
    } finally {
      await closeFault(execution, fixture.root);
    }
  }
});

test("known combined failure retains only specifically known temp observations as partial", async () => {
  const fixture = await faultFixture();
  const sentinelBytes = Buffer.from("unknown sibling must stay untouched\n");
  let knownTempPath = "";
  let sentinelPath = "";
  const { execution } = openFaultExecution(
    fixture.root,
    combinedFaultScenario({
      combinedVerificationReport: (context) =>
        faultCombinedFailureReport(context, "verify"),
      afterCombinedPreparation: async (context) => {
        const userData = path.join(
          context.environment.APPDATA!,
          "Godot",
          "app_userdata",
          "Godot RE Tools",
        );
        const tempRoot = path.join(userData, ".tmp_translations");
        knownTempPath = path.join(
          tempRoot,
          FAULT_MEMBERS.en.slice("res://".length),
        );
        sentinelPath = path.join(tempRoot, "unknown-sentinel.bin");
        await mkdir(path.dirname(knownTempPath), { recursive: true });
        await writeFile(knownTempPath, "known generated temp\n", "utf8");
        await writeFile(sentinelPath, sentinelBytes, "utf8");
      },
    }),
  );
  try {
    const result = await execute(
      execution,
      faultInput(fixture),
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "semantic_failed");
    const data = result.semantic.data as AnyRecord;
    assert.equal(data.completeness, "partial");
    assert.equal(data.counts.unverifiedFiles, 2);
    assert.ok(
      data.samples.unverifiedFiles.includes(knownTempPath),
      "the known generated temp observation is bounded and referenced",
    );
    assert.ok(
      !data.samples.unverifiedFiles.includes(sentinelPath),
      "unknown siblings are never enumerated",
    );
    assert.equal(result.artifacts.count, 0);
    assert.deepEqual(result.artifacts.items, []);
    assert.deepEqual(await readFile(sentinelPath), sentinelBytes);
    const evidence = JSON.parse(
      await readFile(
        path.join(result.paths.operation!, "pck-patch", "verification.json"),
        "utf8",
      ),
    ) as AnyRecord;
    assert.equal(evidence.completeness, "partial");
    assert.deepEqual(
      (evidence.combinedTempObservations as AnyRecord[]).map(
        (entry) => entry.member,
      ),
      [FAULT_MEMBERS.en],
    );
    assert.ok(
      (evidence.combinedTempObservations as AnyRecord[]).every(
        (entry) => !Object.hasOwn(entry.observation, "sha256"),
      ),
      "temp observations are availability stats, not hashed evidence",
    );
  } finally {
    await closeFault(execution, fixture.root);
  }
});

test("combined preparation guards fail closed before mutation or launch", async () => {
  const cases: readonly {
    readonly name: string;
    readonly fixture: () => Promise<FaultFixture>;
    readonly input: (fixture: FaultFixture) => AnyRecord;
    readonly code: string;
  }[] = [
    {
      name: "missing fixed combined scripts",
      fixture: () => faultFixture({ withScripts: false }),
      input: (fixture) => faultInput(fixture),
      code: "unsupported_capability",
    },
    {
      name: "invalid CSV",
      fixture: () => faultFixture({ csvText: "key\nA\n" }),
      input: (fixture) => faultInput(fixture),
      code: "validation_failed",
    },
    {
      name: "CSV aliases the source package",
      fixture: () => faultFixture(),
      input: (fixture) =>
        faultInput(fixture, {
          translations: [
            { csv: fixture.source, resource: FAULT_RESOURCE },
          ],
        }),
      code: "validation_failed",
    },
    {
      name: "CSV aliases an ordinary host source",
      fixture: () => faultFixture({ includeReplacement: true }),
      input: (fixture) =>
        faultInput(fixture, {
          patches: [
            {
              hostSource: fixture.replacement,
              logicalMember: FAULT_MEMBERS.ordinary,
            },
          ],
          translations: [
            { csv: fixture.replacement, resource: FAULT_RESOURCE },
          ],
        }),
      code: "validation_failed",
    },
    {
      name: "output aliases the CSV",
      fixture: () => faultFixture(),
      input: (fixture) => faultInput(fixture, { output: fixture.csv }),
      code: "path_unsupported",
    },
    {
      name: "output already exists",
      fixture: () => faultFixture(),
      input: (fixture) =>
        faultInput(fixture, {
          output: path.join(fixture.workspace, "existing-output.pck"),
        }),
      code: "path_unsupported",
    },
  ];
  for (const entry of cases) {
    const fixture = await entry.fixture();
    if (entry.name === "output already exists") {
      await writeFile(
        path.join(fixture.workspace, "existing-output.pck"),
        "existing\n",
        { flag: "wx" },
      );
    }
    const { execution, observed } = openFaultExecution(
      fixture.root,
      combinedFaultScenario(),
    );
    try {
      const result = await execute(
        execution,
        entry.input(fixture),
        new AbortController().signal,
      );
      assert.equal(result.success, false, entry.name);
      assert.equal(result.error?.code, entry.code, entry.name);
      assert.deepEqual(faultKinds(observed), [], entry.name);
      assert.equal(
        (await readFile(fixture.csv)).byteLength > 0,
        true,
        `${entry.name}: original CSV remains readable`,
      );
      assert.equal(
        await readFile(
          path.join(result.paths.operation!, "pck-patch", "prepared-0.csv"),
        ).then(
          () => true,
          () => false,
        ),
        false,
        `${entry.name}: no prepared copy or native launch may exist before validation`,
      );
    } finally {
      await closeFault(execution, fixture.root);
    }
  }
});

test("combined preparation and verification stops preserve bounded evidence", async () => {
  for (const trigger of ["cancel", "timeout"] as const) {
    const fixture = await faultFixture();
    const { execution, observed } = openFaultExecution(
      fixture.root,
      combinedFaultScenario({
        combinedPreparationReport: () => "missing",
        combinedPreparationOutcome: () => ({ exitCode: null, trigger }),
      }),
    );
    try {
      const result = await execute(
        execution,
        faultInput(fixture),
        new AbortController().signal,
      );
      assert.equal(
        result.status,
        trigger === "cancel" ? "cancelled" : "timed_out",
        trigger,
      );
      assert.ok(!faultKinds(observed).includes("patch"), trigger);
      const data = result.semantic.data as AnyRecord;
      assert.equal(data.translations.reports.preparation, null, trigger);
    } finally {
      await closeFault(execution, fixture.root);
    }
  }

  const prepareCleanupFixture = await faultFixture();
  const prepareCleanupExecution = openFaultExecution(
    prepareCleanupFixture.root,
    combinedFaultScenario({
      combinedPreparationOutcome: () => ({
        exitCode: 0,
        cleanup: {
          state: "unconfirmed",
          trigger: null,
          actions: [],
          error: "controlled preparation cleanup failure",
        },
      }),
    }),
  );
  try {
    const result = await execute(
      prepareCleanupExecution.execution,
      faultInput(prepareCleanupFixture),
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "cleanup_failed");
    assert.ok(
      !faultKinds(prepareCleanupExecution.observed).includes("patch"),
      "cleanup failure must stop before the direct patch",
    );
  } finally {
    await closeFault(
      prepareCleanupExecution.execution,
      prepareCleanupFixture.root,
    );
  }

  const verifyFixture = await faultFixture();
  const verifySentinelBytes = Buffer.from("stop sentinel untouched\n");
  let verifyKnownTemp = "";
  let verifySentinel = "";
  const verifyExecution = openFaultExecution(
    verifyFixture.root,
    combinedFaultScenario({
      combinedVerificationReport: () => "missing",
      combinedVerificationOutcome: () => ({
        exitCode: null,
        trigger: "timeout",
      }),
      afterCombinedPreparation: async (context) => {
        const userData = path.join(
          context.environment.APPDATA!,
          "Godot",
          "app_userdata",
          "Godot RE Tools",
        );
        const tempRoot = path.join(userData, ".tmp_translations");
        verifyKnownTemp = path.join(
          tempRoot,
          FAULT_MEMBERS.en.slice("res://".length),
        );
        verifySentinel = path.join(tempRoot, "stop-sentinel.bin");
        await mkdir(path.dirname(verifyKnownTemp), { recursive: true });
        await writeFile(verifyKnownTemp, "known temp after stop\n", "utf8");
        await writeFile(verifySentinel, verifySentinelBytes, "utf8");
      },
    }),
  );
  try {
    const result = await execute(
      verifyExecution.execution,
      faultInput(verifyFixture),
      new AbortController().signal,
    );
    assert.equal(result.status, "timed_out");
    assert.equal(result.success, false);
    const data = result.semantic.data as AnyRecord;
    assert.equal(data.completeness, "unknown");
    assert.equal(data.translations.reports.verification, null);
    assert.equal(data.counts.unverifiedFiles, 2);
    assert.ok(data.samples.unverifiedFiles.includes(verifyKnownTemp));
    assert.ok(!data.samples.unverifiedFiles.includes(verifySentinel));
    assert.deepEqual(await readFile(verifySentinel), verifySentinelBytes);
    const evidence = JSON.parse(
      await readFile(
        path.join(result.paths.operation!, "pck-patch", "verification.json"),
        "utf8",
      ),
    ) as AnyRecord;
    assert.equal(evidence.stage, "verification");
    assert.equal(evidence.reportsParsed, false);
    assert.equal(evidence.inputFingerprintsRechecked, false);
    assert.deepEqual(
      (evidence.combinedTempObservations as AnyRecord[]).map(
        (entry) => entry.member,
      ),
      [FAULT_MEMBERS.en],
    );
  } finally {
    await closeFault(verifyExecution.execution, verifyFixture.root);
  }

  const cleanupFixture = await faultFixture();
  const cleanupExecution = openFaultExecution(
    cleanupFixture.root,
    combinedFaultScenario({
      combinedVerificationOutcome: () => ({
        exitCode: 0,
        cleanup: {
          state: "unconfirmed",
          trigger: null,
          actions: [],
          error: "controlled cleanup failure",
        },
      }),
    }),
  );
  try {
    const result = await execute(
      cleanupExecution.execution,
      faultInput(cleanupFixture),
      new AbortController().signal,
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "cleanup_failed");
  } finally {
    await closeFault(cleanupExecution.execution, cleanupFixture.root);
  }
});

test(
  "omitted locale adds exactly ja with default-en content and keeps ordinary registration",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-omitted-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const registration = [
      combinedFixtureDefaultDestinations.en,
      combinedFixtureDefaultDestinations.zh,
      combinedFixtureOrdinaryTarget,
    ];
    const fixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixture"),
      projectRegistration: registration,
    });
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const csvPath = path.join(workspace, "translations-original.csv");
    await writeFile(
      csvPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(combinedFixtureOmittedJaCsv.text, "utf8"),
      ]),
      { flag: "wx" },
    );
    const sourceSha256 = await sha256File(fixture.packagePath);
    await prepareNativeOwnershipHelper(
      path.join(repositoryRoot, "native", "gdre-job-object.ps1"),
    );
    const execution = openExecution(workspace);
    try {
      const result = await execute(
        execution,
        {
          source: fixture.packagePath,
          patches: [],
          translations: [{ csv: csvPath, resource: fixture.importSource }],
          workspace,
          timeoutMs: 600_000,
        },
        new AbortController().signal,
      );
      assert.equal(
        result.success,
        true,
        JSON.stringify({ error: result.error, semantic: result.semantic }),
      );
      const data = result.semantic.data as AnyRecord;
      assert.deepEqual(data.translations.localeSelection, {
        mode: "new-locales-only",
        locales: [],
      });
      assert.deepEqual(data.translations.counts, {
        mappings: 1,
        outputs: 1,
        verifiedResources: 1,
        verifiedTexts: 2,
        retainedLocales: 2,
        permittedAdditions: 1,
      });
      assert.deepEqual(data.translations.samples.outputs, [
        combinedFixtureNewLocaleMember,
      ]);
      assert.deepEqual(data.translations.samples.permittedAdditions, [
        combinedFixtureNewLocaleMember,
      ]);
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);

      const outputPath = result.paths.effectiveDestination!;
      assert.equal(
        outputPath,
        defaultPatchedOutput(fixture.packagePath, result.paths.operation!),
      );
      const parsed = await readIndependentFormat2PckFile(outputPath);
      const sourceByName = new Map(
        fixture.members.map(
          (member) => [member.logicalMember, member] as const,
        ),
      );
      const outputByName = new Map(
        parsed.members.map(
          (member) => [member.logicalMember, member] as const,
        ),
      );
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys(), combinedFixtureNewLocaleMember].sort(),
      );
      for (const member of sourceByName.keys()) {
        if (member === fixture.projectConfigMember) continue;
        assert.equal(
          outputByName.get(member)!.sha256,
          sourceByName.get(member)!.sha256,
          `${member} must be retained byte-identically`,
        );
      }
      assert.ok(outputByName.has(combinedFixtureNewLocaleMember));

      const expectedRegistration = sortedUnique([
        ...registration,
        combinedFixtureNewLocaleMember,
      ]);
      const verify = await runCombinedNative({
        workspace: path.join(root, "independent-verify"),
        name: "omitted-ja-verify",
        scriptPath: combinedVerifyScriptPath,
        request: {
          version: 1,
          package: nativePath(outputPath),
          translations: [
            {
              resource: fixture.importSource,
              member: combinedFixtureExpectedOmittedJa.output.member,
              locale: "ja",
              desired: combinedFixtureExpectedOmittedJa.output.desired,
              expectedValues:
                combinedFixtureExpectedOmittedJa.output.expectedValues,
            },
          ],
          retainedLocales:
            combinedFixtureExpectedOmittedJa.retainedLocales.map((entry) => ({
              resource: fixture.importSource,
              member: entry.member,
              locale: entry.locale,
              expectedValues: entry.expectedValues,
            })),
          projectConfig: {
            member: "res://project.godot",
            registration: expectedRegistration,
          },
        },
      });
      assert.equal(
        verify.report.ok,
        true,
        `independent omitted-ja getter verification failed: ${String(verify.report.error)}`,
      );
      const output = (verify.report.outputs as AnyRecord[])[0]!;
      assert.equal(output.locale, "ja");
      assert.equal(output.verifiedTexts, 2);
    } finally {
      await execution.close("shutdown");
    }
  },
);

test(
  "mixed combined patching replaces ordinary bytes exactly",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-mixed-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const fixture = await createCombinedTranslationFixture({
      root: path.join(root, "fixture"),
    });
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const csvPath = path.join(workspace, "translations-original.csv");
    const replacementPath = path.join(workspace, "replacement.bin");
    await writeFile(
      csvPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(combinedFixtureExplicitEnCsv.text, "utf8"),
      ]),
      { flag: "wx" },
    );
    await writeFile(replacementPath, combinedFixtureReplacementBytes, {
      flag: "wx",
    });
    const sourceSha256 = await sha256File(fixture.packagePath);
    await prepareNativeOwnershipHelper(
      path.join(repositoryRoot, "native", "gdre-job-object.ps1"),
    );
    const execution = openExecution(workspace);
    try {
      const result = await execute(
        execution,
        {
          source: fixture.packagePath,
          patches: [
            {
              hostSource: replacementPath,
              logicalMember: combinedFixtureOrdinaryTarget,
            },
          ],
          translations: [{ csv: csvPath, resource: fixture.importSource }],
          locales: ["en"],
          workspace,
          timeoutMs: 600_000,
        },
        new AbortController().signal,
      );
      assert.equal(
        result.success,
        true,
        JSON.stringify({ error: result.error, semantic: result.semantic }),
      );
      const data = result.semantic.data as AnyRecord;
      assert.deepEqual(data.counts, {
        mappings: 1,
        verifiedReplacements: 1,
        verifiedRetainedMembers: 3,
        unverifiedFiles: 0,
      });
      assert.deepEqual(data.translations.counts, {
        mappings: 1,
        outputs: 1,
        verifiedResources: 1,
        verifiedTexts: 2,
        retainedLocales: 1,
        permittedAdditions: 0,
      });
      const manifest = JSON.parse(
        await readFile(result.paths.manifest!, "utf8"),
      ) as AnyRecord;
      const argv = manifest.invocation.argv as string[];
      assert.ok(
        argv.includes(
          `--patch-file=${replacementPath}=${combinedFixtureOrdinaryTarget}`,
        ),
      );
      const preparedPath = path.join(
        result.paths.operation!,
        "pck-patch",
        "prepared-0.csv",
      );
      assert.ok(
        argv.includes(
          `--patch-translations=${preparedPath}=${fixture.importSource}`,
        ),
      );
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);

      const parsed = await readIndependentFormat2PckFile(
        result.paths.effectiveDestination!,
      );
      assert.equal(
        result.paths.effectiveDestination,
        defaultPatchedOutput(fixture.packagePath, result.paths.operation!),
        "mixed default output stays beside the source, not the CSV or replacement",
      );
      const outputByName = new Map(
        parsed.members.map(
          (member) => [member.logicalMember, member] as const,
        ),
      );
      assert.deepEqual(
        outputByName.get(combinedFixtureOrdinaryTarget)!.bytes,
        combinedFixtureReplacementBytes,
      );
      const sourceByName = new Map(
        fixture.members.map(
          (member) => [member.logicalMember, member] as const,
        ),
      );
      assert.notEqual(
        outputByName.get(fixture.translationMembers.en)!.sha256,
        sourceByName.get(fixture.translationMembers.en)!.sha256,
      );
      assert.equal(
        outputByName.get(fixture.translationMembers.zh)!.sha256,
        sourceByName.get(fixture.translationMembers.zh)!.sha256,
      );
      assert.deepEqual(
        outputByName.get(fixture.unrelatedMember)!.bytes,
        fixture.unrelatedBytes,
      );
    } finally {
      await execution.close("shutdown");
    }
  },
);
