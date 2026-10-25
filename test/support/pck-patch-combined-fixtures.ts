import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultProcessRunner, type ProcessRunResult } from "../../src/process.js";
import { prepareNativeOwnershipHelper } from "../../src/process-tree.js";
import { OperationStorage } from "../../src/storage.js";
import { writeIndependentPck } from "./extraction-fixtures.js";
import { createFixtureProfile } from "./extraction-input-fixtures.js";
import {
  authorBinaryProjectConfig,
  defaultTranslationRuntimeExecutable,
  makeTranslationFixtureImportText,
  makeTranslationFixtureProjectText,
} from "./translation-fixtures.js";

/**
 * Independently authored controlled "newer version" combined translation
 * fixture.
 *
 * Source translation values are fixed literals for keys A, B and the newer-version
 * addition C. The two optimized resources start as static `.tres` literals and
 * are converted only by the existing static-tres -> native compatibility-save
 * author route. The PCK is written by the shared independent format-2 writer.
 * Every expected post-patch value below is a literal derived by hand from the
 * source values and the authored CSV, never from native output.
 */

export const combinedFixtureSourceFile = "res://translations.csv";
export const combinedFixtureImportMember = "res://translations.csv.import";
export const combinedFixtureProjectMember = "res://project.godot";

export const combinedFixtureLocales = ["en", "zh"] as const;
export type CombinedFixtureLocale = (typeof combinedFixtureLocales)[number];

export const combinedFixtureKeys = ["A", "B", "C"] as const;
export type CombinedFixtureKey = (typeof combinedFixtureKeys)[number];

/** Newer-version source values: A changed by the CSV, B retained, C newer. */
export const combinedFixtureValues: Readonly<
  Record<CombinedFixtureLocale, Readonly<Record<CombinedFixtureKey, string>>>
> = {
  en: { A: "old", B: "keep", C: "newer-key-en" },
  zh: { A: "旧值", B: "保留", C: "newer-key-zh" },
};

export const combinedFixtureDefaultDestinations: Readonly<
  Record<CombinedFixtureLocale, string>
> = {
  en: "res://.godot/imported/translations.en.translation",
  zh: "res://.godot/imported/translations.zh.translation",
};
export const combinedFixtureDestinationOrder = ["en", "zh"] as const;

/** Unrelated retained member, independent of translation patching. */
export const combinedFixtureUnrelatedMember = "res://data/unrelated.txt";
export const combinedFixtureUnrelatedBytes = Buffer.from(
  "unrelated retained payload: newer-version data\n",
  "utf8",
);

/** Ordinary replacement target in the source package. */
export const combinedFixtureOrdinaryTarget = "res://data/replace.bin";
export const combinedFixtureOrdinaryOriginalBytes = Buffer.from(
  "original ordinary payload v1\n",
  "utf8",
);

/** Host replacement bytes containing NUL, 0x80 and 0xFF. */
export const combinedFixtureReplacementBytes = Buffer.from([
  0x6f, 0x72, 0x64, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x2d, 0x72, 0x65, 0x70,
  0x6c, 0x61, 0x63, 0x65, 0x6d, 0x65, 0x6e, 0x74, 0x3a, 0x20,
  0x00, 0xff, 0x80, 0x01, 0x7f, 0x0a,
  0x62, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x0a,
]);

export const combinedFixtureNewLocale = "ja" as const;
export const combinedFixtureNewLocaleMember =
  "res://.godot/imported/translations.ja.translation";

export interface CombinedFixtureCsv {
  readonly text: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** Explicit en selection: A changes, B is rewritten unchanged, C is omitted. */
export const combinedFixtureExplicitEnCsv: CombinedFixtureCsv = {
  text: "key,en\nA,patched-en-A\nB,keep\n",
  columns: ["key", "en"],
  rows: [
    ["A", "patched-en-A"],
    ["B", "keep"],
  ],
};

/** Omission selection: only the new `ja` column is patched. */
export const combinedFixtureOmittedJaCsv: CombinedFixtureCsv = {
  text: "key,en,zh,ja\nA,source-en-A,源-zh-A,ja-A\nB,keep,保留,ja-B\n",
  columns: ["key", "en", "zh", "ja"],
  rows: [
    ["A", "source-en-A", "源-zh-A", "ja-A"],
    ["B", "keep", "保留", "ja-B"],
  ],
};

export const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Independently known expected post-patch values for the explicit en case. */
export const combinedFixtureExpectedExplicitEn = {
  defaultLocale: "en" as const,
  selectedLocales: ["en"] as const,
  existingLocales: [
    { locale: "en", member: combinedFixtureDefaultDestinations.en },
    { locale: "zh", member: combinedFixtureDefaultDestinations.zh },
  ],
  output: {
    locale: "en",
    member: combinedFixtureDefaultDestinations.en,
    kind: "existing" as const,
    desired: { A: "patched-en-A", B: "keep" } as const,
    expectedValues: ["keep", "newer-key-en", "patched-en-A"],
  },
  retainedLocales: [
    {
      locale: "zh",
      member: combinedFixtureDefaultDestinations.zh,
      expectedValues: ["旧值", "保留", "newer-key-zh"],
    },
  ],
  registration: sortedUnique([
    combinedFixtureDefaultDestinations.en,
    combinedFixtureDefaultDestinations.zh,
  ]),
};

/** Independently known expected post-patch values for the omitted ja case. */
export const combinedFixtureExpectedOmittedJa = {
  defaultLocale: "en" as const,
  selectedLocales: [combinedFixtureNewLocale] as const,
  existingLocales: [
    { locale: "en", member: combinedFixtureDefaultDestinations.en },
    { locale: "zh", member: combinedFixtureDefaultDestinations.zh },
  ],
  output: {
    locale: combinedFixtureNewLocale,
    member: combinedFixtureNewLocaleMember,
    kind: "new" as const,
    desired: { A: "ja-A", B: "ja-B" },
    expectedValues: ["newer-key-en", "ja-A", "ja-B"],
  },
  retainedLocales: [
    {
      locale: "en",
      member: combinedFixtureDefaultDestinations.en,
      expectedValues: ["keep", "newer-key-en", "old"],
    },
    {
      locale: "zh",
      member: combinedFixtureDefaultDestinations.zh,
      expectedValues: ["旧值", "保留", "newer-key-zh"],
    },
  ],
  registration: sortedUnique([
    combinedFixtureDefaultDestinations.en,
    combinedFixtureDefaultDestinations.zh,
    combinedFixtureNewLocaleMember,
  ]),
};

/**
 * Independently authored expectation for a non-first configured default:
 * fallback `zh` copies key C from the zh default resource.
 */
export const combinedFixtureExpectedOmittedJaFromZh = {
  defaultLocale: "zh" as const,
  selectedLocales: [combinedFixtureNewLocale] as const,
  existingLocales: [
    { locale: "en", member: combinedFixtureDefaultDestinations.en },
    { locale: "zh", member: combinedFixtureDefaultDestinations.zh },
  ],
  output: {
    locale: combinedFixtureNewLocale,
    member: combinedFixtureNewLocaleMember,
    kind: "new" as const,
    desired: { A: "ja-A", B: "ja-B" },
    expectedValues: ["newer-key-zh", "ja-A", "ja-B"],
  },
  retainedLocales: [
    {
      locale: "en",
      member: combinedFixtureDefaultDestinations.en,
      expectedValues: ["keep", "newer-key-en", "old"],
    },
    {
      locale: "zh",
      member: combinedFixtureDefaultDestinations.zh,
      expectedValues: ["旧值", "保留", "newer-key-zh"],
    },
  ],
  registration: sortedUnique([
    combinedFixtureDefaultDestinations.en,
    combinedFixtureDefaultDestinations.zh,
    combinedFixtureNewLocaleMember,
  ]),
};

/**
 * Static optimized-translation literals with keys A/B/C. This is fixed fixture
 * data, not a table-generation algorithm.
 */
const staticNewerTranslationTres = (
  locale: CombinedFixtureLocale,
  emptyLocale?: CombinedFixtureLocale,
): string => {
  const localeLine = locale === emptyLocale ? 'locale = ""' : `locale = "${locale}"`;
  if (locale === "en") {
    return [
      '[gd_resource type="OptimizedTranslation" format=3]',
      "",
      "[resource]",
      localeLine,
      "hash_table = PackedInt32Array(0)",
      "bucket_table = PackedInt32Array(3, 1, 16777682, 0, 4, 4, 16777681, 4, 5, 5, 16777680, 9, 13, 13)",
      "strings = PackedByteArray(111, 108, 100, 0, 107, 101, 101, 112, 0, 110, 101, 119, 101, 114, 45, 107, 101, 121, 45, 101, 110, 0)",
      "",
    ].join("\n");
  }
  return [
    '[gd_resource type="OptimizedTranslation" format=3]',
    "",
    "[resource]",
    localeLine,
    "hash_table = PackedInt32Array(0)",
    "bucket_table = PackedInt32Array(3, 1, 16777682, 0, 7, 7, 16777681, 7, 7, 7, 16777680, 14, 13, 13)",
    "strings = PackedByteArray(230, 151, 167, 229, 128, 188, 0, 228, 191, 157, 231, 149, 153, 0, 110, 101, 119, 101, 114, 45, 107, 101, 121, 45, 122, 104, 0)",
    "",
  ].join("\n");
};

export interface CombinedFixtureSourceMember {
  readonly logicalMember: string;
  readonly relative: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

export interface CreateCombinedTranslationFixtureOptions {
  /** Fresh caller-owned fixture root; the helper does not clean it up. */
  readonly root: string;
  /** Override locale destinations for controlled conflict variants. */
  readonly destinations?: Partial<Record<CombinedFixtureLocale, string>>;
  /** Import destination order; defaults to en, zh. */
  readonly destinationOrder?: readonly CombinedFixtureLocale[];
  /** Configured project fallback locale; defaults to en. */
  readonly fallbackLocale?: CombinedFixtureLocale;
  /** Author this locale with an empty resource locale and filename-derived identity. */
  readonly emptyLocale?: CombinedFixtureLocale;
  /** Author text, binary, absent or an unreadable malformed configuration. */
  readonly projectConfig?: "text" | "binary" | "absent" | "malformed";
  /** Project registration override, `null` to omit, or a malformed variant. */
  readonly projectRegistration?: readonly string[] | null | "wrong-type" | "non-string-member";
  /** Import metadata variant: the accepted shape plus listed rejections. */
  readonly importMetadata?: "valid" | "missing" | "duplicate" | "wrong-importer";
}

export interface CombinedTranslationFixture {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly packagePath: string;
  readonly packageSha256: string;
  readonly importSource: string;
  readonly importMember: string;
  readonly projectMember: string;
  readonly projectConfigMember: string;
  readonly projectConfigKind: "text" | "binary" | "absent" | "malformed";
  readonly destinationOrder: readonly CombinedFixtureLocale[];
  readonly locales: readonly CombinedFixtureLocale[];
  readonly defaultLocale: CombinedFixtureLocale;
  readonly keys: readonly CombinedFixtureKey[];
  readonly values: typeof combinedFixtureValues;
  readonly translationMembers: Readonly<Record<CombinedFixtureLocale, string>>;
  readonly sourceMembers: readonly string[];
  readonly members: readonly CombinedFixtureSourceMember[];
  readonly unrelatedMember: string;
  readonly unrelatedBytes: Buffer;
  readonly ordinaryTarget: string;
  readonly ordinaryBytes: Buffer;
  readonly replacementBytes: Buffer;
  readonly importText: string;
  readonly projectText: string;
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
const ownershipHelperPath = path.join(repositoryRoot, "native", "gdre-job-object.ps1");

export const combinedPrepareScriptPath = path.join(
  repositoryRoot,
  "native",
  "gdre-pck-combined-prepare.gd",
);
export const combinedVerifyScriptPath = path.join(
  repositoryRoot,
  "native",
  "gdre-pck-combined-verify.gd",
);

export const combinedFixtureRuntimeExecutable = defaultTranslationRuntimeExecutable;

export const combinedFixtureSha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

let ownershipHelperReady: Promise<unknown> | undefined;

const ensureOwnershipHelper = (): Promise<unknown> =>
  (ownershipHelperReady ??= prepareNativeOwnershipHelper(ownershipHelperPath));

const requireCompleted = (result: ProcessRunResult, label: string): void => {
  if (
    result.exitCode !== 0 ||
    result.cleanup.state !== "confirmed" ||
    !result.stdout.complete ||
    !result.stderr.complete ||
    result.error !== null ||
    result.captureError !== null ||
    result.storageError !== null
  ) {
    throw new Error(
      [
        `${label} did not complete as expected`,
        `exit code: ${String(result.exitCode)}`,
        `cleanup: ${result.cleanup.state}`,
        `stdout complete: ${String(result.stdout.complete)}`,
        `stderr complete: ${String(result.stderr.complete)}`,
        result.error === null ? "" : `process error: ${result.error}`,
        result.captureError === null ? "" : `capture error: ${result.captureError}`,
        result.storageError === null ? "" : `storage error: ${result.storageError}`,
        result.stdoutText === "" ? "" : `stdout tail: ${result.stdoutText.slice(-2_000)}`,
        result.stderrText === "" ? "" : `stderr tail: ${result.stderrText.slice(-2_000)}`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }
};

/** Author the static `.tres` literals through the existing native save route. */
async function authorNewerTranslations(
  sourceDirectory: string,
  fixtureRoot: string,
  emptyLocale?: CombinedFixtureLocale,
): Promise<Map<CombinedFixtureLocale, Buffer>> {
  await mkdir(sourceDirectory, { recursive: true });
  for (const locale of combinedFixtureLocales) {
    await writeFile(
      path.join(sourceDirectory, `${locale}.tres`),
      staticNewerTranslationTres(locale, emptyLocale),
      { flag: "wx" },
    );
  }

  await ensureOwnershipHelper();
  const storage = await OperationStorage.create(path.join(fixtureRoot, "author-operations"));
  try {
    const profile = await createFixtureProfile(storage.paths.profile, "author");
    const evidencePath = path.join(storage.paths.operation, "author-report.json");
    const result = await defaultProcessRunner.run({
      executable: combinedFixtureRuntimeExecutable,
      argv: [
        "--headless",
        "--script",
        authorScriptPath,
        "--",
        sourceDirectory.replaceAll("\\", "/"),
        evidencePath.replaceAll("\\", "/"),
      ],
      cwd: profile.cwd,
      env: profile.env,
      timeoutMs: 120_000,
      streamPaths: {
        stdoutBin: storage.paths.stdoutBin,
        stdoutText: storage.paths.stdoutText,
        stderrBin: storage.paths.stderrBin,
        stderrText: storage.paths.stderrText,
      },
      statusPath: path.join(storage.paths.operation, "ownership-author.json"),
      helperScriptPath: ownershipHelperPath,
    });
    requireCompleted(result, "combined translation fixture author");
    const report = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, any>;
    if (report.ok !== true) {
      throw new Error(
        `combined translation fixture authoring failed: ${String(report.error)} (${evidencePath})`,
      );
    }
    const entries = report.entries as Record<string, any>[];
    if (!Array.isArray(entries) || entries.length !== combinedFixtureLocales.length) {
      throw new Error(
        `combined translation fixture authoring returned an incomplete entry list: ${evidencePath}`,
      );
    }
    const bytes = new Map<CombinedFixtureLocale, Buffer>();
    for (const locale of combinedFixtureLocales) {
      const entry = entries.find((candidate) => candidate.locale === locale);
      if (entry === undefined) {
        throw new Error(`combined translation fixture authoring omitted ${locale}`);
      }
      for (const key of ["A", "B"] as const) {
        if (entry[key] !== combinedFixtureValues[locale][key]) {
          throw new Error(
            `combined translation fixture authoring did not preserve ${locale}.${key}`,
          );
        }
      }
      bytes.set(
        locale,
        await readFile(path.join(sourceDirectory, `${locale}.translation`)),
      );
    }
    return bytes;
  } finally {
    await storage.closeStreams();
  }
}

const memberRelative = (member: string): string => {
  if (!member.startsWith("res://")) {
    throw new Error(`combined fixture member is not a res:// identity: ${member}`);
  }
  return member.slice("res://".length);
};

/** Build one controlled newer-version source package. */
export async function createCombinedTranslationFixture(
  options: CreateCombinedTranslationFixtureOptions,
): Promise<CombinedTranslationFixture> {
  if (!path.isAbsolute(options.root)) {
    throw new Error(`combined fixture root must be absolute: ${options.root}`);
  }
  const destinations = {
    ...combinedFixtureDefaultDestinations,
    ...options.destinations,
  };
  const destinationOrder = [...(options.destinationOrder ?? combinedFixtureDestinationOrder)];
  if (
    destinationOrder.length !== combinedFixtureDestinationOrder.length ||
    new Set(destinationOrder).size !== combinedFixtureDestinationOrder.length ||
    !combinedFixtureDestinationOrder.every((locale) => destinationOrder.includes(locale))
  ) {
    throw new Error("combined fixture destination order must list each locale exactly once");
  }
  const importMetadata = options.importMetadata ?? "valid";
  const projectConfigKind = options.projectConfig ?? "text";
  if (
    projectConfigKind !== "text" &&
    projectConfigKind !== "binary" &&
    projectConfigKind !== "absent" &&
    projectConfigKind !== "malformed"
  ) {
    throw new Error(`unsupported combined fixture project config kind: ${String(projectConfigKind)}`);
  }

  await mkdir(options.root, { recursive: true });
  const sourceDirectory = path.join(options.root, "source");
  const translationBytes = await authorNewerTranslations(
    sourceDirectory,
    options.root,
    options.emptyLocale,
  );

  const importText = makeTranslationFixtureImportText(destinationOrder, {
    en: destinations.en,
    zh: destinations.zh,
  });
  const projectText =
    projectConfigKind === "malformed"
      ? "config_version=5\n[internationalization\nlocale/fallback=\"en\"\n"
      : makeTranslationFixtureProjectText(destinationOrder, {
          en: destinations.en,
          zh: destinations.zh,
        }, {
          fallback: options.fallbackLocale,
          registration: options.projectRegistration,
        });

  const members: { relative: string; bytes: Buffer }[] = [];
  if (projectConfigKind !== "absent") {
    members.push({
      relative: memberRelative(combinedFixtureProjectMember),
      bytes: Buffer.from(projectText, "utf8"),
    });
  }
  let effectiveImportText = importText;
  if (importMetadata === "valid") {
    members.push({
      relative: memberRelative(combinedFixtureImportMember),
      bytes: Buffer.from(importText, "utf8"),
    });
  } else if (importMetadata === "duplicate") {
    members.push({
      relative: memberRelative(combinedFixtureImportMember),
      bytes: Buffer.from(importText, "utf8"),
    });
    // The native source identity comes from the .import path, so a second
    // case-folded .import identity is the representable duplicate variant.
    members.push({
      relative: "TRANSLATIONS.CSV.import",
      bytes: Buffer.from(importText, "utf8"),
    });
  } else if (importMetadata === "wrong-importer") {
    effectiveImportText = [
      "[remap]",
      'importer="binary_translation"',
      'type="Translation"',
      "",
      "[deps]",
      `source_file="${combinedFixtureSourceFile}"`,
      `dest_files=["${destinations.en}", "${destinations.zh}"]`,
      "",
      "[params]",
      "compress=true",
      "delimiter=0",
      "",
    ].join("\n");
    members.push({
      relative: memberRelative(combinedFixtureImportMember),
      bytes: Buffer.from(effectiveImportText, "utf8"),
    });
  }

  for (const locale of destinationOrder) {
    members.push({
      relative: memberRelative(destinations[locale]),
      bytes: translationBytes.get(locale)!,
    });
  }
  members.push({
    relative: memberRelative(combinedFixtureUnrelatedMember),
    bytes: Buffer.from(combinedFixtureUnrelatedBytes),
  });
  members.push({
    relative: memberRelative(combinedFixtureOrdinaryTarget),
    bytes: Buffer.from(combinedFixtureOrdinaryOriginalBytes),
  });

  const packagePath = path.join(options.root, "newer-source.pck");
  if (projectConfigKind === "binary") {
    const textPackagePath = path.join(options.root, "text-source.pck");
    await writeIndependentPck(textPackagePath, members);
    const binaryConfig = await authorBinaryProjectConfig(textPackagePath, options.root);
    members[0] = { relative: "project.binary", bytes: binaryConfig };
  }
  await writeIndependentPck(packagePath, members);

  const typedMembers: CombinedFixtureSourceMember[] = members.map((member) => ({
    logicalMember: `res://${member.relative}`,
    relative: member.relative,
    bytes: member.bytes,
    size: member.bytes.byteLength,
    sha256: combinedFixtureSha256(member.bytes),
  }));

  const projectConfigMember =
    projectConfigKind === "binary"
      ? "res://project.binary"
      : projectConfigKind === "absent"
        ? ""
        : combinedFixtureProjectMember;

  return {
    root: options.root,
    sourceDirectory,
    packagePath,
    packageSha256: combinedFixtureSha256(await readFile(packagePath)),
    importSource: combinedFixtureSourceFile,
    importMember: combinedFixtureImportMember,
    projectMember: combinedFixtureProjectMember,
    projectConfigMember,
    projectConfigKind,
    destinationOrder,
    locales: combinedFixtureLocales,
    defaultLocale: options.fallbackLocale ?? "en",
    keys: combinedFixtureKeys,
    values: combinedFixtureValues,
    translationMembers: {
      en: destinations.en,
      zh: destinations.zh,
    },
    sourceMembers: typedMembers.map((member) => member.logicalMember),
    members: typedMembers,
    unrelatedMember: combinedFixtureUnrelatedMember,
    unrelatedBytes: combinedFixtureUnrelatedBytes,
    ordinaryTarget: combinedFixtureOrdinaryTarget,
    ordinaryBytes: combinedFixtureOrdinaryOriginalBytes,
    replacementBytes: combinedFixtureReplacementBytes,
    importText: effectiveImportText,
    projectText,
  };
}

// --- owned fixed-native execution ------------------------------------------

export interface CombinedNativeRun {
  readonly operation: string;
  readonly profileRoot: string;
  readonly result: ProcessRunResult;
  readonly requestPath: string;
  readonly reportPath: string;
  readonly report: Record<string, any>;
}

/**
 * Write one strict request and run a fixed combined script through the existing
 * owned ProcessRunner, OperationStorage evidence and a fresh operation profile.
 */
export async function runCombinedNative(options: {
  readonly workspace: string;
  readonly name: string;
  readonly scriptPath: string;
  readonly request: unknown;
  readonly timeoutMs?: number;
  readonly expectedExitCode?: number;
}): Promise<CombinedNativeRun> {
  if (!path.isAbsolute(options.workspace)) {
    throw new Error(`combined native workspace must be absolute: ${options.workspace}`);
  }
  await ensureOwnershipHelper();
  const storage = await OperationStorage.create(options.workspace);
  try {
    const requestPath = path.join(storage.paths.operation, `${options.name}-request.json`);
    const reportPath = path.join(storage.paths.operation, `${options.name}-report.json`);
    await writeFile(requestPath, `${JSON.stringify(options.request)}\n`, "utf8");
    const profile = await createFixtureProfile(storage.paths.profile, options.name);
    const expectedExitCode = options.expectedExitCode ?? 0;
    const result = await defaultProcessRunner.run({
      executable: combinedFixtureRuntimeExecutable,
      argv: [
        "--headless",
        "--script",
        options.scriptPath,
        "--",
        requestPath.replaceAll("\\", "/"),
        reportPath.replaceAll("\\", "/"),
      ],
      cwd: profile.cwd,
      env: profile.env,
      timeoutMs: options.timeoutMs ?? 180_000,
      streamPaths: {
        stdoutBin: storage.paths.stdoutBin,
        stdoutText: storage.paths.stdoutText,
        stderrBin: storage.paths.stderrBin,
        stderrText: storage.paths.stderrText,
      },
      statusPath: path.join(storage.paths.operation, "ownership.json"),
      helperScriptPath: ownershipHelperPath,
    });
    requireCompleted(result, `fixed combined script ${options.name}`);
    if (result.exitCode !== expectedExitCode) {
      throw new Error(
        `fixed combined script ${options.name} exited ${String(result.exitCode)}; ` +
          `expected ${String(expectedExitCode)}; stderr tail: ${result.stderrText.slice(-2_000)}`,
      );
    }
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, any>;
    return {
      operation: storage.paths.operation,
      profileRoot: storage.paths.profile,
      result,
      requestPath,
      reportPath,
      report,
    };
  } finally {
    await storage.closeStreams();
  }
}
