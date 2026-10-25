import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { LoadedConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import type {
  ProcessRunOptions,
  ProcessRunResult,
  ProcessRunner,
  StreamSummaryValue,
} from "../src/process.js";
import type { RuntimeManager } from "../src/runtime.js";
import {
  AtomicJsonWriter,
  StorageError,
  type JsonWriter,
} from "../src/storage.js";
import type { RuntimeState } from "../src/types.js";

type AnyRecord = Record<string, any>;

const translationDest = [
  "res://.godot/imported/translations.en.translation",
  "res://.godot/imported/translations.zh.translation",
] as const;

const translationImport = {
  path: translationDest[0],
  import_md_path: "res://translations.csv.import",
  source_file: "res://translations.csv",
  importer: "csv_translation",
  type: "Translation",
  dest_files: [...translationDest],
};

const scriptImport = {
  path: "res://main.gdc",
  import_md_path: "res://main.gd.remap",
  source_file: "res://main.gd",
  importer: "script_bytecode",
  type: "GDScript",
  dest_files: ["res://main.gdc"],
};

const weirdImport = {
  path: "res://.godot/imported/weird.dat-abc.dat",
  import_md_path: "res://weird.dat.import",
  source_file: "res://weird.dat",
  importer: "unknown_importer",
  type: "Resource",
  dest_files: ["res://.godot/imported/weird.dat-abc.dat"],
};

const baseFiles = [
  "res://project.godot",
  "res://translations.csv",
  "res://translations.csv.import",
  ...translationDest,
  "res://main.gdc",
  "res://main.gd.remap",
  "res://weird.dat",
  "res://weird.dat.import",
  "res://.godot/imported/weird.dat-abc.dat",
];

const makeConfig = (
  root: string,
  defaults: LoadedConfig["defaults"] = {},
): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults,
  settings: [],
  sources: {
    workspace: "config",
    runtimeDirectory: "config",
    targetVersion: "builtin",
    timeouts: "config",
    defaults: Object.keys(defaults).length === 0 ? "builtin" : "config",
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

const stream = (
  options: ProcessRunOptions,
  kind: "stdout" | "stderr",
  text: string,
): StreamSummaryValue => ({
  bytes: Buffer.byteLength(text, "utf8"),
  text,
  truncated: false,
  utf8Valid: true,
  rawPath: kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath: kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete: true,
});

type PreflightOutcome =
  | "ok"
  | "no-match"
  | "malformed"
  | "unsafe"
  | "collision"
  | "timeout"
  | "unconfirmed-cleanup";

type MainOutcome =
  | "ok"
  | "partial"
  | "unsupported"
  | "failed-only"
  | "nonzero"
  | "cancel-partial"
  | "timeout-partial";

interface Scenario {
  readonly preflight: PreflightOutcome;
  readonly main: MainOutcome;
  /** One-shot gate observed by the first preflight process only. */
  readonly gate?: Promise<void>;
  /** Request cancellation observed after a natural preflight exit. */
  readonly abortAfterPreflight?: () => void;
}

interface Observed {
  readonly argvs: string[][];
  mainOptions?: ProcessRunOptions;
}

const nativeReport = (
  output: string,
  entries: {
    readonly success?: readonly unknown[];
    readonly failed?: readonly unknown[];
    readonly notConverted?: readonly unknown[];
  },
): Record<string, unknown> => {
  const success = entries.success ?? [];
  const failed = entries.failed ?? [];
  const notConverted = entries.notConverted ?? [];
  return {
    report_version: 1,
    gdre_version: "v2.8.0-beta.2",
    output_dir: output,
    session_files_total: success.length + failed.length + notConverted.length,
    log_file_location: path.join(output, "gdre_export.log"),
    translation_export_message: "",
    had_encryption_error: false,
    decompiled_scripts: [],
    failed_scripts: [],
    unsupported_types: [],
    failed_plugin_cfg_create: [],
    downloaded_plugins: [],
    success,
    failed,
    not_converted: notConverted,
  };
};

const translationSuccessEntry = (output: string) => ({
  import_info: {
    import_md_path: translationImport.import_md_path,
    preferred_import_path: translationImport.path,
  },
  exporter: "Translation",
  saved_path: path.join(output, "translations.csv"),
  resources_used: [...translationDest],
  extra_info: { missing_keys: 0, total_keys: 4 },
});

const failedEntry = (
  importInfo: { readonly importMdPath: string; readonly preferredPath: string },
  message: string,
) => ({
  import_info: {
    import_md_path: importInfo.importMdPath,
    preferred_import_path: importInfo.preferredPath,
  },
  message,
});

const preflightPayload = (
  outcome: PreflightOutcome,
): { readonly files: readonly string[]; readonly imports: readonly unknown[] } => {
  if (outcome === "no-match") {
    return {
      files: ["res://project.godot", "res://main.gdc", "res://main.gd.remap"],
      imports: [scriptImport],
    };
  }
  if (outcome === "unsafe") {
    return {
      files: ["res://../escape.gdc"],
      imports: [
        {
          ...scriptImport,
          path: "res://../escape.gdc",
          dest_files: ["res://../escape.gdc"],
        },
      ],
    };
  }
  if (outcome === "collision") {
    return { files: ["res://gdre_export.json"], imports: [] };
  }
  return { files: baseFiles, imports: [translationImport, scriptImport, weirdImport] };
};

const openExecution = (
  root: string,
  scenario: Scenario,
  observed: Observed,
  defaults: LoadedConfig["defaults"] = {},
  writer?: JsonWriter,
): ExecutionImpl => {
  const state = runtimeState(root);
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  let runNumber = 0;
  let gateUsed = false;

  const completed = (
    options: ProcessRunOptions,
    fields: {
      readonly exitCode: number | null;
      readonly trigger: ProcessRunResult["trigger"];
      readonly cleanup: ProcessRunResult["cleanup"];
      readonly stdout: string;
    },
  ): ProcessRunResult => {
    const terminated = fields.exitCode === null;
    return {
      pid: 100 + runNumber,
      exitCode: fields.exitCode,
      signal: null,
      spawnError: null,
      timedOut: fields.trigger === "timeout",
      trigger: fields.trigger,
      exitObserved: !terminated,
      spawnedAt: new Date().toISOString(),
      spawnedAtMono: performance.now(),
      exitedAt: terminated ? null : new Date().toISOString(),
      exitedAtMono: terminated ? null : performance.now() + 1,
      stdout: stream(options, "stdout", fields.stdout),
      stderr: stream(options, "stderr", ""),
      stdoutText: fields.stdout,
      stderrText: "",
      ownership: null,
      cleanup: fields.cleanup,
      captureError: null,
      storageError: null,
      error: null,
    };
  };

  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      runNumber += 1;
      observed.argvs.push([...options.argv]);
      const isPreflight = options.argv.some((value) =>
        value.endsWith("gdre-export-preflight.gd"),
      );
      const isRecovery = options.argv.some((value) =>
        value.startsWith("--recover="),
      );

      if (isPreflight) {
        if (scenario.gate !== undefined && !gateUsed) {
          gateUsed = true;
          await scenario.gate;
        }
        if (scenario.preflight === "timeout") {
          await options.sink?.close();
          return completed(options, {
            exitCode: null,
            trigger: "timeout",
            cleanup: {
              state: "confirmed",
              trigger: "timeout",
              actions: ["terminated owned tree"],
              error: null,
            },
            stdout: "",
          });
        }
        if (scenario.preflight === "unconfirmed-cleanup") {
          await options.sink?.close();
          return completed(options, {
            exitCode: null,
            trigger: "timeout",
            cleanup: {
              state: "unconfirmed",
              trigger: "timeout",
              actions: [],
              error: "owned preflight tree termination could not be confirmed",
            },
            stdout: "",
          });
        }
        const separator = options.argv.indexOf("--");
        const evidencePath = options.argv[separator + 1];
        assert.ok(evidencePath);
        const payload =
          scenario.preflight === "malformed"
            ? "{not json"
            : JSON.stringify({
                schemaVersion: 1,
                ok: true,
                ...(() => {
                  const value = preflightPayload(scenario.preflight);
                  return {
                    file_count: value.files.length,
                    import_count: value.imports.length,
                    files: value.files,
                    imports: value.imports,
                  };
                })(),
              });
        await writeFile(evidencePath, payload, "utf8");
        const output = "native preflight complete\n";
        await options.sink?.append("stdout", Buffer.from(output, "utf8"), output);
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        scenario.abortAfterPreflight?.();
        return completed(options, {
          exitCode: 0,
          trigger: null,
          cleanup: {
            state: "not_needed",
            trigger: null,
            actions: [],
            error: null,
          },
          stdout: output,
        });
      }

      if (isRecovery) {
        observed.mainOptions = options;
        const output = options.argv
          .find((value) => value.startsWith("--output="))!
          .slice("--output=".length);
        await mkdir(output, { recursive: true });
        const outcome = scenario.main;
        const terminated =
          outcome === "cancel-partial" || outcome === "timeout-partial";
        const report =
          outcome === "ok" || outcome === "partial" || outcome === "nonzero"
            ? nativeReport(output, {
                success: [translationSuccessEntry(output)],
                ...(outcome === "partial" || outcome === "nonzero"
                  ? {
                      failed: [
                        failedEntry(
                          {
                            importMdPath: scriptImport.import_md_path,
                            preferredPath: scriptImport.path,
                          },
                          "script decompilation failed",
                        ),
                      ],
                    }
                  : {}),
              })
            : outcome === "unsupported"
              ? nativeReport(output, {
                  notConverted: [
                    {
                      import_info: {
                        import_md_path: weirdImport.import_md_path,
                        preferred_import_path: weirdImport.path,
                      },
                      unsupported_format_type: "Resource",
                    },
                  ],
                })
              : nativeReport(output, {
                  failed: [
                    failedEntry(
                      {
                        importMdPath: translationImport.import_md_path,
                        preferredPath: translationImport.path,
                      },
                      "translation export failed",
                    ),
                  ],
                });
        await writeFile(
          path.join(output, "gdre_export.json"),
          JSON.stringify(report),
          "utf8",
        );
        await writeFile(path.join(output, "gdre_export.log"), "native log\n", "utf8");
        await writeFile(
          path.join(output, "translations.csv"),
          "key,en,zh\nHELLO,Hello,你好\n",
          "utf8",
        );
        if (outcome === "ok" || outcome === "partial") {
          await writeFile(path.join(output, "project.godot"), "config\n", "utf8");
          for (const member of translationDest) {
            const file = path.join(
              output,
              ...member.slice("res://".length).split("/"),
            );
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "selected raw member\n", "utf8");
          }
        }
        const text = "GDRE export complete\n";
        await options.sink?.append("stdout", Buffer.from(text, "utf8"), text);
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        return completed(options, {
          exitCode: terminated
            ? null
            : outcome === "nonzero"
              ? 1
              : 0,
          trigger:
            outcome === "cancel-partial"
              ? "cancel"
              : outcome === "timeout-partial"
                ? "timeout"
                : null,
          cleanup: terminated
            ? {
                state: "confirmed",
                trigger: outcome === "cancel-partial" ? "cancel" : "timeout",
                actions: ["terminated owned tree"],
                error: null,
              }
            : { state: "not_needed", trigger: null, actions: [], error: null },
          stdout: text,
        });
      }

      const output = path.join(path.dirname(options.streamPaths.stdoutBin), "output");
      await writeFile(path.join(output, "unexpected.bin"), "unexpected\n", "utf8");
      const text = "Godot RE Tools v2.8.0-beta.2\r\n";
      await options.sink?.append("stdout", Buffer.from(text, "utf8"), text);
      await options.sink?.append("stderr", Buffer.alloc(0), "");
      await options.sink?.close();
      return completed(options, {
        exitCode: 1,
        trigger: null,
        cleanup: { state: "not_needed", trigger: null, actions: [], error: null },
        stdout: text,
      });
    },
  };
  return new ExecutionImpl(makeConfig(root, defaults), manager, {
    processRunner: runner,
    ...(writer === undefined ? {} : { writer }),
  });
};

const fixture = async (): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly input: string;
  readonly hint: string;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-export-execution-"));
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "fixtures"), { recursive: true });
  const input = path.join(workspace, "fixtures", "pack 空间.pck");
  const hint = path.join(workspace, "fixtures", "hints.csv");
  await writeFile(input, "authored input bytes", "utf8");
  await writeFile(hint, "key,en\nHELLO,Hello\n", "utf8");
  return { root, workspace, input, hint };
};

const close = async (execution: ExecutionImpl, root: string): Promise<void> => {
  await execution.close("shutdown");
  await rm(root, { recursive: true, force: true });
};

test("a natural export run reaches report and inventory evaluation with retained truth", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const execution = openExecution(value.root, { preflight: "ok", main: "ok" }, observed);
  try {
    const result = await execution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        output: "exports/out 空间",
        selection: {
          kind: "members",
          include: ["res://.godot/imported/*.translation"],
        },
        translationHints: ["fixtures/hints.csv"],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    assert.equal(result.commandId, "export-resources");
    assert.equal(result.status, "succeeded");
    const effective = path.join(value.workspace, "exports", "out 空间");
    assert.equal(result.paths.effectiveDestination, effective);
    assert.equal(result.paths.output, path.join(result.paths.operation!, "output"));
    assert.equal(observed.argvs.length, 2);
    assert.ok(
      observed.argvs[0]?.some((token) => token.endsWith("gdre-export-preflight.gd")),
    );
    assert.deepEqual(observed.argvs[1], [
      "--headless",
      "--no-header",
      "--",
      `--recover=${value.input}`,
      `--output=${effective}`,
      "--include=res://.godot/imported/*.translation",
      `--translation-hint=${value.hint}`,
      "--setting=write_json_report=true",
    ]);

    const data = result.semantic.data;
    assert.ok(data !== null && "completeness" in data && "selection" in data);
    assert.equal(data.completeness, "complete");
    assert.deepEqual(data.selection, { kind: "members", group: null });
    assert.equal(data.counts.completeMembers, baseFiles.length);
    assert.equal(data.counts.selectedMembers, 2);
    assert.equal(data.counts.nativeImports, 1);
    assert.equal(data.counts.exportSuccess, 1);
    assert.equal(data.artifactRoles.editableExports, 1);
    assert.ok(data.reports.adapter !== null);
    const detail = JSON.parse(await readFile(data.reports.adapter!, "utf8")) as AnyRecord;
    assert.equal(detail.completeness, "complete");
    assert.ok(Array.isArray(detail.imports));

    const inventory = JSON.parse(
      await readFile(result.paths.artifactInventory!, "utf8"),
    ) as AnyRecord;
    const roles = new Map(
      (inventory.entries as AnyRecord[]).map((entry) => [entry.path, entry.role]),
    );
    assert.equal(roles.get(path.join(effective, "translations.csv")), "export-artifact");
    assert.equal(
      roles.get(path.join(effective, "gdre_export.json")),
      "administrative-report",
    );
    assert.equal(
      roles.get(path.join(effective, "gdre_export.log")),
      "administrative-log",
    );
    assert.equal(
      roles.get(path.join(effective, "translations.csv.import")),
      undefined,
    );
    assert.equal(
      roles.get(path.join(effective, ".godot", "imported", "translations.en.translation")),
      "selected-raw",
    );
    assert.equal(roles.get(path.join(effective, "project.godot")), "accompanying");
    assert.equal(result.artifacts.complete, true);

    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as AnyRecord;
    assert.deepEqual(manifest.parameterSources, {
      workspace: "config",
      inputs: "call",
      session: "builtin",
      output: "call",
      selection: "call",
      translationHints: "call",
      collectResourceStrings: "builtin",
      dumpResourceStrings: "builtin",
    });
    assert.equal(manifest.effectiveParameters.output, effective);
    assert.deepEqual(manifest.effectiveParameters.translationHints, [
      { kind: "path", path: value.hint },
    ]);
    assert.equal(manifest.effectiveParameters.collectResourceStrings, true);
    assert.equal(manifest.effectiveParameters.dumpResourceStrings, false);
    assert.deepEqual(manifest.invocation.argv, observed.argvs[1]);
    assert.ok(manifest.effects.reads.includes(value.input));
    assert.ok(manifest.effects.reads.includes(value.hint));
    assert.ok(
      manifest.effects.reads.includes(
        path.join(value.root, "native", "gdre-export-preflight.gd"),
      ),
    );
    for (const write of [
      effective,
      path.join(result.paths.operation!, "export-preflight", "native-preflight.json"),
      path.join(result.paths.operation!, "export-preflight", "export-expectations.json"),
      path.join(result.paths.operation!, "export-detail", "report.json"),
    ]) {
      assert.ok(manifest.effects.writes.includes(write), write);
    }
    assert.ok(manifest.effects.knownSideEffectRoots.includes(effective));
    const hints = (manifest.invocation.inputPaths as AnyRecord[]).filter(
      (entry) => entry.role === "hint",
    );
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.path, value.hint);
    assert.equal(typeof hints[0]?.sha256, "string");
    assert.equal(manifest.preflight.semantic.status, "succeeded");
    assert.equal(manifest.preflight.native.fileCount, baseFiles.length);
    assert.ok(
      String(manifest.preflight.expectations.path).endsWith(
        "export-expectations.json",
      ),
    );
  } finally {
    await close(execution, value.root);
  }
});

test("no-match groups and unsafe or malformed metadata fail before any mutation", async () => {
  for (const [label, preflight, selection, code] of [
    [
      "no-match",
      "no-match",
      { kind: "group", group: "translations" },
      "semantic_failed",
    ],
    [
      "malformed",
      "malformed",
      { kind: "members", include: ["res://.godot/imported/*.translation"] },
      "semantic_unknown",
    ],
    [
      "unsafe",
      "unsafe",
      { kind: "members", include: ["res://**/*.gdc"] },
      "path_unsupported",
    ],
    [
      "collision",
      "collision",
      { kind: "members", include: ["res://gdre_export.json"] },
      "path_unsupported",
    ],
  ] as const) {
    const value = await fixture();
    const requestedOutput = path.join(value.root, `requested ${label}`);
    const observed: Observed = { argvs: [] };
    const execution = openExecution(
      value.root,
      { preflight, main: "ok" },
      observed,
    );
    try {
      const result = await execution.execute(
        "export-resources",
        {
          inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
          output: requestedOutput,
          selection,
        },
        { signal: new AbortController().signal },
      );
      assert.equal(observed.argvs.length, 1, label);
      assert.equal(
        observed.argvs[0]?.some((token) => token.startsWith("--recover=")),
        false,
        label,
      );
      assert.equal(result.success, false, label);
      assert.equal(result.error?.code, code, label);
      assert.equal(result.process.pid, null, label);
      assert.equal(result.artifacts.count, 0, label);
      assert.equal(result.artifacts.complete, false, label);
      await assert.rejects(
        stat(requestedOutput),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        label,
      );
      const manifest = JSON.parse(
        await readFile(result.paths.manifest!, "utf8"),
      ) as AnyRecord;
      assert.equal(manifest.error.code, code, label);
      assert.notEqual(manifest.preflight.semantic.status, "succeeded", label);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("partial selected exports keep complete inventory and bounded diagnostics", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const execution = openExecution(
    value.root,
    { preflight: "ok", main: "partial" },
    observed,
  );
  try {
    const result = await execution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        output: "partial output",
        selection: {
          kind: "members",
          include: [
            "res://.godot/imported/*.translation",
            "res://main.gdc",
          ],
        },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "semantic_failed");
    const data = result.semantic.data;
    assert.ok(data !== null && "completeness" in data && "selection" in data);
    assert.equal(data.completeness, "partial");
    assert.equal(data.counts.exportSuccess, 1);
    assert.equal(data.counts.exportFailed, 1);
    assert.equal(data.counts.nativeImports, 2);
    assert.equal(data.artifactRoles.editableExports, 1);
    assert.ok(data.previews.failed.length > 0);
    assert.ok(data.diagnostics.length > 0);
    assert.equal(result.artifacts.complete, true);
    const effective = path.join(value.workspace, "partial output");
    assert.equal(
      await readFile(path.join(effective, "translations.csv"), "utf8"),
      "key,en,zh\nHELLO,Hello,你好\n",
    );
    const detail = JSON.parse(await readFile(data.reports.adapter!, "utf8")) as AnyRecord;
    assert.equal(detail.completeness, "partial");
    assert.ok(Array.isArray(detail.imports));
    assert.ok(
      (detail.inventory as AnyRecord[]).some(
        (entry) => entry.kind === "file" && entry.sha256 !== null,
      ),
    );
  } finally {
    await close(execution, value.root);
  }
});

test("unsupported and failed requested exports are classified honestly", async () => {
  for (const [label, main, include, completeness, field] of [
    [
      "unsupported",
      "unsupported",
      "res://.godot/imported/weird.dat-abc.dat",
      "unsupported",
      "exportUnsupported",
    ],
    [
      "failed",
      "failed-only",
      "res://.godot/imported/*.translation",
      "failed",
      "exportFailed",
    ],
  ] as const) {
    const value = await fixture();
    const observed: Observed = { argvs: [] };
    const execution = openExecution(value.root, { preflight: "ok", main }, observed);
    try {
      const result = await execution.execute(
        "export-resources",
        {
          inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
          selection: { kind: "members", include: [include] },
        },
        { signal: new AbortController().signal },
      );
      assert.equal(result.success, false, label);
      assert.equal(result.error?.code, "semantic_failed", label);
      const data = result.semantic.data;
      assert.ok(data !== null && "completeness" in data && "selection" in data, label);
      assert.equal(data.completeness, completeness, label);
      assert.equal(data.counts[field], 1, label);
      assert.equal(data.artifactRoles.editableExports, 0, label);
      assert.equal(result.artifacts.complete, true, label);
      const inventory = JSON.parse(
        await readFile(result.paths.artifactInventory!, "utf8"),
      ) as AnyRecord;
      assert.equal(inventory.complete, true, label);
      assert.ok(
        (inventory.entries as AnyRecord[]).some(
          (entry) => entry.role === "administrative-report",
        ),
        label,
      );
    } finally {
      await close(execution, value.root);
    }
  }
});

test("preflight stops and finite main stops skip post-stop auditing", async () => {
  const timeoutCase = await fixture();
  const timeoutObserved: Observed = { argvs: [] };
  const timeoutExecution = openExecution(
    timeoutCase.root,
    { preflight: "timeout", main: "ok" },
    timeoutObserved,
  );
  try {
    const result = await timeoutExecution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        output: "stopped preflight",
        selection: { kind: "group", group: "translations" },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(result.process.pid, null);
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, false);
    assert.equal(timeoutObserved.argvs.length, 1);
    assert.equal(result.cleanup.trigger, "timeout");
    await assert.rejects(stat(path.join(timeoutCase.workspace, "stopped preflight")));
  } finally {
    await close(timeoutExecution, timeoutCase.root);
  }

  const cleanupCase = await fixture();
  const cleanupObserved: Observed = { argvs: [] };
  const cleanupExecution = openExecution(
    cleanupCase.root,
    { preflight: "unconfirmed-cleanup", main: "ok" },
    cleanupObserved,
  );
  try {
    const result = await cleanupExecution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        selection: { kind: "group", group: "scripts" },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.error?.code, "cleanup_failed");
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(cleanupObserved.argvs.length, 1);
    const second = await cleanupExecution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        selection: { kind: "group", group: "scripts" },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(second.error?.code, "cleanup_failed");
    assert.equal(second.paths.operation, null);
    assert.equal(cleanupObserved.argvs.length, 1);
  } finally {
    await close(cleanupExecution, cleanupCase.root);
  }

  const cancelCase = await fixture();
  const cancelObserved: Observed = { argvs: [] };
  const controller = new AbortController();
  const cancelExecution = openExecution(
    cancelCase.root,
    {
      preflight: "ok",
      main: "ok",
      abortAfterPreflight: () => controller.abort(),
    },
    cancelObserved,
  );
  try {
    const result = await cancelExecution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        selection: { kind: "group", group: "scripts" },
      },
      { signal: controller.signal },
    );
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(result.process.pid, null);
    assert.equal(result.artifacts.count, 0);
    assert.equal(cancelObserved.argvs.length, 1);
  } finally {
    await close(cancelExecution, cancelCase.root);
  }

  for (const [outcome, status, code] of [
    ["timeout-partial", "timed_out", "execution_timeout"],
    ["cancel-partial", "cancelled", "cancelled"],
  ] as const) {
    const value = await fixture();
    const observed: Observed = { argvs: [] };
    const execution = openExecution(
      value.root,
      { preflight: "ok", main: outcome },
      observed,
    );
    try {
      const result = await execution.execute(
        "export-resources",
        {
          inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
          output: "partial stop",
          selection: { kind: "group", group: "translations" },
        },
        { signal: new AbortController().signal },
      );
      assert.equal(result.success, false);
      assert.equal(result.status, status);
      assert.equal(result.error?.code, code);
      assert.equal(result.semantic.status, "not_evaluated");
      assert.equal(result.artifacts.count, 0);
      assert.equal(result.artifacts.complete, false);
      assert.equal(observed.argvs.length, 2);
      assert.equal(
        await readFile(
          path.join(value.workspace, "partial stop", "translations.csv"),
          "utf8",
        ),
        "key,en,zh\nHELLO,Hello,你好\n",
      );
      const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as AnyRecord;
      assert.equal(manifest.error.code, code);
      assert.deepEqual(manifest.cleanup, result.cleanup);
    } finally {
      await close(execution, value.root);
    }
  }
});

test("independent exports in distinct workspaces keep operation-local state", async () => {
  const value = await fixture();
  const workspaceA = path.join(value.root, "workspace a");
  const workspaceB = path.join(value.root, "workspace b");
  const destinationA = path.join(value.root, "output a");
  const destinationB = path.join(value.root, "output b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: Observed = { argvs: [] };
  const execution = openExecution(
    value.root,
    { preflight: "ok", main: "ok", gate },
    observed,
    // Scheduling test under suite concurrency, not a performance claim.
    { "export-resources": { timeoutMs: 10_000 } },
  );
  const control = new AbortController();
  try {
    const first = execution.execute(
      "export-resources",
      {
        workspace: workspaceA,
        inputs: [{ kind: "path", path: value.input }],
        output: destinationA,
        selection: { kind: "group", group: "translations" },
      },
      { signal: control.signal },
    );
    void first.catch(() => undefined);
    for (let attempt = 0; attempt < 500 && observed.argvs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observed.argvs.length, 1, "the first preflight is gated");
    const second = execution.execute(
      "export-resources",
      {
        workspace: workspaceB,
        inputs: [{ kind: "path", path: value.input }],
        output: destinationB,
        selection: { kind: "group", group: "translations" },
      },
      { signal: control.signal },
    );
    void second.catch(() => undefined);
    for (let attempt = 0; attempt < 500 && observed.argvs.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observed.argvs.length,
      2,
      "the independent export launches its own preflight without waiting",
    );
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(
      firstResult.success,
      true,
      JSON.stringify({ error: firstResult.error, semantic: firstResult.semantic }),
    );
    assert.equal(
      secondResult.success,
      true,
      JSON.stringify({ error: secondResult.error, semantic: secondResult.semantic }),
    );
    assert.equal(observed.argvs.length, 4);
    for (const destination of [destinationA, destinationB]) {
      assert.equal(
        await readFile(path.join(destination, "translations.csv"), "utf8"),
        "key,en,zh\nHELLO,Hello,你好\n",
      );
    }
    assert.notEqual(firstResult.paths.operation, secondResult.paths.operation);
  } finally {
    release();
    await close(execution, value.root);
  }
});

test("omitted output is placed beside the input and still supplied explicitly", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const execution = openExecution(value.root, { preflight: "ok", main: "ok" }, observed);
  try {
    const result = await execution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        selection: { kind: "group", group: "translations" },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    const owned = path.join(result.paths.operation!, "output");
    const sibling = path.join(
      path.dirname(value.input),
      `pack 空间-exported-${path.basename(result.paths.operation!)}`,
    );
    assert.equal(result.paths.output, owned);
    assert.equal(result.paths.effectiveDestination, sibling);
    assert.notEqual(result.paths.effectiveDestination, owned);
    assert.ok(observed.argvs[1]?.includes(`--output=${sibling}`));
    const data = result.semantic.data;
    assert.ok(data !== null && "completeness" in data && "selection" in data);
    assert.equal(data.outputPath, sibling);
    assert.equal(data.completeness, "complete");
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as AnyRecord;
    assert.equal(manifest.parameterSources.output, "builtin");
    assert.equal(manifest.effectiveParameters.output, sibling);
    assert.ok(manifest.effects.knownSideEffectRoots.includes(sibling));
  } finally {
    await close(execution, value.root);
  }
});

test("adapter detail persistence failure resolves as storage_failed with acquired evidence intact", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const controller = new AbortController();
  const detailPath = (file: string): boolean =>
    file.replaceAll("\\", "/").endsWith("/export-detail/report.json");
  const writer: JsonWriter = {
    async write(file, written) {
      if (detailPath(file)) {
        // A cancellation observed during the failing persistence write must
        // not hide the recorded storage fault.
        controller.abort();
        throw new StorageError("injected adapter detail write failure");
      }
      await new AtomicJsonWriter().write(file, written);
    },
  };
  const execution = openExecution(
    value.root,
    { preflight: "ok", main: "ok" },
    observed,
    {},
    writer,
  );
  try {
    const result = await execution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        output: "detail output",
        selection: { kind: "group", group: "translations" },
      },
      { signal: controller.signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "storage_failed");
    assert.equal(result.persistence.state, "incomplete");
    assert.match(result.persistence.error ?? "", /injected adapter detail/u);
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.artifacts.complete, true);
    assert.ok(result.artifacts.count > 0, "acquired inventory is retained");
    const effective = path.join(value.workspace, "detail output");
    assert.equal(
      await readFile(path.join(effective, "translations.csv"), "utf8"),
      "key,en,zh\nHELLO,Hello,你好\n",
    );
    const inventory = JSON.parse(
      await readFile(result.paths.artifactInventory!, "utf8"),
    ) as AnyRecord;
    assert.equal(inventory.complete, true);
    assert.ok((inventory.entries as AnyRecord[]).length > 0);
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as AnyRecord;
    assert.equal(manifest.error.code, "storage_failed");
    assert.equal(manifest.persistence.state, "incomplete");
    assert.deepEqual(manifest.cleanup, result.cleanup);
  } finally {
    await close(execution, value.root);
  }
});

test("cancellation observed during adapter detail persistence stays a structured cancellation", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const controller = new AbortController();
  const detailPath = (file: string): boolean =>
    file.replaceAll("\\", "/").endsWith("/export-detail/report.json");
  const writer: JsonWriter = {
    async write(file, written) {
      if (detailPath(file)) {
        controller.abort();
      }
      await new AtomicJsonWriter().write(file, written);
    },
  };
  const execution = openExecution(
    value.root,
    { preflight: "ok", main: "ok" },
    observed,
    {},
    writer,
  );
  try {
    const result = await execution.execute(
      "export-resources",
      {
        inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }],
        output: "cancelled detail output",
        selection: { kind: "group", group: "translations" },
      },
      { signal: controller.signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(result.persistence.state, "complete");
    assert.equal(result.semantic.status, "succeeded");
    assert.equal(result.artifacts.complete, true);
    assert.ok(result.artifacts.count > 0);
    const effective = path.join(value.workspace, "cancelled detail output");
    assert.equal(
      await readFile(path.join(effective, "translations.csv"), "utf8"),
      "key,en,zh\nHELLO,Hello,你好\n",
    );
    const manifest = JSON.parse(await readFile(result.paths.manifest!, "utf8")) as AnyRecord;
    assert.equal(manifest.error.code, "cancelled");
    assert.equal(manifest.persistence.state, "complete");
    assert.deepEqual(manifest.cleanup, result.cleanup);
  } finally {
    await close(execution, value.root);
  }
});

test("query tools still fail unexpected output while export artifacts are expected", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const execution = openExecution(value.root, { preflight: "ok", main: "ok" }, observed);
  try {
    const result = await execution.execute(
      "version",
      {},
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "semantic_failed");
    assert.equal(result.semantic.status, "failed");
    assert.equal(result.artifacts.count, 1);
    assert.equal(result.artifacts.complete, true);
    assert.equal(observed.argvs.length, 1);
  } finally {
    await close(execution, value.root);
  }
});

test("validation rejection allocates no operation or manifest", async () => {
  const value = await fixture();
  const observed: Observed = { argvs: [] };
  const execution = openExecution(value.root, { preflight: "ok", main: "ok" }, observed);
  try {
    const result = await execution.execute(
      "export-resources",
      { inputs: [{ kind: "path", path: "fixtures/pack 空间.pck" }] },
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "validation_failed");
    assert.equal(result.paths.manifest, null);
    assert.equal(result.paths.operation, null);
    assert.equal(observed.argvs.length, 0);
    await assert.rejects(
      stat(path.join(value.workspace, ".gdre", "operations")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    await close(execution, value.root);
  }
});
