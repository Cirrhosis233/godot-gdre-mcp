import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { RuntimeState } from "../src/types.js";

type AnyRecord = Record<string, any>;

const scriptName = "gdre-patch-translations.gd";
const key = "ab".repeat(32);

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

interface ObservedRun {
  readonly argv: string[];
  readonly request: AnyRecord | null;
  readonly reportPath: string;
}

interface PatchScenario {
  /** Return a report object, or a sentinel for missing/malformed delivery. */
  readonly report?: (context: {
    readonly request: AnyRecord;
    readonly effectiveOutput: string;
    readonly environment: NodeJS.ProcessEnv;
  }) =>
    | AnyRecord
    | "missing"
    | "malformed"
    | Promise<AnyRecord | "missing" | "malformed">;
  readonly exitCode?: number | null;
  readonly trigger?: ProcessRunResult["trigger"];
  readonly stdout?: string;
  readonly stderr?: string;
  /** Remove the complete text evidence after the run but before it is returned. */
  readonly removeStdoutEvidence?: boolean;
  readonly beforeReport?: (context: {
    readonly request: AnyRecord;
    readonly effectiveOutput: string;
    readonly reportPath: string;
  }) => Promise<void>;
}

const openExecution = (
  root: string,
  scenario: PatchScenario = {},
): { readonly execution: ExecutionImpl; readonly observed: ObservedRun[] } => {
  const state = runtimeState(root);
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  const observed: ObservedRun[] = [];

  const completed = (
    options: ProcessRunOptions,
    fields: {
      readonly exitCode: number | null;
      readonly trigger: ProcessRunResult["trigger"];
      readonly stdout: string;
      readonly stderr: string;
    },
  ): ProcessRunResult => {
    const terminated = fields.exitCode === null;
    return {
      pid: 200 + observed.length,
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
      stderr: stream(options, "stderr", fields.stderr),
      stdoutText: fields.stdout,
      stderrText: fields.stderr,
      ownership: null,
      cleanup: terminated
        ? {
            state: "confirmed",
            trigger: fields.trigger,
            actions: ["terminated owned tree"],
            error: null,
          }
        : { state: "not_needed", trigger: null, actions: [], error: null },
      captureError: null,
      storageError: null,
      error: null,
    };
  };

  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      const isPatch = options.argv.some((value) => value.endsWith(scriptName));
      assert.equal(isPatch, true, "only the fixed translation-patch script is launched");
      const separator = options.argv.indexOf("--");
      assert.ok(separator >= 0);
      const requestPath = options.argv[separator + 1];
      const reportPath = options.argv[separator + 2];
      assert.ok(requestPath !== undefined && reportPath !== undefined);
      const request = JSON.parse(await readFile(requestPath, "utf8")) as AnyRecord;
      observed.push({ argv: [...options.argv], request, reportPath });
      const effectiveOutput = String(request.output);

      const terminated = scenario.exitCode === null;
      if (terminated) {
        await options.sink?.append("stdout", Buffer.alloc(0), "");
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        return completed(options, {
          exitCode: null,
          trigger: scenario.trigger ?? "timeout",
          stdout: "",
          stderr: "",
        });
      }
      if (scenario.exitCode !== undefined && scenario.exitCode !== 0) {
        await options.sink?.append("stdout", Buffer.alloc(0), "");
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        return completed(options, {
          exitCode: scenario.exitCode,
          trigger: null,
          stdout: "",
          stderr: "",
        });
      }

      await scenario.beforeReport?.({
        request,
        effectiveOutput,
        reportPath,
      });
      const report = await scenario.report?.({ request, effectiveOutput, environment: options.env ?? {} });
      if (report === "malformed") {
        await writeFile(reportPath, "{not json", "utf8");
      } else if (report !== undefined && report !== "missing") {
        await writeFile(reportPath, JSON.stringify(report), "utf8");
      }

      const stdout = scenario.stdout ?? "";
      const stderr = scenario.stderr ?? "";
      await options.sink?.append("stdout", Buffer.from(stdout, "utf8"), stdout);
      await options.sink?.append("stderr", Buffer.from(stderr, "utf8"), stderr);
      await options.sink?.close();
      if (scenario.removeStdoutEvidence === true) {
        await rm(options.streamPaths.stdoutText, { force: true });
      }
      return completed(options, {
        exitCode: 0,
        trigger: null,
        stdout,
        stderr,
      });
    },
  };
  return {
    execution: new ExecutionImpl(makeConfig(root), manager, { processRunner: runner }),
    observed,
  };
};

const fixture = async (): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly input: string;
  readonly csvDirectory: string;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-patch-execution-"));
  const workspace = path.join(root, "workspace");
  const csvDirectory = path.join(workspace, "fixtures");
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(path.join(root, "native", scriptName), "# test placeholder\n", "utf8");
  await mkdir(csvDirectory, { recursive: true });
  const input = path.join(csvDirectory, "pack 空间.pck");
  await writeFile(input, "authored package bytes", "utf8");
  return { root, workspace, input, csvDirectory };
};

const close = async (execution: ExecutionImpl, root: string): Promise<void> => {
  await execution.close("shutdown");
  await rm(root, { recursive: true, force: true });
};

const writeCsv = async (file: string, bytes: Buffer | string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

test("malformed, duplicate, and destructive inputs fail before any native launch", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root);
  try {
    const badCsv = path.join(value.csvDirectory, "bad.csv");
    await writeCsv(badCsv, "key,en,zh\nHELLO,Hello,你好\nHELLO,Other,别的\n");
    const malformed = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv: badCsv, resource: "res://translations.csv" }],
        output: "patch out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(malformed.success, false);
    assert.equal(malformed.error?.code, "validation_failed", malformed.error?.message);
    assert.match(malformed.error?.message ?? "", /repeats key/iu);
    assert.equal(observed.length, 0);

    const invalidUtf8 = path.join(value.csvDirectory, "invalid-utf8.csv");
    await writeCsv(
      invalidUtf8,
      Buffer.from([0x6b, 0x65, 0x79, 0x2c, 0x65, 0x6e, 0x0a, 0x41, 0x2c, 0xff, 0x0a]),
    );
    const undecodable = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv: invalidUtf8, resource: "res://translations.csv" }],
        output: "patch out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(undecodable.success, false);
    assert.equal(
      undecodable.error?.code,
      "validation_failed",
      undecodable.error?.message,
    );
    assert.match(
      undecodable.error?.message ?? "",
      /translation CSV is not valid UTF-8/iu,
    );
    assert.equal(observed.length, 0);

    const duplicateLocale = path.join(value.csvDirectory, "duplicate-locale.csv");
    await writeCsv(duplicateLocale, "key,en,en\nHELLO,Hello,Hi\n");
    const repeatedLocale = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [
          { csv: duplicateLocale, resource: "res://translations.csv" },
        ],
        output: "patch out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(repeatedLocale.success, false);
    assert.equal(
      repeatedLocale.error?.code,
      "validation_failed",
      repeatedLocale.error?.message,
    );
    assert.match(
      repeatedLocale.error?.message ?? "",
      /repeats locale column/iu,
    );
    assert.equal(observed.length, 0);

    const sameCsv = path.join(value.csvDirectory, "same.csv");
    await writeCsv(sameCsv, "key,en,zh\nHELLO,Hello,你好\n");
    const duplicate = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [
          { csv: sameCsv, resource: "res://one.csv" },
          { csv: sameCsv.replaceAll("\\", "/"), resource: "res://two.csv" },
        ],
        output: "patch out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.error?.code, "validation_failed", duplicate.error?.message);
    assert.match(duplicate.error?.message ?? "", /same canonical CSV/iu);
    assert.equal(observed.length, 0);

    const directoryCsv = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [
          { csv: value.csvDirectory, resource: "res://translations.csv" },
        ],
        output: "patch out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(directoryCsv.success, false);
    assert.equal(
      directoryCsv.error?.code,
      "validation_failed",
      directoryCsv.error?.message,
    );
    assert.match(directoryCsv.error?.message ?? "", /not a regular file/iu);
    assert.equal(observed.length, 0);

    const nonempty = path.join(value.root, "nonempty destination");
    await mkdir(nonempty, { recursive: true });
    await writeFile(path.join(nonempty, "existing.txt"), "occupied", "utf8");
    const destructive = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv: sameCsv, resource: "res://translations.csv" }],
        output: nonempty,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(destructive.success, false);
    assert.equal(destructive.error?.code, "path_unsupported", destructive.error?.message);
    assert.match(destructive.error?.message ?? "", /not empty/iu);
    assert.equal(observed.length, 0);

    const overlap = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv: sameCsv, resource: "res://translations.csv" }],
        output: value.csvDirectory,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(overlap.success, false);
    assert.equal(overlap.error?.code, "path_unsupported", overlap.error?.message);
    assert.match(overlap.error?.message ?? "", /overlaps/u);
    assert.equal(observed.length, 0);
  } finally {
    await close(execution, value.root);
  }
});

/** Write the outputs and a fixed-contract report the native script would emit. */
const nativeSuccessReport = async (context: {
  readonly request: AnyRecord;
  readonly effectiveOutput: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<AnyRecord> => {
  const { request, effectiveOutput, environment } = context;
  const explicit = Array.isArray(request.locales) && request.locales.length > 0;
  const requestedLocales: string[] = explicit ? request.locales : [];
  await mkdir(effectiveOutput, { recursive: true });
  const fileMap: Record<string, string> = {};
  const outputs: AnyRecord[] = [];
  const mappings: AnyRecord[] = [];
  for (const translation of request.translations as AnyRecord[]) {
    const resource = String(translation.resource);
    const preparedCsv = String(translation.csv);
    const rows = translation.rows as readonly unknown[][];
    const derivedLocales = explicit ? requestedLocales : ["fr"];
    for (const locale of derivedLocales) {
      const member = `res://.godot/imported/${path
        .basename(resource)
        .replace(/\.[^.]*$/u, "")}.${locale}.translation`;
      const file = path.join(
        effectiveOutput,
        ...member.slice("res://".length).split("/"),
      );
      const bytes = Buffer.from(`${resource}:${locale}\n`, "utf8");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      fileMap[file] = member;
      outputs.push({
        resource,
        member,
        path: file,
        locale,
        class: "OptimizedTranslation",
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        verifiedTexts: rows.length,
        retainedContentVerified: true,
      });
    }
    mappings.push({
      resource,
      csv: preparedCsv,
      defaultLocale: "en",
      locales: explicit ? ["en", ...requestedLocales] : [...derivedLocales],
    });
  }
  const projectPath = path.join(effectiveOutput, "project.godot");
  const projectBytes = Buffer.from("config_version=5\n", "utf8");
  await writeFile(projectPath, projectBytes);
  fileMap[projectPath] = "res://project.godot";
  return {
    version: 1,
    ok: true,
    stage: "complete",
    error: null,
    nativeCode: 0,
    output: effectiveOutput,
    userData: path.join(
      String(environment.APPDATA),
      "Godot",
      "app_userdata",
      "Godot RE Tools",
    ),
    temp: String(environment.TEMP),
    mappings,
    fileMap,
    outputs,
    projectConfig: {
      member: "res://project.godot",
      path: projectPath,
      sha256: sha256(projectBytes),
    },
  };
};

test("preparation preserves originals and success requires verified native evidence", async () => {
  const value = await fixture();
  const priorExportCsv = path.join(
    value.workspace,
    ".gdre",
    "operations",
    "prior-export",
    "output",
    "translations.csv",
  );
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const originalBytes = Buffer.concat([
    bom,
    Buffer.from(
      'en,key,zh\r\nHello,HELLO,"第一行\r\n第二行"\r\n',
      "utf8",
    ),
  ]);
  await writeCsv(priorExportCsv, originalBytes);
  const { execution, observed } = openExecution(value.root, {
    report: nativeSuccessReport,
  });
  try {
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv: priorExportCsv, resource: "res://translations.csv" }],
        output: "patch out",
        locales: ["zh"],
        key,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    assert.equal(result.status, "succeeded");
    const effective = path.join(value.workspace, "patch out");
    assert.equal(result.paths.effectiveDestination, effective);

    assert.equal(observed.length, 1);
    const run = observed[0]!;
    const request = run.request;
    assert.ok(request !== null);
    assert.ok(run.argv.some((token) => token === `--key=${key}`));
    assert.equal("key" in request, false);
    assert.equal(JSON.stringify(request).includes(key), false);
    assert.deepEqual(request.inputs, [value.input]);
    assert.equal(request.output, effective);
    assert.deepEqual(request.locales, ["zh"]);
    assert.deepEqual(request.translations[0].columns, ["en", "key", "zh"]);
    assert.deepEqual(request.translations[0].rows, [
      ["Hello", "HELLO", "第一行\n第二行"],
    ]);

    // The prepared copy is the original bytes minus only the initial BOM.
    const preparedPath = String(request.translations[0].csv);
    const preparedBytes = await readFile(preparedPath);
    assert.deepEqual(preparedBytes, originalBytes.subarray(3));
    assert.equal((await readFile(priorExportCsv)).equals(originalBytes), true);
    assert.equal(await readFile(value.input, "utf8"), "authored package bytes");

    const data = result.semantic.data;
    assert.ok(data !== null && "localeSelection" in data && "preparedCsvs" in data);
    assert.equal(data.completeness, "complete");
    assert.equal(data.outputPath, effective);
    assert.deepEqual(data.localeSelection, { mode: "explicit", locales: ["zh"] });
    assert.equal(data.counts.mappings, 1);
    assert.equal(data.counts.outputs, 1);
    assert.equal(data.counts.verifiedResources, 1);
    assert.equal(data.counts.verifiedTexts, 1);
    assert.equal(data.counts.preparedCsvs, 1);
    assert.equal(data.preparedCsvs.items[0]!.bomNormalized, true);
    assert.ok(
      data.diagnostics.some((line) => /initial UTF-8 BOM/u.test(line)),
    );
    assert.ok(
      data.diagnostics.some((line) => /CRLF input was preserved/u.test(line)),
    );

    const manifest = JSON.parse(
      await readFile(result.paths.manifest!, "utf8"),
    ) as AnyRecord;
    assert.ok(manifest.invocation.argv.includes("--key=<redacted>"));
    assert.equal(JSON.stringify(manifest).includes(key), false);
    assert.deepEqual(manifest.effectiveParameters.key, { redacted: true });
    assert.deepEqual(manifest.effectiveParameters.translations, [
      { csv: priorExportCsv, resource: "res://translations.csv" },
    ]);
    const csvInput = (manifest.invocation.inputPaths as AnyRecord[]).find(
      (entry) => entry.role === "translation-csv",
    );
    assert.ok(csvInput !== undefined);
    assert.equal(csvInput.path, priorExportCsv);
    assert.equal(csvInput.sha256, sha256(originalBytes));
    assert.equal(manifest.translationPatch.schemaVersion, 1);
    assert.equal(manifest.translationPatch.mappings[0].keyIndex, 1);
    assert.ok(manifest.effects.reads.includes(priorExportCsv));
    for (const write of [
      preparedPath,
      path.join(result.paths.operation!, "translation-patch", "request.json"),
      path.join(result.paths.operation!, "translation-patch", "report.json"),
      path.join(result.paths.operation!, "translation-patch", "preparation.json"),
      path.join(result.paths.operation!, "translation-patch", "evidence.json"),
    ]) {
      assert.ok(manifest.effects.writes.includes(write), write);
    }

    const roles = new Map(
      (result.artifacts.items as AnyRecord[]).map((entry) => [
        entry.path,
        entry.role,
      ]),
    );
    assert.equal(
      roles.get(path.join(effective, "project.godot")),
      "accompanying",
    );
    assert.equal(
      roles.get(
        path.join(
          effective,
          ".godot",
          "imported",
          "translations.zh.translation",
        ),
      ),
      "translation-output",
    );
    assert.equal(result.artifacts.complete, true);

    const detail = JSON.parse(
      await readFile(
        path.join(result.paths.operation!, "translation-patch", "evidence.json"),
        "utf8",
      ),
    ) as AnyRecord;
    assert.equal(detail.completeness, "complete");
    assert.equal(detail.nativeReport.ok, true);
  } finally {
    await close(execution, value.root);
  }
});

test("native new-locale omission derives outputs without inventing all locales", async () => {
  const value = await fixture();
  const csv = path.join(value.csvDirectory, "omission.csv");
  await writeCsv(csv, "key,en,fr\nHELLO,Hello,Bonjour\nKEEP,Keep,garder\n");
  const { execution, observed } = openExecution(value.root, {
    report: nativeSuccessReport,
  });
  try {
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "omission out",
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    assert.deepEqual(observed[0]!.request?.locales, []);
    const data = result.semantic.data;
    assert.ok(data !== null && "localeSelection" in data && "preparedCsvs" in data);
    assert.deepEqual(data.localeSelection, {
      mode: "new-locales-only",
      locales: ["fr"],
    });
    assert.equal(data.counts.verifiedTexts, 2);
  } finally {
    await close(execution, value.root);
  }
});

const nativeFailureReport = (context: {
  readonly request: AnyRecord;
  readonly effectiveOutput: string;
  readonly environment: NodeJS.ProcessEnv;
}): AnyRecord => {
  const translation = (context.request.translations as AnyRecord[])[0]!;
  const member = "res://.godot/imported/partial.translation";
  const acquiredPath = path.join(
    context.effectiveOutput,
    ".godot",
    "imported",
    "partial.translation",
  );
  return {
    version: 1,
    ok: false,
    stage: "verify",
    error: "native patch did not create an expected translation output",
    nativeCode: -1,
    output: context.effectiveOutput,
    userData: path.join(
      String(context.environment.APPDATA),
      "Godot",
      "app_userdata",
      "Godot RE Tools",
    ),
    temp: String(context.environment.TEMP),
    mappings: [
      {
        resource: translation.resource,
        csv: translation.csv,
        defaultLocale: "en",
        locales: ["zh"],
      },
    ],
    fileMap: { [acquiredPath]: member },
    outputs: [],
    projectConfig: null,
  };
};

const nativePartialFailureReport = (context: {
  readonly request: AnyRecord;
  readonly effectiveOutput: string;
  readonly environment: NodeJS.ProcessEnv;
}): AnyRecord => {
  const translation = (context.request.translations as AnyRecord[])[0]!;
  const member = "res://.godot/imported/translations.zh.translation";
  const acquiredPath = path.join(
    context.effectiveOutput,
    ".godot",
    "imported",
    "translations.zh.translation",
  );
  return {
    version: 1,
    ok: false,
    stage: "verify",
    error: "native project configuration output was not created",
    nativeCode: -1,
    output: context.effectiveOutput,
    userData: path.join(
      String(context.environment.APPDATA),
      "Godot",
      "app_userdata",
      "Godot RE Tools",
    ),
    temp: String(context.environment.TEMP),
    mappings: [
      {
        resource: translation.resource,
        csv: translation.csv,
        defaultLocale: "en",
        locales: ["zh"],
      },
    ],
    fileMap: { [acquiredPath]: member },
    outputs: [
      {
        resource: translation.resource,
        member,
        path: acquiredPath,
        locale: "zh",
        class: "OptimizedTranslation",
        bytes: 12,
        sha256: "a".repeat(64),
        verifiedTexts: 1,
        retainedContentVerified: true,
      },
    ],
    projectConfig: null,
  };
};

test("missing, malformed, contradictory and structured-failure reports never succeed", async () => {
  const cases: readonly {
    readonly label: string;
    readonly scenario: PatchScenario;
    readonly code: "semantic_failed" | "semantic_unknown";
    readonly completeness: string;
    readonly expectDetail: boolean;
    readonly skipInventory: boolean;
    readonly expectPartial?: boolean;
    readonly expectUnverified?: boolean;
  }[] = [
    {
      label: "missing report",
      scenario: { report: () => "missing" },
      code: "semantic_unknown",
      completeness: "unknown",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "malformed report",
      scenario: { report: () => "malformed" },
      code: "semantic_unknown",
      completeness: "unknown",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "structured native failure",
      scenario: { report: nativeFailureReport },
      code: "semantic_failed",
      completeness: "partial",
      expectDetail: true,
      skipInventory: true,
      expectUnverified: true,
    },
    {
      label: "structured native failure with acquired partial outputs",
      scenario: { report: nativePartialFailureReport },
      code: "semantic_failed",
      completeness: "partial",
      expectDetail: true,
      skipInventory: true,
      expectPartial: true,
    },
    {
      label: "ok:true with contradictory nativeCode",
      scenario: {
        report: async (context) => ({
          ...(await nativeSuccessReport(context)),
          nativeCode: 9,
        }),
      },
      code: "semantic_unknown",
      completeness: "unknown",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "ok:true with a general ERROR diagnostic",
      scenario: {
        report: nativeSuccessReport,
        stderr: 'ERROR: Condition "res != 0" is true.\n',
      },
      code: "semantic_unknown",
      completeness: "unknown",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "outside destination output",
      scenario: {
        report: async (context) => {
          const report = await nativeSuccessReport(context);
          const output = (report.outputs as AnyRecord[])[0]!;
          output.path = path.join(context.environment.TEMP ?? "", "escape.translation");
          return report;
        },
      },
      code: "semantic_failed",
      completeness: "failed",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "contradictory member and physical path",
      scenario: {
        report: async (context) => {
          const report = await nativeSuccessReport(context);
          const output = (report.outputs as AnyRecord[])[0]!;
          output.member = "res://.godot/imported/other.translation";
          report.fileMap[output.path] = output.member;
          return report;
        },
      },
      code: "semantic_failed",
      completeness: "failed",
      expectDetail: false,
      skipInventory: true,
    },
    {
      label: "report hash disagrees with inventory",
      scenario: {
        report: async (context) => {
          const report = await nativeSuccessReport(context);
          const output = (report.outputs as AnyRecord[])[0]!;
          output.sha256 = "0".repeat(64);
          return report;
        },
      },
      code: "semantic_unknown",
      completeness: "unknown",
      expectDetail: false,
      skipInventory: false,
    },
  ];

  for (const [caseIndex, scenario] of cases.entries()) {
    const value = await fixture();
    const { execution, observed } = openExecution(value.root, scenario.scenario);
    try {
      const csv = path.join(value.csvDirectory, "translations.csv");
      await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
      const original = await readFile(csv);
      const result = await execution.execute(
        "patch-translations",
        {
          inputs: [{ kind: "path", path: value.input }],
          translations: [{ csv, resource: "res://translations.csv" }],
          output: `case ${String(caseIndex)} out`,
          locales: ["zh"],
        },
        { signal: new AbortController().signal },
      );
      assert.equal(result.success, false, scenario.label);
      assert.equal(result.status, "failed", scenario.label);
      assert.equal(result.error?.code, scenario.code, scenario.label);
      assert.equal(result.semantic.status, scenario.code === "semantic_failed" ? "failed" : "unknown", scenario.label);
      const data = result.semantic.data;
      assert.ok(
        data !== null && "localeSelection" in data && "preparedCsvs" in data,
        scenario.label,
      );
      assert.equal(data.completeness, scenario.completeness, scenario.label);
      assert.equal(observed.length, 1, scenario.label);
      assert.equal((await readFile(csv)).equals(original), true, scenario.label);
      if (scenario.skipInventory) {
        assert.equal(result.artifacts.count, 0, scenario.label);
        assert.equal(result.artifacts.complete, false, scenario.label);
      }
      if (scenario.expectUnverified) {
        assert.equal(data.counts.outputs, 0, scenario.label);
        assert.equal(data.counts.unverifiedFiles, 1, scenario.label);
        assert.equal(data.counts.verifiedResources, 0, scenario.label);
        assert.equal(data.counts.verifiedTexts, 0, scenario.label);
        assert.equal(data.samples.unverifiedFiles.length, 1, scenario.label);
        assert.equal(
          path.normalize(data.samples.unverifiedFiles[0]!),
          path.normalize(
            path.join(
              result.paths.effectiveDestination!,
              ".godot",
              "imported",
              "partial.translation",
            ),
          ),
          scenario.label,
        );
      }
      if (scenario.expectPartial) {
        assert.equal(data.counts.outputs, 1, scenario.label);
        assert.equal(data.counts.unverifiedFiles, 0, scenario.label);
        assert.equal(data.counts.verifiedResources, 1, scenario.label);
        assert.equal(data.counts.verifiedTexts, 1, scenario.label);
        assert.equal(data.samples.outputs.length, 1, scenario.label);
        assert.equal(data.samples.unverifiedFiles.length, 0, scenario.label);
      }

      const detailPath = path.join(
        result.paths.operation!,
        "translation-patch",
        "evidence.json",
      );
      const detail = JSON.parse(await readFile(detailPath, "utf8")) as AnyRecord;
      assert.equal(detail.completeness, scenario.completeness, scenario.label);
      if (scenario.expectDetail) {
        assert.equal(detail.nativeReport.ok, false, scenario.label);
        assert.ok(detail.fileMap.length > 0, scenario.label);
        if (scenario.expectPartial) {
          assert.equal(detail.inventoryAudited, false, scenario.label);
          assert.equal(detail.outputs.length, 1, scenario.label);
          assert.equal(
            detail.outputs[0].retainedContentVerified,
            true,
            scenario.label,
          );
        }
      }
    } finally {
      await close(execution, value.root);
    }
  }
});

test("unreadable complete stream evidence never counts as no contradiction", async () => {
  const value = await fixture();
  const { execution } = openExecution(value.root, {
    report: nativeSuccessReport,
    removeStdoutEvidence: true,
  });
  try {
    const csv = path.join(value.csvDirectory, "translations.csv");
    await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "unreadable stream out",
        locales: ["zh"],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "semantic_unknown");
    assert.equal(result.semantic.status, "unknown");
    assert.match(
      result.semantic.summary,
      /retained stdout\/stderr evidence could not be read/iu,
    );
    const data = result.semantic.data;
    assert.ok(data !== null && "localeSelection" in data && "preparedCsvs" in data);
    assert.equal(data.completeness, "unknown");
    // The report inventory is skipped when complete stream evidence is
    // unreadable, even though the fake runner wrote destination files.
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, false);
    const detail = JSON.parse(
      await readFile(
        path.join(
          result.paths.operation!,
          "translation-patch",
          "evidence.json",
        ),
        "utf8",
      ),
    ) as AnyRecord;
    assert.equal(detail.completeness, "unknown");
  } finally {
    await close(execution, value.root);
  }
});

test("preparation evidence redacts a supplied key appearing in a CSV filename", async () => {
  const value = await fixture();
  const csv = path.join(value.csvDirectory, `${key}.csv`);
  await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
  const { execution } = openExecution(value.root, {
    report: nativeSuccessReport,
  });
  try {
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "redaction out",
        locales: ["zh"],
        key,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    const preparation = await readFile(
      path.join(
        result.paths.operation!,
        "translation-patch",
        "preparation.json",
      ),
      "utf8",
    );
    assert.equal(preparation.includes(key), false);
    assert.match(preparation, /<redacted>/u);
    assert.match(preparation, /0\.csv/u);
    const semanticData = result.semantic.data;
    assert.ok(
      semanticData !== null &&
        "localeSelection" in semanticData &&
        "preparedCsvs" in semanticData,
    );
    const ordinaryOriginal = semanticData.preparedCsvs.items[0]!.original;
    assert.equal(ordinaryOriginal.includes(key), false);
    assert.match(ordinaryOriginal, /<redacted>/u);

    // The request stays operationally exact and key-free; the prepared copy is
    // readable by the fixed script.
    const request = JSON.parse(
      await readFile(
        path.join(result.paths.operation!, "translation-patch", "request.json"),
        "utf8",
      ),
    ) as AnyRecord;
    assert.equal("key" in request, false);
    assert.equal(JSON.stringify(request).includes(key), false);
    assert.equal(
      await readFile(String(request.translations[0].csv), "utf8"),
      "key,en,zh\nHELLO,Hello,你好\n",
    );
    const manifest = await readFile(result.paths.manifest!, "utf8");
    assert.equal(manifest.includes(key), false);
  } finally {
    await close(execution, value.root);
  }
});

test("the known synthetic-profile diagnostic pair remains exempt", async () => {
  const value = await fixture();
  const synthetic = [
    'ERROR: Condition "res != ((HRESULT)0L)" is true.',
    "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
    "",
  ].join("\n");
  const { execution } = openExecution(value.root, {
    report: nativeSuccessReport,
    stderr: synthetic,
  });
  try {
    const csv = path.join(value.csvDirectory, "translations.csv");
    await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "synthetic out",
        locales: ["zh"],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
  } finally {
    await close(execution, value.root);
  }
});

test("empty replacement text and sentinel-looking message content are admissible", async () => {
  const value = await fixture();
  const csv = path.join(value.csvDirectory, "empty.csv");
  await writeCsv(
    csv,
    "key,en,zh\nEMPTY,Text,\nLOOK,<!MissingKey:not-a-placeholder>,保留\n",
  );
  const { execution, observed } = openExecution(value.root, {
    report: nativeSuccessReport,
  });
  try {
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "empty out",
        locales: ["zh"],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(
      result.success,
      true,
      JSON.stringify({ error: result.error, semantic: result.semantic }),
    );
    const request = observed[0]!.request!;
    assert.deepEqual(request.translations[0].rows, [
      ["EMPTY", "Text", ""],
      ["LOOK", "<!MissingKey:not-a-placeholder>", "保留"],
    ]);
  } finally {
    await close(execution, value.root);
  }
});

test("timeout stop preserves original inputs and skips report evaluation", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, {
    exitCode: null,
    trigger: "timeout",
  });
  try {
    const csv = path.join(value.csvDirectory, "translations.csv");
    await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
    const original = await readFile(csv);
    const started = Date.now();
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "timeout out",
        locales: ["zh"],
        timeoutMs: 30_000,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error?.code, "execution_timeout");
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.semantic.data, null);
    assert.equal(result.artifacts.complete, false);
    assert.equal(observed.length, 1);
    assert.equal((await readFile(csv)).equals(original), true);
    assert.ok(Date.now() - started >= 0);
    // The operation-owned prepared copy is retained for diagnosis.
    const prepared = path.join(
      result.paths.operation!,
      "translation-patch",
      "prepared",
      "0.csv",
    );
    assert.equal(await readFile(prepared, "utf8"), "key,en,zh\nHELLO,Hello,你好\n");
  } finally {
    await close(execution, value.root);
  }
});

test("cancellation stop reuses the shared owned-process lifecycle", async () => {
  const value = await fixture();
  const { execution, observed } = openExecution(value.root, {
    exitCode: null,
    trigger: "cancel",
  });
  try {
    const csv = path.join(value.csvDirectory, "translations.csv");
    await writeCsv(csv, "key,en,zh\nHELLO,Hello,你好\n");
    const original = await readFile(csv);
    const result = await execution.execute(
      "patch-translations",
      {
        inputs: [{ kind: "path", path: value.input }],
        translations: [{ csv, resource: "res://translations.csv" }],
        output: "cancel out",
        locales: ["zh"],
      },
      { signal: new AbortController().signal },
    );
    assert.equal(result.success, false);
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "cancelled");
    assert.equal(result.semantic.status, "not_evaluated");
    assert.equal(result.semantic.data, null);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, "cancel");
    assert.equal(observed.length, 1);
    assert.equal((await readFile(csv)).equals(original), true);
  } finally {
    await close(execution, value.root);
  }
});
