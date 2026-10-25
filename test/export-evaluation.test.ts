import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ArtifactEntry, ArtifactInventory } from "../src/artifacts.js";
import { evaluateExport } from "../src/export-evaluation.js";
import { joinPath, pathIdentity } from "../src/paths.js";
import type {
  ExportEvaluationContext,
  ExportImportMetadata,
  ExportSemanticData,
  ProcessObservation,
} from "../src/types.js";

const translationImport: ExportImportMetadata = {
  path: "res://.godot/imported/translations.en.translation",
  importMdPath: "res://translations.csv.import",
  sourceFile: "res://translations.csv",
  importer: "csv_translation",
  type: "Translation",
  destFiles: [
    "res://.godot/imported/translations.en.translation",
    "res://.godot/imported/translations.zh.translation",
  ],
};

const scriptImport: ExportImportMetadata = {
  path: "res://main.gdc",
  importMdPath: "res://main.gd.remap",
  sourceFile: "res://main.gd",
  importer: "script_bytecode",
  type: "GDScript",
  destFiles: ["res://main.gdc"],
};

const meshImport: ExportImportMetadata = {
  path: "res://.godot/imported/mesh.bin-abc.bin",
  importMdPath: "res://mesh.bin.import",
  sourceFile: "res://mesh.bin",
  importer: "mesh",
  type: "ArrayMesh",
  destFiles: ["res://.godot/imported/mesh.bin-abc.bin"],
};

const completeMembers = [
  "res://project.godot",
  "res://translations.csv",
  "res://translations.csv.import",
  "res://.godot/imported/translations.en.translation",
  "res://.godot/imported/translations.zh.translation",
  "res://main.gdc",
  "res://main.gd.remap",
  "res://.godot/imported/mesh.bin-abc.bin",
  "res://mesh.bin.import",
] as const;

const selectedAll = [
  "res://.godot/imported/translations.en.translation",
  "res://.godot/imported/translations.zh.translation",
  "res://main.gdc",
] as const;

const hash = (char: string): string => char.repeat(64);

const fileEntry = (file: string, char = "a", role = "output"): ArtifactEntry => ({
  path: file,
  role,
  kind: "file",
  bytes: 16,
  sha256: hash(char),
  error: null,
});

const inventory = (
  entries: readonly ArtifactEntry[],
  overrides: Partial<ArtifactInventory> = {},
): ArtifactInventory => ({
  entries,
  errors: [],
  complete: true,
  stopReason: null,
  ...overrides,
});

interface Fixture {
  readonly root: string;
  readonly output: string;
  readonly reportPath: string;
  readonly logPath: string;
  readonly baseEntries: readonly ArtifactEntry[];
}

const fixture = async (label: string): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `gdre-mcp-export-eval-${label}-`));
  const output = joinPath(root, "out");
  await mkdir(output, { recursive: true });
  return {
    root,
    output,
    reportPath: joinPath(output, "gdre_export.json"),
    logPath: joinPath(output, "gdre_export.log"),
    baseEntries: [],
  };
};

const successEntry = (
  importInfo: ExportImportMetadata,
  exporter: string,
  savedPath: string | undefined,
  extra: Record<string, unknown> = {},
) => {
  const entry: Record<string, unknown> = {
    import_info: {
      iitype: 2,
      import_md_path: importInfo.importMdPath,
      ver_major: 4,
      ver_minor: 4,
      preferred_import_path: importInfo.path,
      src_md5: "0123456789abcdef0123456789abcdef",
      cf: "ignored native serialized metadata; never parsed",
    },
    exporter,
  };
  if (savedPath !== undefined) entry["saved_path"] = savedPath;
  if (extra["resources_used"] === undefined) {
    entry["resources_used"] = [...importInfo.destFiles];
  }
  return { ...entry, ...extra };
};

const notConvertedEntry = (
  importInfo: ExportImportMetadata,
  exporter: string,
  error: number,
  unsupportedFormatType?: string,
) => ({
  import_info: {
    iitype: 2,
    import_md_path: importInfo.importMdPath,
    ver_major: 4,
    ver_minor: 4,
    preferred_import_path: importInfo.path,
    src_md5: "0123456789abcdef0123456789abcdef",
    cf: "ignored",
  },
  exporter,
  error,
  ...(unsupportedFormatType === undefined
    ? {}
    : { unsupported_format_type: unsupportedFormatType }),
});

const failedEntry = (
  importInfo: ExportImportMetadata,
  exporter: string,
  error: number,
  message: string,
) => ({
  import_info: {
    iitype: 2,
    import_md_path: importInfo.importMdPath,
    ver_major: 4,
    ver_minor: 4,
    preferred_import_path: importInfo.path,
    src_md5: "0123456789abcdef0123456789abcdef",
    cf: "ignored",
  },
  exporter,
  error,
  message,
});

interface ReportOptions {
  readonly success?: readonly unknown[];
  readonly failed?: readonly unknown[];
  readonly notConverted?: readonly unknown[];
  readonly translationMessage?: string;
  readonly hadEncryptionError?: boolean;
  readonly failedScripts?: readonly string[];
  readonly sessionFilesTotal?: number;
}

const report = (
  view: Fixture,
  options: ReportOptions = {},
  provenance: { readonly output: string; readonly log: string } = {
    output: view.output,
    log: view.logPath,
  },
) => {
  const success = options.success ?? [];
  const failed = options.failed ?? [];
  const notConverted = options.notConverted ?? [];
  return {
    report_version: 1,
    gdre_version: "v2.8.0-beta.2",
    game_name: "controlled export fixture",
    output_dir: provenance.output,
    ver: "4.4.0",
    had_encryption_error: options.hadEncryptionError ?? false,
    godotsteam_detected: false,
    mono_detected: false,
    custom_version_detected: false,
    exported_scenes: false,
    show_headless_warning: false,
    uses_double_precision: false,
    session_files_total:
      options.sessionFilesTotal ?? success.length + failed.length + notConverted.length,
    log_file_location: provenance.log,
    decompiled_scripts: ["res://main.gdc"],
    failed_scripts: [...(options.failedScripts ?? [])],
    translation_export_message: options.translationMessage ?? "",
    failed: [...failed],
    success: [...success],
    not_converted: [...notConverted],
    failed_plugin_cfg_create: [],
    failed_gdnative_copy: [],
    unsupported_types: [],
    downloaded_plugins: [],
  };
};

const baseObservation = (): ProcessObservation => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutEvidence: {
    rawPath: "D:/fixtures/.gdre/operations/op/stdout.bin",
    textPath: "D:/fixtures/.gdre/operations/op/stdout.txt",
    complete: true,
    utf8Valid: true,
  },
  stderrEvidence: {
    rawPath: "D:/fixtures/.gdre/operations/op/stderr.bin",
    textPath: "D:/fixtures/.gdre/operations/op/stderr.txt",
    complete: true,
    utf8Valid: true,
  },
});

interface RunOptions {
  readonly selectedMembers?: readonly string[];
  readonly imports?: readonly ExportImportMetadata[];
  readonly reportOptions?: ReportOptions;
  readonly entries?: readonly ArtifactEntry[];
  readonly observation?: Partial<ProcessObservation>;
  readonly reportText?: string;
  readonly omitReportEntry?: boolean;
  readonly omitLogEntry?: boolean;
  readonly dumpResourceStrings?: boolean;
  readonly displayOutput?: string;
  readonly realOutput?: string;
}

const run = async (view: Fixture, options: RunOptions = {}) => {
  const selectedMembers = options.selectedMembers ?? selectedAll;
  const imports = options.imports ?? [translationImport, scriptImport];
  const displayOutput = options.displayOutput ?? view.output;
  const realOutput = options.realOutput ?? view.output;
  const displayLogPath = joinPath(displayOutput, "gdre_export.log");
  const realReportPath = joinPath(realOutput, "gdre_export.json");
  const realLogPath = joinPath(realOutput, "gdre_export.log");
  const reportText =
    options.reportText ??
    JSON.stringify(
      report(view, options.reportOptions, {
        output: displayOutput,
        log: displayLogPath,
      }),
    );
  await writeFile(realReportPath, reportText, "utf8");
  await writeFile(realLogPath, "native log", "utf8");

  const entries: ArtifactEntry[] = [...(options.entries ?? [])];
  if (options.omitReportEntry !== true) entries.push(fileEntry(realReportPath, "e"));
  if (options.omitLogEntry !== true) entries.push(fileEntry(realLogPath, "f"));

  const context: ExportEvaluationContext = {
    effectiveOutput: displayOutput,
    effectiveOutputRealPath: realOutput,
    completeMembers,
    selectedMembers,
    imports,
    nativeReportPath: joinPath(displayOutput, "gdre_export.json"),
    nativeLogPath: displayLogPath,
    resourceStringsPath: options.dumpResourceStrings === true
      ? joinPath(displayOutput, ".assets", "resource_strings.stringdump")
      : null,
    nativePreflightPath: joinPath(view.root, "native-preflight.json"),
    expectationsPath: joinPath(view.root, "export-expectations.json"),
    dumpResourceStrings: options.dumpResourceStrings === true,
    selection: { kind: "members", group: null },
  };
  const result = await evaluateExport({
    observation: { ...baseObservation(), ...options.observation },
    artifacts: inventory(entries),
    context,
  });
  return result;
};

const expectData = (result: Awaited<ReturnType<typeof run>>): ExportSemanticData => {
  assert.ok(result.evaluation.data !== null, JSON.stringify(result.detail));
  return result.evaluation.data;
};

test("native detail arrays remain available on a failed export", async () => {
  const view = await fixture("native-detail-array");
  try {
    const outcome = await run(view, {
      selectedMembers: scriptImport.destFiles,
      imports: [scriptImport],
      reportOptions: {
        failed: [{
          ...failedEntry(scriptImport, "GDScript", 15, "Native failure"),
          message_detail: ["First native detail", "Second native detail"],
        }],
      },
    });
    assert.equal(outcome.evaluation.data?.completeness, "failed");
    assert.equal(outcome.evaluation.status, "failed");
    const entries = outcome.detail["entries"];
    assert.ok(Array.isArray(entries));
    assert.equal(entries[0]?.messageDetail, "First native detail\nSecond native detail");
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("metadata rewrite status is an enum rather than a file count", async () => {
  const view = await fixture("metadata-status");
  try {
    const saved = joinPath(view.output, "main.gd");
    for (const status of [1, 3, 4]) {
      const outcome = await run(view, {
        selectedMembers: scriptImport.destFiles,
        imports: [scriptImport],
        entries: [fileEntry(saved)],
        reportOptions: {
          success: [successEntry(scriptImport, "GDScript", saved, { rewrote_metadata: status })],
        },
      });
      const effects = outcome.evaluation.data?.sideEffects ?? [];
      assert.equal(effects.includes("1 import metadata file(s) were rewritten."), status === 3);
      assert.equal(effects.some((effect) => /metadata rewrite.*failed/u.test(effect)), status === 4);
    }
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("complete export requires report, verified saved paths, and accounting", async () => {
  const view = await fixture("complete");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const script = joinPath(view.output, "main.gd");
    const result = await run(view, {
      entries: [
        fileEntry(csv, "b"),
        fileEntry(script, "c"),
        fileEntry(joinPath(view.output, "project.godot"), "d"),
        fileEntry(
          joinPath(view.output, ".godot", "imported", "translations.en.translation"),
          "g",
        ),
      ],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
            rewrote_metadata: 3,
          }),
          successEntry(scriptImport, "GDScript", script),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "succeeded", JSON.stringify(result));
    assert.equal(data.completeness, "complete");
    assert.deepEqual(data.counts, {
      completeMembers: completeMembers.length,
      selectedMembers: 3,
      nativeImports: 2,
      exportSuccess: 2,
      exportFailed: 0,
      exportUnsupported: 0,
      unverifiedSuccess: 0,
      unaccountedImports: 0,
      unmappedMembers: 0,
      missingKeys: 0,
      totalKeys: 4,
    });
    assert.deepEqual(data.artifactRoles, {
      editableExports: 2,
      unverifiedExports: 0,
      rawOrUnmappedMembers: 0,
      accompanying: 1,
      administrative: 2,
    });
    assert.equal(data.reports.native, view.reportPath);
    assert.equal(data.reports.nativeLog, view.logPath);
    assert.deepEqual(data.previews.editableExports, [csv, script]);
    assert.ok(data.sideEffects.some((line) => line.includes("metadata")));
    assert.ok(result.detail["nativeReport"] !== undefined);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("one import covering many locale destinations is one export token, not one per member", async () => {
  const view = await fixture("many-dests");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const result = await run(view, {
      selectedMembers: [
        "res://.godot/imported/translations.en.translation",
        "res://.godot/imported/translations.zh.translation",
      ],
      imports: [translationImport],
      entries: [fileEntry(csv, "b")],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
          }),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(data.completeness, "complete");
    assert.equal(data.counts.selectedMembers, 2);
    assert.equal(data.counts.nativeImports, 1);
    assert.equal(data.counts.exportSuccess, 1);
    assert.equal(data.artifactRoles.editableExports, 1);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("missing translation keys make an upstream success partial", async () => {
  const view = await fixture("missing-keys");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const result = await run(view, {
      selectedMembers: [
        "res://.godot/imported/translations.en.translation",
        "res://.godot/imported/translations.zh.translation",
      ],
      imports: [translationImport],
      entries: [fileEntry(csv, "b")],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 2, total_keys: 4 },
            message: "Missing 2 translation keys",
          }),
        ],
        translationMessage: "Missing 2 translation keys",
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "partial");
    assert.equal(data.counts.missingKeys, 2);
    assert.equal(data.counts.totalKeys, 4);
    assert.ok(data.diagnostics.some((line) => line.includes("2")));
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("selected raw-only metadata members are reported as unmapped rather than complete", async () => {
  const view = await fixture("raw-only");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const script = joinPath(view.output, "main.gd");
    const result = await run(view, {
      selectedMembers: [...selectedAll, "res://translations.csv.import"],
      entries: [fileEntry(csv, "b"), fileEntry(script, "c")],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
          }),
          successEntry(scriptImport, "GDScript", script),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "partial");
    assert.equal(data.counts.unmappedMembers, 1);
    assert.equal(data.artifactRoles.rawOrUnmappedMembers, 1);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("a selection with no reportable import is unsupported, not failed or complete", async () => {
  const view = await fixture("unmapped-only");
  try {
    const result = await run(view, {
      selectedMembers: ["res://translations.csv.import"],
      reportOptions: {},
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "unsupported");
    assert.equal(data.counts.unmappedMembers, 1);
    assert.equal(data.counts.exportSuccess, 0);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("native ERR_UNAVAILABLE is unsupported while a native failure is failed", async () => {
  const unsupportedView = await fixture("unsupported");
  try {
    const result = await run(unsupportedView, {
      selectedMembers: ["res://.godot/imported/mesh.bin-abc.bin"],
      imports: [meshImport],
      reportOptions: {
        notConverted: [
          notConvertedEntry(meshImport, "OBJ", 12, "2.x meshes"),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "unsupported");
    assert.equal(data.counts.exportUnsupported, 1);
    assert.equal(data.artifactRoles.editableExports, 0);
    assert.equal(data.previews.unsupported.length, 1);
  } finally {
    await rm(unsupportedView.root, { recursive: true, force: true });
  }

  const failedView = await fixture("failed");
  try {
    const result = await run(failedView, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      reportOptions: {
        failed: [failedEntry(scriptImport, "GDScript", 30, "write failed")],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "failed");
    assert.equal(data.counts.exportFailed, 1);
    assert.equal(data.previews.failed.length, 1);
  } finally {
    await rm(failedView.root, { recursive: true, force: true });
  }
});

test("process failure is failed without reading the report", async () => {
  const view = await fixture("process-failure");
  try {
    const result = await run(view, {
      observation: { exitCode: 1 },
      reportText: "{not json",
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "failed");
    assert.equal(data.counts.nativeImports, 2);
    assert.equal(data.artifactRoles.editableExports, 0);
    assert.match(String(result.detail["reason"]), /exit/iu);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("cancellation is unknown and does not audit output", async () => {
  const view = await fixture("cancelled");
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await run(view, {
      observation: { abortSignal: controller.signal },
      reportText: "{not json",
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "unknown");
    assert.equal(data.completeness, "unknown");
    assert.match(String(result.detail["reason"]), /cancel/iu);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("missing, unverified, malformed, or count-mismatched native evidence cannot be complete", async () => {
  const view = await fixture("evidence-gaps");
  try {
    const missingReport = await run(view, { omitReportEntry: true });
    assert.equal(expectData(missingReport).completeness, "unknown");

    const missingLog = await run(view, {
      entries: [fileEntry(joinPath(view.output, "main.gd"), "c")],
      omitLogEntry: true,
      reportOptions: {
        success: [successEntry(scriptImport, "GDScript", joinPath(view.output, "main.gd"))],
      },
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
    });
    assert.equal(expectData(missingLog).completeness, "unknown");

    const malformed = await run(view, { reportText: "{not json" });
    assert.equal(expectData(malformed).completeness, "unknown");

    const mismatch = await run(view, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      entries: [fileEntry(joinPath(view.output, "main.gd"), "c")],
      reportOptions: {
        sessionFilesTotal: 2,
        success: [successEntry(scriptImport, "GDScript", joinPath(view.output, "main.gd"))],
      },
    });
    assert.equal(expectData(mismatch).completeness, "unknown");
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("success without a verified primary artifact is unverified, not an invented failure", async () => {
  const view = await fixture("unverified");
  try {
    const noSavedPath = await run(view, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      reportOptions: {
        success: [successEntry(scriptImport, "GDScript", undefined)],
      },
    });
    const noSavedData = expectData(noSavedPath);
    assert.equal(noSavedPath.evaluation.status, "unknown");
    assert.equal(noSavedData.completeness, "unknown");
    assert.equal(noSavedData.counts.exportSuccess, 1);
    assert.equal(noSavedData.counts.unverifiedSuccess, 1);
    assert.equal(noSavedData.artifactRoles.unverifiedExports, 1);

    const outside = joinPath(view.root, "escape.gd");
    const outsidePath = await run(view, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      entries: [fileEntry(outside, "d")],
      reportOptions: {
        success: [successEntry(scriptImport, "GDScript", outside)],
      },
    });
    assert.equal(expectData(outsidePath).counts.unverifiedSuccess, 1);

    const nonRegular = await run(view, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      entries: [{
        path: joinPath(view.output, "main.gd"),
        role: "output",
        kind: "directory",
        bytes: null,
        sha256: null,
        error: null,
      }],
      reportOptions: {
        success: [successEntry(scriptImport, "GDScript", joinPath(view.output, "main.gd"))],
      },
    });
    assert.equal(expectData(nonRegular).counts.unverifiedSuccess, 1);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("an encryption-error report cannot claim complete editable export", async () => {
  const view = await fixture("encryption");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const result = await run(view, {
      selectedMembers: [
        "res://.godot/imported/translations.en.translation",
        "res://.godot/imported/translations.zh.translation",
      ],
      imports: [translationImport],
      entries: [fileEntry(csv, "b")],
      reportOptions: {
        hadEncryptionError: true,
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
          }),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(data.completeness, "partial");
    assert.ok(data.diagnostics.some((line) => /encrypt/iu.test(line)));
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("entry-level conflict messages do not invent structured counts or block completeness", async () => {
  const view = await fixture("conflicts");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const result = await run(view, {
      selectedMembers: [
        "res://.godot/imported/translations.en.translation",
        "res://.godot/imported/translations.zh.translation",
      ],
      imports: [translationImport],
      entries: [fileEntry(csv, "b")],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
            message: "Duplicate translation key observed",
          }),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(data.completeness, "complete");
    assert.equal(data.counts.missingKeys, 0);
    assert.equal(data.reports.nativeLog, view.logPath);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("an aggregate translation problem message cannot claim complete", async () => {
  const view = await fixture("translation-message");
  try {
    const csv = joinPath(view.output, "translations.csv");
    const result = await run(view, {
      selectedMembers: [
        "res://.godot/imported/translations.en.translation",
        "res://.godot/imported/translations.zh.translation",
      ],
      imports: [translationImport],
      entries: [fileEntry(csv, "b")],
      reportOptions: {
        translationMessage: "Translation keys are out of sync",
        success: [
          successEntry(translationImport, "Translation", csv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
          }),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(data.completeness, "partial");
    assert.equal(result.evaluation.status, "failed");
    assert.ok(data.diagnostics.some((line) => line.includes("out of sync")));
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("native omitted exporter and UNKNOWN loss_type remain supported metadata", async () => {
  const view = await fixture("omitted-exporter");
  try {
    const result = await run(view, {
      selectedMembers: ["res://.godot/imported/mesh.bin-abc.bin"],
      imports: [meshImport],
      reportOptions: {
        notConverted: [{
          import_info: {
            import_md_path: meshImport.importMdPath,
            preferred_import_path: meshImport.path,
          },
          error: 12,
          unsupported_format_type: "2.x meshes",
          loss_type: -1,
        }],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "failed");
    assert.equal(data.completeness, "unsupported");
    assert.equal(data.counts.exportUnsupported, 1);
    assert.ok(data.previews.unsupported[0]?.includes("mesh"));
    assert.equal(data.sideEffects.some((line) => /lossy/iu.test(line)), false);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("administrative evidence is never certified as an editable saved path", async () => {
  const view = await fixture("admin-saved");
  try {
    const result = await run(view, {
      selectedMembers: ["res://main.gdc"],
      imports: [scriptImport],
      reportOptions: {
        success: [successEntry(scriptImport, "GDScript", view.reportPath)],
      },
    });
    const data = expectData(result);
    assert.equal(data.counts.exportSuccess, 1);
    assert.equal(data.counts.unverifiedSuccess, 1);
    assert.equal(data.artifactRoles.editableExports, 0);
    assert.equal(data.artifactRoles.administrative, 2);
    assert.equal(data.completeness, "unknown");
    assert.equal(result.evaluation.status, "unknown");
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});

test("display saved paths and report locations normalize onto the validated real output", async () => {
  const view = await fixture("alias");
  try {
    const displayOutput = joinPath(view.root, "display-out");
    const realOutput = joinPath(view.root, "real-out");
    await mkdir(realOutput, { recursive: true });
    const displayCsv = joinPath(displayOutput, "translations.csv");
    const realCsv = joinPath(realOutput, "translations.csv");
    const result = await run(view, {
      displayOutput,
      realOutput,
      selectedMembers: translationImport.destFiles,
      imports: [translationImport],
      entries: [fileEntry(realCsv, "b")],
      reportOptions: {
        success: [
          successEntry(translationImport, "Translation", displayCsv, {
            extra_info: { missing_keys: 0, total_keys: 4 },
          }),
        ],
      },
    });
    const data = expectData(result);
    assert.equal(result.evaluation.status, "succeeded");
    assert.equal(data.completeness, "complete");
    assert.equal(data.reports.native, joinPath(displayOutput, "gdre_export.json"));
    assert.equal(data.reports.nativeLog, joinPath(displayOutput, "gdre_export.log"));
    assert.deepEqual(data.previews.editableExports, [displayCsv]);
    assert.equal(data.artifactRoles.editableExports, 1);
  } finally {
    await rm(view.root, { recursive: true, force: true });
  }
});
