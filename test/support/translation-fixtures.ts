import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProcessRunner, type ProcessRunResult } from "../../src/process.js";
import { prepareNativeOwnershipHelper } from "../../src/process-tree.js";
import { OperationStorage } from "../../src/storage.js";
import {
  patchTranslationsReportPath,
  patchTranslationsRequestPath,
} from "../../src/translation-planning.js";
import { writeIndependentPck } from "./extraction-fixtures.js";
import { createFixtureProfile } from "./extraction-input-fixtures.js";

/**
 * Independently authored standalone translation fixture.
 *
 * The two optimized resources start as static `.tres` literals with known keys
 * and text. The fixed runtime is used only to load those literals and save them
 * through the accepted native extractor/compatibility-save route. The PCK is
 * written independently, and every expected value stays a literal below.
 */

export const translationFixtureLocales = ["en", "zh"] as const;
export type TranslationFixtureLocale = (typeof translationFixtureLocales)[number];

export const translationFixtureKeys = ["A", "B"] as const;
export type TranslationFixtureKey = (typeof translationFixtureKeys)[number];

/** Independently known original text; patches retain B and edit A. */
export const translationFixtureValues: Record<
  TranslationFixtureLocale,
  Record<TranslationFixtureKey, string>
> = {
  en: { A: "old", B: "keep" },
  zh: { A: "旧值", B: "保留" },
};

export const translationFixtureSourceFile = "res://translations.csv";
export const translationFixtureImportMember = "res://translations.csv.import";
export const translationFixtureProjectMember = "res://project.godot";

/** Default optimized-resource destinations for the standard fixture. */
export const translationFixtureDefaultDestinations: Readonly<
  Record<TranslationFixtureLocale, string>
> = {
  en: "res://.godot/imported/translations.en.translation",
  zh: "res://.godot/imported/translations.zh.translation",
};
export const translationFixtureDefaultOrder = ["en", "zh"] as const;

const quoteGodotString = (value: string): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("translation fixture string encoding failed");
  return encoded;
};

export interface TranslationFixtureProjectOptions {
  /** Configured fallback locale; defaults to `en`. */
  readonly fallback?: string;
  /**
   * Explicit registration array, `null` to omit the setting, `"wrong-type"` to
   * author a present non-array value, or `"non-string-member"` to author an
   * Array containing a non-string element.
   */
  readonly registration?: readonly string[] | null | "wrong-type" | "non-string-member";
}

export const makeTranslationFixtureProjectText = (
  order: readonly TranslationFixtureLocale[],
  destinations: Readonly<Record<TranslationFixtureLocale, string>>,
  options: TranslationFixtureProjectOptions = {},
): string => {
  const fallback = options.fallback ?? "en";
  const registration =
    options.registration === undefined ? order.map((locale) => destinations[locale]) : options.registration;
  const lines = [
    "config_version=5",
    "",
    "[application]",
    'config/name="Controlled standalone translation patch"',
    "",
    "[internationalization]",
    `locale/fallback=${quoteGodotString(fallback)}`,
  ];
  if (registration === "wrong-type") {
    lines.push(`locale/translations=${quoteGodotString("not-a-string-array")}`);
  } else if (registration === "non-string-member") {
    lines.push(
      `locale/translations=[1, ${quoteGodotString(destinations[order[0]!])}]`,
    );
  } else if (registration !== null) {
    lines.push(`locale/translations=PackedStringArray(${registration.map(quoteGodotString).join(", ")})`);
  }
  lines.push("");
  return lines.join("\n");
};

export const makeTranslationFixtureImportText = (
  order: readonly TranslationFixtureLocale[],
  destinations: Readonly<Record<TranslationFixtureLocale, string>>,
): string => [
  "[remap]",
  'importer="csv_translation"',
  'type="Translation"',
  "",
  "[deps]",
  `source_file=${quoteGodotString(translationFixtureSourceFile)}`,
  `dest_files=[${order.map((locale) => quoteGodotString(destinations[locale])).join(", ")}]`,
  "",
  "[params]",
  "compress=true",
  "delimiter=0",
  "",
].join("\n");

export const translationFixtureProjectText = makeTranslationFixtureProjectText(
  translationFixtureDefaultOrder,
  translationFixtureDefaultDestinations,
);

export const translationFixtureImportText = makeTranslationFixtureImportText(
  translationFixtureDefaultOrder,
  translationFixtureDefaultDestinations,
);

export const translationFixtureMember = (locale: string): string =>
  translationFixtureDefaultDestinations[locale as TranslationFixtureLocale] ??
  `res://.godot/imported/translations.${locale}.translation`;

/**
 * Static optimized-translation literals. The literal bucket/string arrays are
 * fixed fixture data for keys A and B; this is not a table-generation
 * algorithm and does not implement an encoder.
 */
const staticTranslationTres = (locale: TranslationFixtureLocale): string => {
  const bucket =
    locale === "en"
      ? "2, 1, 16777682, 0, 4, 4, 16777681, 4, 5, 5"
      : "2, 1, 16777682, 0, 7, 7, 16777681, 7, 7, 7";
  const strings =
    locale === "en"
      ? "111,108,100,0,107,101,101,112,0"
      : "230,151,167,229,128,188,0,228,191,157,231,149,153,0";
  return [
    '[gd_resource type="OptimizedTranslation" format=3]',
    "",
    "[resource]",
    `locale = "${locale}"`,
    "hash_table = PackedInt32Array(0)",
    `bucket_table = PackedInt32Array(${bucket})`,
    `strings = PackedByteArray(${strings})`,
    "",
  ].join("\n");
};

export interface StandaloneTranslationFixture {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly packagePath: string;
  readonly importSource: typeof translationFixtureSourceFile;
  readonly importMember: typeof translationFixtureImportMember;
  /** Default text project member; retained for the standard fixture. */
  readonly projectMember: typeof translationFixtureProjectMember;
  /** Actual project member in this package (text or binary). */
  readonly projectConfigMember: string;
  readonly projectConfigKind: "text" | "binary";
  readonly destinationOrder: readonly TranslationFixtureLocale[];
  readonly locales: readonly TranslationFixtureLocale[];
  readonly defaultLocale: "en";
  readonly keys: readonly TranslationFixtureKey[];
  readonly values: typeof translationFixtureValues;
  readonly translationMembers: Readonly<Record<TranslationFixtureLocale, string>>;
  readonly importText: string;
  readonly projectText: string;
  readonly packageSha256: string;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const authorScriptPath = path.join(
  repositoryRoot,
  "test",
  "support",
  "gdre-author-translation-fixture.gd",
);
const readerScriptPath = path.join(
  repositoryRoot,
  "test",
  "support",
  "gdre-read-translation-fixture.gd",
);
const binaryProjectConfigScriptPath = path.join(
  repositoryRoot,
  "test",
  "support",
  "gdre-author-project-config-binary.gd",
);
const ownershipHelperPath = path.join(
  repositoryRoot,
  "native",
  "gdre-job-object.ps1",
);

export const defaultTranslationRuntimeExecutable = path.join(
  process.env.GDRE_MCP_RUNTIME_DIR !== undefined && process.env.GDRE_MCP_RUNTIME_DIR !== ""
    ? process.env.GDRE_MCP_RUNTIME_DIR
    : path.join(repositoryRoot, "vendor", "GDRE_tools"),
  "gdre_tools.exe",
);

export const translationPatchScriptPath = path.join(
  repositoryRoot,
  "native",
  "gdre-patch-translations.gd",
);

type AnyRecord = Record<string, any>;

let ownershipHelperReady: Promise<unknown> | undefined;

const ensureOwnershipHelper = (): Promise<unknown> =>
  (ownershipHelperReady ??= prepareNativeOwnershipHelper(ownershipHelperPath));

export const sha256Bytes = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const sha256File = async (file: string): Promise<string> =>
  sha256Bytes(await readFile(file));

const requireNonemptyFile = async (file: string, label: string): Promise<Buffer> => {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile() || info.size === 0) {
    throw new Error(`translation fixture is missing nonempty ${label}: ${file}`);
  }
  return readFile(file);
};

export interface OwnedNativeResult {
  readonly operation: string;
  readonly profileRoot: string;
  readonly result: ProcessRunResult;
  readonly evidencePath: string;
  readonly report: AnyRecord;
}

interface OwnedNativeOptions {
  readonly workspace: string;
  readonly name: string;
  readonly scriptPath: string;
  readonly argumentsFor: (evidencePath: string) => readonly string[];
  readonly timeoutMs: number;
  readonly evidencePath?: string;
  readonly expectedExitCode?: number;
  readonly redactSecrets?: readonly string[];
}

interface OwnedNativeProcessOptions {
  readonly name: string;
  readonly scriptPath: string;
  readonly argumentsFor: (evidencePath: string) => readonly string[];
  readonly timeoutMs: number;
  readonly evidencePath?: string;
  readonly expectedExitCode?: number;
  readonly redactSecrets?: readonly string[];
}

/**
 * Run one fixed trusted script against an already allocated operation. The
 * operation's stream handles remain owned by the caller.
 */
async function runOwnedInStorage(
  storage: OperationStorage,
  options: OwnedNativeProcessOptions,
): Promise<OwnedNativeResult> {
  await ensureOwnershipHelper();
  const profile = await createFixtureProfile(storage.paths.profile, options.name);
  const evidencePath =
    options.evidencePath ?? path.join(storage.paths.operation, `${options.name}.json`);
  const result = await defaultProcessRunner.run({
    executable: defaultTranslationRuntimeExecutable,
    argv: [
      "--headless",
      "--script",
      options.scriptPath,
      "--",
      ...options.argumentsFor(evidencePath),
    ],
    cwd: profile.cwd,
    env: profile.env,
    timeoutMs: options.timeoutMs,
    streamPaths: {
      stdoutBin: storage.paths.stdoutBin,
      stdoutText: storage.paths.stdoutText,
      stderrBin: storage.paths.stderrBin,
      stderrText: storage.paths.stderrText,
    },
    statusPath: path.join(storage.paths.operation, "ownership.json"),
    helperScriptPath: ownershipHelperPath,
    redactSecrets: options.redactSecrets,
  });

  const expectedExitCode = options.expectedExitCode ?? 0;
  const diagnostics = [
    `fixed native script did not complete as expected: ${options.scriptPath}`,
    `operation: ${storage.paths.operation}`,
    `exit code: ${String(result.exitCode)} (expected ${String(expectedExitCode)})`,
    `cleanup: ${result.cleanup.state}`,
    `capture errors: stdout=${String(result.stdout.complete)} stderr=${String(result.stderr.complete)}`,
    result.error === null ? "" : `process error: ${result.error}`,
    result.captureError === null ? "" : `capture error: ${result.captureError}`,
    result.storageError === null ? "" : `storage error: ${result.storageError}`,
    result.stdoutText === "" ? "" : `stdout tail: ${result.stdoutText.slice(-2_000)}`,
    result.stderrText === "" ? "" : `stderr tail: ${result.stderrText.slice(-2_000)}`,
  ].filter((line) => line !== "");
  if (
    result.exitCode !== expectedExitCode ||
    result.cleanup.state !== "confirmed" ||
    !result.stdout.complete ||
    !result.stderr.complete ||
    result.error !== null ||
    result.captureError !== null ||
    result.storageError !== null
  ) {
    throw new Error(diagnostics.join("\n"));
  }

  let report: AnyRecord;
  try {
    report = JSON.parse(await readFile(evidencePath, "utf8")) as AnyRecord;
  } catch (error) {
    throw new Error(
      `${diagnostics.join("\n")}\nmissing or invalid native report: ${evidencePath}\n${String(error)}`,
    );
  }
  return {
    operation: storage.paths.operation,
    profileRoot: storage.paths.profile,
    result,
    evidencePath,
    report,
  };
}

/**
 * Run one fixed trusted script through the existing owned ProcessRunner,
 * OperationStorage evidence and fresh operation profile entry. Stream handles
 * are closed before this function returns.
 */
async function runOwnedNative(options: OwnedNativeOptions): Promise<OwnedNativeResult> {
  if (!path.isAbsolute(options.workspace)) {
    throw new Error(`native operation workspace must be absolute: ${options.workspace}`);
  }
  const storage = await OperationStorage.create(options.workspace);
  try {
    return await runOwnedInStorage(storage, options);
  } finally {
    await storage.closeStreams();
  }
}

export interface CreateStandaloneTranslationFixtureOptions {
  /** Fresh caller-owned fixture root; the helper does not clean it up. */
  readonly root: string;
  /** Override logical optimized-resource destinations for a controlled variant. */
  readonly destinations?: Partial<Record<TranslationFixtureLocale, string>>;
  /** Destination order used in import metadata and project locale data. */
  readonly destinationOrder?: readonly TranslationFixtureLocale[];
  /** Author a text project.godot or convert it to a binary project config. */
  readonly projectConfig?: "text" | "binary";
}

const memberRelative = (member: string): string => {
  if (!member.startsWith("res://") || member.length <= "res://".length) {
    throw new Error(`translation fixture destination is not a res:// member: ${member}`);
  }
  return member.slice("res://".length);
};

export async function authorBinaryProjectConfig(
  textPackagePath: string,
  fixtureRoot: string,
): Promise<Buffer> {
  const outputDirectory = path.join(fixtureRoot, "binary-config");
  await mkdir(outputDirectory, { recursive: true });
  const authored = await runOwnedNative({
    workspace: path.join(fixtureRoot, "binary-operations"),
    name: "binary-config",
    scriptPath: binaryProjectConfigScriptPath,
    timeoutMs: 120_000,
    argumentsFor: (evidencePath) => [textPackagePath, outputDirectory, evidencePath],
  });
  if (authored.report.ok !== true) {
    throw new Error(
      `binary project configuration authoring failed: ${String(authored.report.error)} (${authored.evidencePath})`,
    );
  }
  const binaryPath = path.join(outputDirectory, "project.binary");
  const bytes = await requireNonemptyFile(binaryPath, "binary project configuration");
  if (bytes.subarray(0, 4).toString("latin1") !== "ECFG") {
    throw new Error(`binary project configuration does not start with ECFG: ${binaryPath}`);
  }
  return bytes;
}

export async function createStandaloneTranslationFixture(
  options: CreateStandaloneTranslationFixtureOptions,
): Promise<StandaloneTranslationFixture> {
  if (!path.isAbsolute(options.root)) {
    throw new Error(`translation fixture root must be absolute: ${options.root}`);
  }
  const destinations = {
    ...translationFixtureDefaultDestinations,
    ...options.destinations,
  };
  const destinationOrder = [...(options.destinationOrder ?? translationFixtureDefaultOrder)];
  if (
    destinationOrder.length !== translationFixtureLocales.length ||
    new Set(destinationOrder).size !== translationFixtureLocales.length ||
    !translationFixtureLocales.every((locale) => destinationOrder.includes(locale))
  ) {
    throw new Error("translation fixture destination order must list each locale exactly once");
  }
  const projectConfigKind = options.projectConfig ?? "text";
  if (projectConfigKind !== "text" && projectConfigKind !== "binary") {
    throw new Error(`unsupported translation fixture project config kind: ${String(projectConfigKind)}`);
  }
  const destinationRelatives = destinationOrder.map((locale) => memberRelative(destinations[locale]));
  if (new Set(destinationRelatives).size !== destinationRelatives.length) {
    throw new Error("translation fixture destinations must be unique");
  }

  await mkdir(options.root, { recursive: true });
  const sourceDirectory = path.join(options.root, "source");
  await mkdir(sourceDirectory, { recursive: true });
  for (const locale of translationFixtureLocales) {
    await writeFile(path.join(sourceDirectory, `${locale}.tres`), staticTranslationTres(locale), {
      flag: "wx",
    });
  }

  const authored = await runOwnedNative({
    workspace: path.join(options.root, "fixture-operations"),
    name: "author",
    scriptPath: authorScriptPath,
    timeoutMs: 120_000,
    argumentsFor: (evidencePath) => [sourceDirectory, evidencePath],
  });
  if (authored.report.ok !== true) {
    throw new Error(
      `translation fixture authoring failed: ${String(authored.report.error)} (${authored.evidencePath})`,
    );
  }
  const entries = authored.report.entries as AnyRecord[];
  if (!Array.isArray(entries) || entries.length !== translationFixtureLocales.length) {
    throw new Error(`translation fixture authoring returned an incomplete entry list: ${authored.evidencePath}`);
  }
  const translationBytes = new Map<TranslationFixtureLocale, Buffer>();
  for (const locale of translationFixtureLocales) {
    const entry = entries.find((candidate) => candidate.locale === locale);
    if (entry === undefined) {
      throw new Error(`translation fixture authoring omitted ${locale}: ${authored.evidencePath}`);
    }
    for (const key of translationFixtureKeys) {
      if (entry[key] !== translationFixtureValues[locale][key]) {
        throw new Error(
          `translation fixture authoring did not preserve the literal ${locale}.${key} value: ${authored.evidencePath}`,
        );
      }
    }
    translationBytes.set(
      locale,
      await requireNonemptyFile(
        path.join(sourceDirectory, `${locale}.translation`),
        `authored ${locale} optimized translation`,
      ),
    );
  }

  const importText = makeTranslationFixtureImportText(destinationOrder, destinations);
  const projectText = makeTranslationFixtureProjectText(destinationOrder, destinations);
  const textMembers: { readonly relative: string; readonly bytes: Buffer }[] = [
    { relative: "project.godot", bytes: Buffer.from(projectText, "utf8") },
    {
      relative: "translations.csv.import",
      bytes: Buffer.from(importText, "utf8"),
    },
  ];
  for (const locale of destinationOrder) {
    textMembers.push({
      relative: memberRelative(destinations[locale]),
      bytes: translationBytes.get(locale)!,
    });
  }

  let packagePath: string;
  if (projectConfigKind === "text") {
    packagePath = path.join(options.root, "fixture.pck");
    await writeIndependentPck(packagePath, textMembers);
  } else {
    const textPackagePath = path.join(options.root, "text-fixture.pck");
    await writeIndependentPck(textPackagePath, textMembers);
    const binaryConfig = await authorBinaryProjectConfig(textPackagePath, options.root);
    packagePath = path.join(options.root, "fixture.pck");
    await writeIndependentPck(packagePath, [
      { relative: "project.binary", bytes: binaryConfig },
      ...textMembers.slice(1),
    ]);
  }
  const packageSha256 = await sha256File(packagePath);

  return {
    root: options.root,
    sourceDirectory,
    packagePath,
    importSource: translationFixtureSourceFile,
    importMember: translationFixtureImportMember,
    projectMember: translationFixtureProjectMember,
    projectConfigMember:
      projectConfigKind === "binary" ? "res://project.binary" : translationFixtureProjectMember,
    projectConfigKind,
    destinationOrder,
    locales: translationFixtureLocales,
    defaultLocale: "en",
    keys: translationFixtureKeys,
    values: translationFixtureValues,
    translationMembers: {
      en: destinations.en,
      zh: destinations.zh,
    },
    importText,
    projectText,
    packageSha256,
  };
}

export interface PatchTranslationMappingRequest {
  readonly resource: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Defaults to the operation-owned prepared CSV. */
  readonly csv?: string;
}

export interface RunPatchTransactionOptions {
  readonly fixture: StandaloneTranslationFixture;
  /** Fresh workspace for operation directories; not the operation directory. */
  readonly workspace: string;
  readonly name: string;
  readonly preparedCsvName: string;
  readonly preparedCsvText: string;
  readonly mappings: readonly PatchTranslationMappingRequest[];
  /** Empty or omitted means native new-locales-only omission. */
  readonly locales?: readonly string[];
  readonly output?: string;
  readonly session?: readonly { readonly kind: "multithreading"; readonly disabled: boolean }[];
  readonly preparedCsvPath?: string;
  readonly requestPath?: string;
  readonly reportPath?: string;
  readonly outputDirectory?: string;
  readonly expectedExitCode?: number;
  /** Exact caller-known 64-hex key supplied as one native --key argument. */
  readonly key?: string;
}

export interface PatchTransactionResult {
  readonly operation: string;
  readonly profileRoot: string;
  readonly result: ProcessRunResult;
  readonly requestPath: string;
  readonly reportPath: string;
  readonly preparedCsvPath: string;
  readonly output: string;
  readonly report: AnyRecord;
}

/** Prepare one operation-owned CSV/request and run the fixed native transaction. */
export async function runPatchTransaction(
  options: RunPatchTransactionOptions,
): Promise<PatchTransactionResult> {
  if (!path.isAbsolute(options.workspace)) {
    throw new Error(`patch operation workspace must be absolute: ${options.workspace}`);
  }
  const storage = await OperationStorage.create(options.workspace);
  const requestPath = options.requestPath ?? patchTranslationsRequestPath(storage.paths.operation);
  const reportPath = options.reportPath ?? patchTranslationsReportPath(storage.paths.operation);
  let runResult: OwnedNativeResult;
  try {
    const evidenceDirectory = path.dirname(requestPath);
    await mkdir(evidenceDirectory, { recursive: true });
    const preparedCsvPath =
      options.preparedCsvPath ?? path.join(evidenceDirectory, options.preparedCsvName);
    await writeFile(preparedCsvPath, options.preparedCsvText, { flag: "wx" });
    const output = options.output ?? storage.paths.output;
    const request = {
      version: 1,
      inputs: [options.fixture.packagePath],
      output,
      locales: [...(options.locales ?? [])],
      session: [...(options.session ?? [])],
      translations: options.mappings.map((mapping) => ({
        resource: mapping.resource,
        csv: mapping.csv ?? preparedCsvPath,
        columns: [...mapping.columns],
        rows: mapping.rows.map((row) => [...row]),
      })),
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, "utf8");

    const keyArguments = options.key === undefined ? [] : [`--key=${options.key}`];
    runResult = await runOwnedInStorage(storage, {
      name: options.name,
      scriptPath: translationPatchScriptPath,
      timeoutMs: 180_000,
      evidencePath: reportPath,
      expectedExitCode: options.expectedExitCode ?? 0,
      argumentsFor: () => [requestPath, reportPath, ...keyArguments],
      redactSecrets: options.key === undefined ? undefined : [options.key],
    });
  } finally {
    await storage.closeStreams();
  }
  const requestReport = runResult.report;
  return {
    operation: storage.paths.operation,
    profileRoot: storage.paths.profile,
    result: runResult.result,
    requestPath,
    reportPath,
    preparedCsvPath:
      options.preparedCsvPath ?? path.join(path.dirname(requestPath), options.preparedCsvName),
    output: options.output ?? storage.paths.output,
    report: requestReport,
  };
}

export interface TranslationReadResult {
  readonly operation: string;
  readonly profileRoot: string;
  readonly report: AnyRecord;
  readonly outputs: readonly AnyRecord[];
}

/** Read generated outputs through a fresh owned fixed reader process. */
export async function readTranslationOutputs(options: {
  readonly fixture: StandaloneTranslationFixture;
  readonly workspace: string;
  readonly outputs: readonly string[];
}): Promise<TranslationReadResult> {
  const read = await runOwnedNative({
    workspace: options.workspace,
    name: "read",
    scriptPath: readerScriptPath,
    timeoutMs: 120_000,
    argumentsFor: (evidencePath) => [
      evidencePath,
      options.fixture.packagePath,
      ...options.outputs,
    ],
  });
  if (read.report.ok !== true) {
    throw new Error(
      `translation output read failed: ${String(read.report.error)} (${read.evidencePath})`,
    );
  }
  const outputs = read.report.outputs as AnyRecord[];
  if (!Array.isArray(outputs) || outputs.length !== options.outputs.length) {
    throw new Error(`translation output reader returned an incomplete inventory: ${read.evidencePath}`);
  }
  return {
    operation: read.operation,
    profileRoot: read.profileRoot,
    report: read.report,
    outputs,
  };
}
