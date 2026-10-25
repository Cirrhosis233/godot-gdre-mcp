import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeIndependentPck } from "./extraction-fixtures.js";
import { createFixtureProfile } from "./extraction-input-fixtures.js";

/**
 * Independently authored selected-export fixture.
 *
 * Translation source resources and the expected CSV/script text are authored
 * here; the vendored runtime is used only to compile `main.gd` and to convert
 * the authored nonoptimized Translation resources to binary resources. No
 * expected value is read back from runtime recovery output.
 */

export const exportFixtureProjectText = [
  "; Engine configuration file.",
  "config_version=5",
  "",
  "[application]",
  'config/name="Controlled export fixture"',
  "",
  "[internationalization]",
  'locale/fallback="en"',
  "",
].join("\n");

/**
 * Harmless authored script. The vendored compiler only compiles it; neither
 * this fixture helper nor the fixture ever executes it.
 */
export const exportFixtureScriptText = [
  "extends RefCounted",
  "",
  "func answer() -> int:",
  "\treturn 42",
  "",
  "func label() -> String:",
  '\treturn "controlled script"',
  "",
].join("\n");

/** Expected decompiled script text, authored independently of recovery output. */
export const exportFixtureExpectedScriptText = exportFixtureScriptText;

export const exportFixtureTranslationLocales = ["en", "zh"] as const;
export type ExportFixtureTranslationLocale = (typeof exportFixtureTranslationLocales)[number];

export interface ExportFixtureTranslationRow {
  readonly key: string;
  readonly en: string;
  readonly zh: string;
}

/** Known keys include Unicode, a comma and an embedded newline. */
export const exportFixtureTranslationRows: readonly ExportFixtureTranslationRow[] = [
  { key: "HELLO", en: "Hello", zh: "你好" },
  { key: "GREETING", en: "Hello, friend", zh: "你好，朋友" },
  { key: "UNICODE", en: "你好，世界", zh: "中文内容" },
  { key: "MULTILINE", en: "Line one\nLine two", zh: "第一行\n第二行" },
];

/**
 * Exact CSV expected from selected translation export, including the UTF-8
 * BOM and LF line endings.
 */
export const exportFixtureTranslationCsvText =
  "﻿key,en,zh\n" +
  "HELLO,Hello,你好\n" +
  'GREETING,"Hello, friend",你好，朋友\n' +
  "UNICODE,你好，世界,中文内容\n" +
  'MULTILINE,"Line one\nLine two","第一行\n第二行"\n';

export const exportFixtureTranslationImportText = [
  "[remap]",
  "",
  'importer="csv_translation"',
  'type="Translation"',
  "",
  "[deps]",
  "",
  'source_file="res://translations.csv"',
  'dest_files=["res://.godot/imported/translations.en.translation", "res://.godot/imported/translations.zh.translation"]',
  "",
  "[params]",
  "",
  "compress=true",
  "delimiter=0",
  "",
].join("\n");

export const exportFixtureScriptRemapText = '[remap]\n\npath="res://main.gdc"\n';

export const exportFixtureRawOnlyText = "Raw-only export fixture member.\n";

const failedImportText = [
  "[remap]",
  "",
  'importer="texture"',
  'type="CompressedTexture2D"',
  'path="res://.godot/imported/broken.png-def.ctex"',
  "",
  "[deps]",
  "",
  'source_file="res://broken.png"',
  'dest_files=["res://.godot/imported/broken.png-def.ctex"]',
  "",
  "[params]",
  "",
  "compress/mode=0",
  "",
].join("\n");

const unsupportedImportText = [
  "[remap]",
  "",
  'importer="unknown_importer"',
  'type="Resource"',
  'path="res://.godot/imported/weird.dat-abc.dat"',
  "",
  "[deps]",
  "",
  'source_file="res://weird.dat"',
  'dest_files=["res://.godot/imported/weird.dat-abc.dat"]',
  "",
].join("\n");

export type ExportFixtureMemberRole =
  | "project"
  | "raw-only"
  | "script-bytecode"
  | "script-remap"
  | "translation-import"
  | "translation-binary"
  | "failed-import"
  | "failed-binary"
  | "unsupported-source"
  | "unsupported-import"
  | "unsupported-binary";

/** Complete runtime-visible member inventory, authored or generated at setup. */
export interface ExportFixtureMember {
  /** Complete runtime-visible member name. */
  readonly name: string;
  /** Destination-relative path with forward slashes. */
  readonly relative: string;
  readonly role: ExportFixtureMemberRole;
}

export interface ExportFixtureScriptExpectation {
  readonly sourceText: string;
  readonly expectedText: string;
  readonly bytecodeMember: "res://main.gdc";
  readonly remapMember: "res://main.gd.remap";
  /** Destination-relative decompiled script path. */
  readonly expectedRelative: "main.gd";
}

export interface ExportFixtureTranslationExpectation {
  readonly locales: readonly ExportFixtureTranslationLocale[];
  readonly rows: readonly ExportFixtureTranslationRow[];
  readonly csvText: string;
  readonly sourceFile: "res://translations.csv";
  readonly importMember: "res://translations.csv.import";
  readonly binaryMembers: readonly string[];
  /** Destination-relative CSV path. */
  readonly expectedRelative: "translations.csv";
}

export interface ExportSelectedImportVariant {
  readonly importMember: string;
  /**
   * Exported/selected member. Native selection intersects `dest_files`, not the
   * source path, so tests select this member.
   */
  readonly selectedMember: string;
}

export interface ExportFixtureVariants {
  /** Valid metadata with an invalid binary destination; native reports failed. */
  readonly failed: ExportSelectedImportVariant;
  /**
   * Valid metadata naming an unknown importer with a present destination.
   * Selecting that destination produces native not_converted/unsupported_types.
   */
  readonly unsupported: ExportSelectedImportVariant & { readonly sourceMember: string };
}

export interface ExportFixture {
  readonly root: string;
  /** Real directory usable for directory-group and directory-input tests. */
  readonly sourceDirectory: string;
  /** Unencrypted format-2 PCK with engine version 4.4.0. */
  readonly packagePath: string;
  readonly projectText: string;
  readonly script: ExportFixtureScriptExpectation;
  /** Null when translations are omitted to exercise a no-group-match fixture. */
  readonly translation: ExportFixtureTranslationExpectation | null;
  readonly rawOnly: {
    readonly member: "res://notes.txt";
    readonly relative: "notes.txt";
    readonly text: string;
  };
  readonly variants: ExportFixtureVariants | null;
  readonly members: readonly ExportFixtureMember[];
}

export interface CreateExportFixtureOptions {
  /** Fresh fixture root owned by the caller; the helper does not clean it up. */
  readonly root: string;
  /** Absolute path to the provisioned vendored `gdre_tools.exe`. */
  readonly runtimeExecutable: string;
  /** Author the selected-import variants used for failed/unsupported checks. */
  readonly includeFailureVariants?: boolean;
  /** Omit translations so a `translations` group selection matches nothing. */
  readonly includeTranslations?: boolean;
}

const setupTimeoutMs = 30_000;
const maxSetupOutputBytes = 4 * 1024 * 1024;

interface SetupProfile {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface SetupCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const nativePath = (value: string): string => value.replaceAll("\\", "/");

const quoteGodotString = (value: string): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Godot string encoding failed");
  return encoded;
};

const translationResourceText = (
  locale: ExportFixtureTranslationLocale,
  rows: readonly ExportFixtureTranslationRow[],
): string => [
  '[gd_resource type="Translation" format=3]',
  "",
  "[resource]",
  `locale = ${quoteGodotString(locale)}`,
  "messages = {",
  rows.map((row) => `${quoteGodotString(row.key)}: ${quoteGodotString(row[locale])}`).join(",\n"),
  "}",
  "",
].join("\n");

const outputTail = (text: string): string => text.length <= 2_000 ? text : `...${text.slice(-2_000)}`;

/**
 * Fixture setup only: invoke one bounded, shell-free native compiler/converter
 * command in its own isolated profile. This is not a production adapter.
 */
function runSetupCommand(
  label: string,
  executable: string,
  args: readonly string[],
  profile: SetupProfile,
): Promise<SetupCommandResult> {
  const options: ExecFileOptionsWithStringEncoding = {
    cwd: profile.cwd,
    env: profile.env,
    timeout: setupTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: maxSetupOutputBytes,
    encoding: "utf8",
    windowsHide: true,
  };
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr });
        return;
      }
      const timedOut = error.killed === true;
      const diagnostics = [
        `Export fixture setup command failed: ${label}`,
        `executable: ${executable}`,
        `args: ${JSON.stringify(args)}`,
        `cwd: ${profile.cwd}`,
        timedOut
          ? `timed out after ${String(setupTimeoutMs)} ms`
          : `exit code: ${String(error.code)}; signal: ${String(error.signal)}`,
        stdout === "" ? "" : `stdout tail: ${outputTail(stdout)}`,
        stderr === "" ? "" : `stderr tail: ${outputTail(stderr)}`,
      ].filter((line) => line !== "");
      reject(new Error(diagnostics.join("\n")));
    });
  });
}

async function requireNonemptyFile(file: string, label: string): Promise<Buffer> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile() || info.size === 0) {
    throw new Error(`Export fixture is missing nonempty ${label}: ${file}`);
  }
  return readFile(file);
}

async function requireResourceHeader(file: string, header: string, label: string): Promise<Buffer> {
  const bytes = await requireNonemptyFile(file, label);
  if (bytes.subarray(0, header.length).toString("latin1") !== header) {
    throw new Error(`Export fixture ${label} does not start with ${header}: ${file}`);
  }
  return bytes;
}

/**
 * Author a reusable selected-export fixture.
 *
 * Native setup commands (compile and text-to-binary conversion) run with a
 * shell-free argv, a fresh profile/CWD and every profile path redirected. The
 * source project is authored but never loaded or executed by the helper.
 * The package is written independently with `writeIndependentPck`; no runtime
 * package creation is involved.
 */
export async function createExportFixture(options: CreateExportFixtureOptions): Promise<ExportFixture> {
  if (!path.isAbsolute(options.root)) throw new Error(`Export fixture root must be absolute: ${options.root}`);
  if (!path.isAbsolute(options.runtimeExecutable)) {
    throw new Error(`Export fixture runtime executable must be absolute: ${options.runtimeExecutable}`);
  }
  const runtimeInfo = await stat(options.runtimeExecutable).catch(() => null);
  if (runtimeInfo === null || !runtimeInfo.isFile()) {
    throw new Error(`Export fixture runtime executable is not a file: ${options.runtimeExecutable}`);
  }

  const includeTranslations = options.includeTranslations ?? true;
  const includeFailureVariants = options.includeFailureVariants ?? false;
  const sourceDirectory = path.join(options.root, "project");
  const importedDirectory = path.join(sourceDirectory, ".godot", "imported");
  const setupDirectory = path.join(options.root, "setup");
  const packagePath = path.join(options.root, "fixture.pck");

  await mkdir(importedDirectory, { recursive: true });
  await mkdir(setupDirectory, { recursive: true });

  await writeFile(path.join(sourceDirectory, "project.godot"), exportFixtureProjectText, { flag: "wx" });
  await writeFile(path.join(sourceDirectory, "notes.txt"), exportFixtureRawOnlyText, { flag: "wx" });

  const scriptSource = path.join(setupDirectory, "main.gd");
  await writeFile(scriptSource, exportFixtureScriptText, { flag: "wx" });
  const compileProfile = await createFixtureProfile(options.root, "compile");
  await runSetupCommand(
    "compile main.gd",
    options.runtimeExecutable,
    [
      "--headless",
      "--no-header",
      "--",
      `--compile=${nativePath(scriptSource)}`,
      "--bytecode=4.4.0",
      `--output=${nativePath(sourceDirectory)}`,
    ],
    compileProfile,
  );
  await requireResourceHeader(path.join(sourceDirectory, "main.gdc"), "GDSC", "compiled script");

  if (includeTranslations) {
    const translationSources = exportFixtureTranslationLocales.map((locale) => {
      const source = path.join(setupDirectory, `translations.${locale}.tres`);
      return { locale, source };
    });
    for (const { locale, source } of translationSources) {
      await writeFile(source, translationResourceText(locale, exportFixtureTranslationRows), { flag: "wx" });
    }
    const convertProfile = await createFixtureProfile(options.root, "convert");
    await runSetupCommand(
      "convert translations",
      options.runtimeExecutable,
      [
        "--headless",
        "--no-header",
        "--",
        ...translationSources.map(({ source }) => `--txt-to-bin=${nativePath(source)}`),
        `--output=${nativePath(importedDirectory)}`,
      ],
      convertProfile,
    );
    for (const locale of exportFixtureTranslationLocales) {
      const converted = path.join(importedDirectory, `translations.${locale}.res`);
      await requireNonemptyFile(converted, `${locale} converted translation`);
      await rename(converted, path.join(importedDirectory, `translations.${locale}.translation`));
      await requireResourceHeader(
        path.join(importedDirectory, `translations.${locale}.translation`),
        "RSRC",
        `${locale} translation resource`,
      );
    }
    await writeFile(
      path.join(sourceDirectory, "translations.csv.import"),
      exportFixtureTranslationImportText,
      { flag: "wx" },
    );
  }

  await writeFile(path.join(sourceDirectory, "main.gd.remap"), exportFixtureScriptRemapText, { flag: "wx" });

  if (includeFailureVariants) {
    await writeFile(path.join(importedDirectory, "broken.png-def.ctex"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]), { flag: "wx" });
    await writeFile(path.join(sourceDirectory, "broken.png.import"), failedImportText, { flag: "wx" });
    await writeFile(path.join(sourceDirectory, "weird.dat"), "unknown payload\n", { flag: "wx" });
    await writeFile(path.join(sourceDirectory, "weird.dat.import"), unsupportedImportText, { flag: "wx" });
    await writeFile(path.join(importedDirectory, "weird.dat-abc.dat"), "dest payload\n", { flag: "wx" });
  }

  const members: ExportFixtureMember[] = [];
  const packageMembers: { readonly relative: string; readonly bytes: Buffer }[] = [];
  const addMember = async (relative: string, role: ExportFixtureMemberRole): Promise<void> => {
    const file = path.join(sourceDirectory, ...relative.split("/"));
    const bytes = await requireNonemptyFile(file, `${role} fixture member`);
    members.push({ name: `res://${relative}`, relative, role });
    packageMembers.push({ relative, bytes });
  };

  await addMember("project.godot", "project");
  await addMember("notes.txt", "raw-only");
  await addMember("main.gdc", "script-bytecode");
  await addMember("main.gd.remap", "script-remap");
  if (includeTranslations) {
    await addMember("translations.csv.import", "translation-import");
    for (const locale of exportFixtureTranslationLocales) {
      await addMember(`.godot/imported/translations.${locale}.translation`, "translation-binary");
    }
  }
  if (includeFailureVariants) {
    await addMember("broken.png.import", "failed-import");
    await addMember(".godot/imported/broken.png-def.ctex", "failed-binary");
    await addMember("weird.dat", "unsupported-source");
    await addMember("weird.dat.import", "unsupported-import");
    await addMember(".godot/imported/weird.dat-abc.dat", "unsupported-binary");
  }

  await writeIndependentPck(packagePath, packageMembers);

  return {
    root: options.root,
    sourceDirectory,
    packagePath,
    projectText: exportFixtureProjectText,
    script: {
      sourceText: exportFixtureScriptText,
      expectedText: exportFixtureExpectedScriptText,
      bytecodeMember: "res://main.gdc",
      remapMember: "res://main.gd.remap",
      expectedRelative: "main.gd",
    },
    translation: includeTranslations
      ? {
          locales: exportFixtureTranslationLocales,
          rows: exportFixtureTranslationRows,
          csvText: exportFixtureTranslationCsvText,
          sourceFile: "res://translations.csv",
          importMember: "res://translations.csv.import",
          binaryMembers: exportFixtureTranslationLocales.map(
            (locale) => `res://.godot/imported/translations.${locale}.translation`,
          ),
          expectedRelative: "translations.csv",
        }
      : null,
    rawOnly: {
      member: "res://notes.txt",
      relative: "notes.txt",
      text: exportFixtureRawOnlyText,
    },
    variants: includeFailureVariants
      ? {
          failed: {
            importMember: "res://broken.png.import",
            selectedMember: "res://.godot/imported/broken.png-def.ctex",
          },
          unsupported: {
            importMember: "res://weird.dat.import",
            selectedMember: "res://.godot/imported/weird.dat-abc.dat",
            sourceMember: "res://weird.dat",
          },
        }
      : null,
    members,
  };
}
