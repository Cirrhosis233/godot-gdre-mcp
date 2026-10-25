import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { openExecution } from "../../src/execution.js";
import {
  NodeProcessRunner,
  type ProcessRunOptions,
  type ProcessRunResult,
  type ProcessRunner,
  type StreamSummaryValue,
} from "../../src/process.js";
import { serveStdioConnection } from "../../src/stdio.js";

/**
 * Controlled package-patch fault support for the existing Execution/ProcessRunner
 * seam. This substitutes the fixed runtime at the owned-launch boundary: it
 * dispatches on the fixed inspector argv versus the direct patch argv and writes
 * immediately authored report observations. It imports no native/fixture helper
 * from the pending native branch and makes no real patch-success claim.
 */

export const PCK_PATCH_INSPECTOR_FILE = "gdre-pck-inspect.gd";
export const PCK_PATCH_DEFAULT_OUTPUT_BYTES = Buffer.from(
  "authored output package bytes\n",
  "utf8",
);

export interface PckPatchReportMember {
  readonly logicalMember: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PckPatchInspectorReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly packagePath: string;
  readonly metadata?: {
    readonly formatVersion: number;
    readonly engineVersion: {
      readonly major: number;
      readonly minor: number;
      readonly patch: number;
    };
    readonly encrypted: boolean;
  };
  readonly members?: readonly PckPatchReportMember[];
  readonly error: string | null;
}

export type PckPatchReportDelivery =
  | PckPatchInspectorReport
  | "missing"
  | "malformed";

export type CombinedReportDelivery =
  | Record<string, unknown>
  | "missing"
  | "malformed";

export type PckPatchInspectionKind = "source-inspection" | "output-inspection";
export type PckPatchCombinedKind =
  | "combined-preparation"
  | "combined-verification";

export const PCK_PATCH_COMBINED_PREPARE_FILE = "gdre-pck-combined-prepare.gd";
export const PCK_PATCH_COMBINED_VERIFY_FILE = "gdre-pck-combined-verify.gd";

export interface PckPatchFaultContext {
  readonly kind: PckPatchInspectionKind | PckPatchCombinedKind | "patch";
  readonly argv: readonly string[];
  readonly packagePath: string | null;
  readonly reportPath: string | null;
  readonly requestPath: string | null;
  readonly sourcePath: string | null;
  readonly outputPath: string | null;
  readonly environment: NodeJS.ProcessEnv;
}

export interface PckPatchPatchOutcome {
  readonly exitCode?: number | null;
  readonly trigger?: ProcessRunResult["trigger"];
  readonly stdout?: string;
  readonly stderr?: string;
  /** Defaults to true for a natural exit 0; successful tests provide bytes. */
  readonly writeOutput?: boolean;
  readonly outputBytes?: Buffer | string;
  readonly removeOutputAfterWrite?: boolean;
  readonly spawnError?: ProcessRunResult["spawnError"];
  readonly captureIncomplete?: boolean;
  readonly cleanup?: ProcessRunResult["cleanup"];
}

export interface PckPatchInspectionOutcome {
  readonly exitCode?: number | null;
  readonly trigger?: ProcessRunResult["trigger"];
  readonly delivery?: PckPatchReportDelivery | CombinedReportDelivery;
  readonly captureIncomplete?: boolean;
  readonly cleanup?: ProcessRunResult["cleanup"];
}

export interface PckPatchScenario {
  readonly sourceReport: (
    context: PckPatchFaultContext,
  ) => PckPatchReportDelivery | Promise<PckPatchReportDelivery>;
  readonly outputReport: (
    context: PckPatchFaultContext,
  ) => PckPatchReportDelivery | Promise<PckPatchReportDelivery>;
  readonly patch?: (
    context: PckPatchFaultContext,
  ) => PckPatchPatchOutcome | Promise<PckPatchPatchOutcome>;
  /** Runs inside the source-inspection launch after the report is delivered. */
  readonly afterSourceInspection?: (context: PckPatchFaultContext) => Promise<void>;
  /** Controlled terminal observation for either inspector launch. */
  readonly inspectionOutcome?: (
    context: PckPatchFaultContext,
  ) => PckPatchInspectionOutcome;
  /** Optional concurrent-call-safe dispatch override. */
  readonly inspectionKind?: (
    context: PckPatchFaultContext,
  ) => PckPatchInspectionKind;
  /** Fixed combined preparation report; absence is a missing report. */
  readonly combinedPreparationReport?: (
    context: PckPatchFaultContext,
  ) => CombinedReportDelivery | Promise<CombinedReportDelivery>;
  /** Fixed combined verification report; absence is a missing report. */
  readonly combinedVerificationReport?: (
    context: PckPatchFaultContext,
  ) => CombinedReportDelivery | Promise<CombinedReportDelivery>;
  /** Controlled terminal observation for either combined script launch. */
  readonly combinedPreparationOutcome?: (
    context: PckPatchFaultContext,
  ) => PckPatchInspectionOutcome;
  readonly combinedVerificationOutcome?: (
    context: PckPatchFaultContext,
  ) => PckPatchInspectionOutcome;
  /** Runs after the combined preparation report is delivered. */
  readonly afterCombinedPreparation?: (
    context: PckPatchFaultContext,
  ) => Promise<void>;
  /** Runs after the combined verification report is delivered. */
  readonly afterCombinedVerification?: (
    context: PckPatchFaultContext,
  ) => Promise<void>;
}

export interface PckPatchFaultHarness {
  readonly runner: ProcessRunner;
  readonly observed: readonly PckPatchFaultContext[];
}

const stream = (
  options: ProcessRunOptions,
  kind: "stdout" | "stderr",
  text: string,
  complete: boolean,
): StreamSummaryValue => ({
  bytes: Buffer.byteLength(text, "utf8"),
  text,
  truncated: false,
  utf8Valid: true,
  rawPath:
    kind === "stdout" ? options.streamPaths.stdoutBin : options.streamPaths.stderrBin,
  textPath:
    kind === "stdout" ? options.streamPaths.stdoutText : options.streamPaths.stderrText,
  complete,
});

const valueAfter = (argv: readonly string[], prefix: string): string | null => {
  const token = argv.find((entry) => entry.startsWith(prefix));
  return token === undefined ? null : token.slice(prefix.length);
};

export function createPckPatchFaultRunner(
  scenario: PckPatchScenario,
): PckPatchFaultHarness {
  const observed: PckPatchFaultContext[] = [];
  let inspectionCount = 0;

  const completed = (
    options: ProcessRunOptions,
    fields: {
      readonly exitCode: number | null;
      readonly trigger: ProcessRunResult["trigger"];
      readonly stdout: string;
      readonly stderr: string;
      readonly stdoutComplete?: boolean;
      readonly stderrComplete?: boolean;
      readonly spawnError?: ProcessRunResult["spawnError"];
      readonly cleanup?: ProcessRunResult["cleanup"];
    },
  ): ProcessRunResult => {
    const terminated = fields.exitCode === null;
    return {
      pid: 500 + observed.length,
      exitCode: fields.exitCode,
      signal: null,
      spawnError: fields.spawnError ?? null,
      timedOut: fields.trigger === "timeout",
      trigger: fields.trigger,
      exitObserved: !terminated,
      spawnedAt: new Date().toISOString(),
      spawnedAtMono: performance.now(),
      exitedAt: terminated ? null : new Date().toISOString(),
      exitedAtMono: terminated ? null : performance.now() + 1,
      stdout: stream(
        options,
        "stdout",
        fields.stdout,
        fields.stdoutComplete ?? true,
      ),
      stderr: stream(
        options,
        "stderr",
        fields.stderr,
        fields.stderrComplete ?? true,
      ),
      stdoutText: fields.stdout,
      stderrText: fields.stderr,
      ownership: null,
      cleanup:
        fields.cleanup ??
        (terminated
          ? {
              state: "confirmed",
              trigger: fields.trigger,
              actions: ["controlled fault harness terminated the owned tree"],
              error: null,
            }
          : { state: "not_needed", trigger: null, actions: [], error: null }),
      captureError: null,
      storageError: null,
      error: null,
    };
  };

  const runner: ProcessRunner = {
    async run(options): Promise<ProcessRunResult> {
      const scriptIndex = options.argv.indexOf("--script");
      const script =
        scriptIndex >= 0 ? options.argv[scriptIndex + 1] : undefined;
      const combinedKind: PckPatchCombinedKind | null =
        script !== undefined && script.endsWith(PCK_PATCH_COMBINED_PREPARE_FILE)
          ? "combined-preparation"
          : script !== undefined &&
              script.endsWith(PCK_PATCH_COMBINED_VERIFY_FILE)
            ? "combined-verification"
            : null;
      if (combinedKind !== null) {
        const separator = options.argv.indexOf("--");
        const requestPath =
          separator >= 0 ? options.argv[separator + 1] : undefined;
        const reportPath =
          separator >= 0 ? options.argv[separator + 2] : undefined;
        if (requestPath === undefined || reportPath === undefined) {
          throw new Error(
            "controlled combined launch did not carry request/report arguments",
          );
        }
        const context: PckPatchFaultContext = {
          kind: combinedKind,
          argv: [...options.argv],
          packagePath: null,
          reportPath,
          requestPath,
          sourcePath: null,
          outputPath: null,
          environment: options.env,
        };
        observed.push(context);
        const outcome =
          combinedKind === "combined-preparation"
            ? (scenario.combinedPreparationOutcome?.(context) ?? {})
            : (scenario.combinedVerificationOutcome?.(context) ?? {});
        const delivery =
          outcome.delivery ??
          (combinedKind === "combined-preparation"
            ? await scenario.combinedPreparationReport?.(context)
            : await scenario.combinedVerificationReport?.(context)) ??
          "missing";
        if (delivery === "malformed") {
          await writeFile(reportPath, "{not valid json", "utf8");
        } else if (delivery !== "missing") {
          await writeFile(reportPath, JSON.stringify(delivery), "utf8");
        }
        if (combinedKind === "combined-preparation") {
          await scenario.afterCombinedPreparation?.(context);
        } else {
          await scenario.afterCombinedVerification?.(context);
        }
        await options.sink?.append("stdout", Buffer.alloc(0), "");
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        return completed(options, {
          exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode,
          trigger: outcome.trigger ?? null,
          stdout: "",
          stderr: "",
          stdoutComplete: outcome.captureIncomplete !== true,
          stderrComplete: outcome.captureIncomplete !== true,
          cleanup: outcome.cleanup,
        });
      }
      if (script !== undefined && script.endsWith(PCK_PATCH_INSPECTOR_FILE)) {
        const separator = options.argv.indexOf("--");
        const reportPath =
          separator >= 0 ? options.argv[separator + 1] : undefined;
        const packagePath =
          separator >= 0 ? options.argv[separator + 2] : undefined;
        if (reportPath === undefined || packagePath === undefined) {
          throw new Error("controlled inspector launch did not carry report/package arguments");
        }
        const baseContext = {
          argv: [...options.argv],
          packagePath,
          reportPath,
          requestPath: null,
          sourcePath: null,
          outputPath: null,
          environment: options.env,
        };
        const kind: PckPatchInspectionKind =
          scenario.inspectionKind?.({ kind: "source-inspection", ...baseContext }) ??
          (inspectionCount === 0 ? "source-inspection" : "output-inspection");
        inspectionCount += 1;
        const context: PckPatchFaultContext = { kind, ...baseContext };
        observed.push(context);
        const outcome = scenario.inspectionOutcome?.(context) ?? {};
        const delivery =
          outcome.delivery ??
          (kind === "source-inspection"
            ? await scenario.sourceReport(context)
            : await scenario.outputReport(context));
        if (delivery === "malformed") {
          await writeFile(reportPath, "{not valid json", "utf8");
        } else if (delivery !== "missing") {
          await writeFile(reportPath, JSON.stringify(delivery), "utf8");
        }
        if (kind === "source-inspection") {
          await scenario.afterSourceInspection?.(context);
        }
        await options.sink?.append("stdout", Buffer.alloc(0), "");
        await options.sink?.append("stderr", Buffer.alloc(0), "");
        await options.sink?.close();
        return completed(options, {
          exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode,
          trigger: outcome.trigger ?? null,
          stdout: "",
          stderr: "",
          stdoutComplete: outcome.captureIncomplete !== true,
          stderrComplete: outcome.captureIncomplete !== true,
        });
      }

      const sourcePath = valueAfter(options.argv, "--pck-patch=");
      if (sourcePath !== null) {
        const outputPath = valueAfter(options.argv, "--output=");
        if (outputPath === null) {
          throw new Error("controlled patch launch did not carry an explicit output");
        }
        const context: PckPatchFaultContext = {
          kind: "patch",
          argv: [...options.argv],
          packagePath: null,
          reportPath: null,
          requestPath: null,
          sourcePath,
          outputPath,
          environment: options.env,
        };
        observed.push(context);
        const outcome = (await scenario.patch?.(context)) ?? {};
        const exitCode = outcome.exitCode === undefined ? 0 : outcome.exitCode;
        const trigger = outcome.trigger ?? null;
        const stdout = outcome.stdout ??
          `\rPatched PCK file: ${outputPath}\n`;
        const stderr = outcome.stderr ?? "";
        if (
          outcome.writeOutput !== false &&
          (exitCode === 0 || outcome.outputBytes !== undefined)
        ) {
          await writeFile(
            outputPath,
            outcome.outputBytes ?? PCK_PATCH_DEFAULT_OUTPUT_BYTES,
          );
        }
        if (outcome.removeOutputAfterWrite === true) {
          await rm(outputPath, { force: true });
        }
        await options.sink?.append(
          "stdout",
          Buffer.from(stdout, "utf8"),
          stdout,
        );
        await options.sink?.append(
          "stderr",
          Buffer.from(stderr, "utf8"),
          stderr,
        );
        await options.sink?.close();
        return completed(options, {
          exitCode,
          trigger,
          stdout,
          stderr,
          stdoutComplete: outcome.captureIncomplete !== true,
          stderrComplete: outcome.captureIncomplete !== true,
          spawnError: outcome.spawnError,
          cleanup: outcome.cleanup,
        });
      }

      throw new Error(
        `controlled fault harness received an unexpected launch: ${options.argv.join(" ")}`,
      );
    },
  };

  return { runner, observed };
}

/* ------------------------------------------------------------------------- *
 * Production stdio launcher
 *
 * The stdio acceptance test spawns this built module as a dedicated test
 * server. It opens the production Execution with the same ProcessRunner seam
 * used above, but every substituted launch is a real owned Node process, so
 * the actual Job Object launch/cleanup path is exercised. Scenario data and
 * launch records live only in the test control directory; no production switch
 * or caller-controlled script option is added.
 * ------------------------------------------------------------------------- */

export const PCK_PATCH_STDIO_CONTROL_ENV = "GDRE_MCP_PCK_PATCH_FAULT_DIR";
export const PCK_PATCH_STDIO_INSTALLATION_ENV =
  "GDRE_MCP_PCK_PATCH_INSTALLATION_ROOT";
export const PCK_PATCH_PACKAGE_PATH_TOKEN = "<PACKAGE_PATH>";

export interface PckPatchStdioPatchScenario {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly writeOutput?: boolean;
  readonly outputBytesBase64?: string;
  readonly writeTemporary?: boolean;
  /** Emit the success marker with forward slashes, as native GDRE does. */
  readonly nativeForwardSlashMarker?: boolean;
  /** Write partial output, then stay alive until owned cleanup terminates it. */
  readonly holdUntilKilled?: boolean;
  readonly delayMs?: number;
}

export interface PckPatchStdioInspectionScenario {
  readonly delivery?: PckPatchReportDelivery;
  readonly exitCode?: number;
  /** Write the report, then stay alive until owned cleanup terminates it. */
  readonly holdUntilKilled?: boolean;
  /** Remove the inspected package after delivering the report. */
  readonly removePackageAfterReport?: boolean;
}

export interface PckPatchStdioCombinedScenario {
  readonly delivery?: CombinedReportDelivery;
  readonly exitCode?: number;
  /** Write the report, then stay alive until owned cleanup terminates it. */
  readonly holdUntilKilled?: boolean;
}

export interface PckPatchStdioScenario {
  readonly sourceReport?: PckPatchReportDelivery;
  readonly outputReport?: PckPatchReportDelivery;
  readonly sourceInspection?: PckPatchStdioInspectionScenario;
  readonly outputInspection?: PckPatchStdioInspectionScenario;
  readonly combinedPreparation?: PckPatchStdioCombinedScenario;
  readonly combinedVerification?: PckPatchStdioCombinedScenario;
  readonly patch?: PckPatchStdioPatchScenario;
}

export interface PckPatchStdioLaunch {
  readonly sequence: number;
  readonly kind:
    | "startup"
    | "source-inspection"
    | "output-inspection"
    | "combined-preparation"
    | "combined-verification"
    | "patch"
    | "other";
  readonly argv: readonly string[];
  readonly packagePath: string | null;
  readonly reportPath: string | null;
  readonly outputPath: string | null;
  readonly cwd: string;
}

export async function writePckPatchStdioScenario(
  controlDirectory: string,
  scenario: PckPatchStdioScenario,
): Promise<void> {
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(
    path.join(controlDirectory, "scenario.json"),
    JSON.stringify(scenario),
    "utf8",
  );
}

export async function readPckPatchStdioLaunches(
  controlDirectory: string,
): Promise<PckPatchStdioLaunch[]> {
  let names: string[];
  try {
    names = await readdir(controlDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const launches: PckPatchStdioLaunch[] = [];
  for (const name of names
    .filter((entry) => /^launch-\d+\.json$/u.test(entry))
    .sort()) {
    try {
      launches.push(
        JSON.parse(
          await readFile(path.join(controlDirectory, name), "utf8"),
        ) as PckPatchStdioLaunch,
      );
    } catch {
      // A record that is still being written is observed by the next poll.
    }
  }
  return launches;
}

const quoteJs = (value: string): string => JSON.stringify(value);

const materialize = (value: unknown, packagePath: string): unknown => {
  if (typeof value === "string") {
    return value.split(PCK_PATCH_PACKAGE_PATH_TOKEN).join(packagePath);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materialize(entry, packagePath));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = materialize(entry, packagePath);
    }
    return result;
  }
  return value;
};

const versionScript = (statusPath: string): string =>
  [
    "const fs = require('node:fs');",
    `const statusPath = ${quoteJs(statusPath)};`,
    "function waitForOwnership() {",
    "  try {",
    "    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));",
    "    if (status.state === 'monitoring' && status.attach?.success === true) {",
    "      process.stdout.write('Godot RE Tools v2.8.0-beta.2\\r\\n');",
    "      process.exit(1);",
    "    }",
    "  } catch {}",
    "  setTimeout(waitForOwnership, 10);",
    "}",
    "waitForOwnership();",
  ].join("\n");

const inspectorScript = (
  reportPath: string,
  packagePath: string,
  delivery: PckPatchReportDelivery,
  exitCode: number,
  holdUntilKilled: boolean,
  removePackageAfterReport: boolean,
): string => {
  const lines = ["const fs = require('node:fs');"];
  if (delivery === "malformed") {
    lines.push(`fs.writeFileSync(${quoteJs(reportPath)}, '{not valid json');`);
  } else if (delivery !== "missing") {
    lines.push(
      `fs.writeFileSync(${quoteJs(reportPath)}, ${quoteJs(JSON.stringify(delivery))});`,
    );
  }
  if (removePackageAfterReport) {
    lines.push(
      `try { fs.rmSync(${quoteJs(packagePath)}, { force: true }); } catch {}`,
    );
  }
  lines.push(
    holdUntilKilled
      ? "setInterval(() => {}, 1000);"
      : `process.exit(${exitCode});`,
  );
  return lines.join("\n");
};

const combinedScript = (
  reportPath: string,
  delivery: CombinedReportDelivery,
  exitCode: number,
  holdUntilKilled: boolean,
): string => {
  const lines = ["const fs = require('node:fs');"];
  if (delivery === "malformed") {
    lines.push(`fs.writeFileSync(${quoteJs(reportPath)}, '{not valid json');`);
  } else if (delivery !== "missing") {
    lines.push(
      `fs.writeFileSync(${quoteJs(reportPath)}, ${quoteJs(JSON.stringify(delivery))});`,
    );
  }
  lines.push(
    holdUntilKilled
      ? "setInterval(() => {}, 1000);"
      : `process.exit(${exitCode});`,
  );
  return lines.join("\n");
};

const patchScript = (
  outputPath: string,
  outcome: PckPatchStdioPatchScenario,
): string => {
  const exitCode = outcome.exitCode === undefined ? 0 : outcome.exitCode;
  const holdUntilKilled = outcome.holdUntilKilled === true;
  const writeOutput =
    outcome.writeOutput ?? (exitCode === 0 || holdUntilKilled);
  const bytes =
    outcome.outputBytesBase64 ??
    PCK_PATCH_DEFAULT_OUTPUT_BYTES.toString("base64");
  const markerPath =
    outcome.nativeForwardSlashMarker === true
      ? outputPath.replaceAll("\\", "/")
      : outputPath;
  const stdout =
    outcome.stdout ??
    (exitCode === 0 ? `\rPatched PCK file: ${markerPath}\n` : "");
  const stderr = outcome.stderr ?? "";
  const actions: string[] = [];
  if (writeOutput) {
    actions.push(
      `fs.mkdirSync(path.dirname(${quoteJs(outputPath)}), { recursive: true });`,
    );
    actions.push(
      `fs.writeFileSync(${quoteJs(outputPath)}, Buffer.from(${quoteJs(bytes)}, 'base64'));`,
    );
    if (outcome.writeTemporary === true) {
      actions.push(
        `fs.writeFileSync(${quoteJs(`${outputPath}.tmp`)}, 'partial temporary output');`,
      );
    }
  }
  if (stdout.length > 0) {
    actions.push(`process.stdout.write(${quoteJs(stdout)});`);
  }
  if (stderr.length > 0) {
    actions.push(`process.stderr.write(${quoteJs(stderr)});`);
  }
  actions.push(
    holdUntilKilled
      ? "setInterval(() => {}, 1000);"
      : `process.exit(${exitCode});`,
  );
  const body = actions.join("\n");
  const delayMs = outcome.delayMs ?? 0;
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    delayMs > 0
      ? `setTimeout(() => {\n${body}\n}, ${String(delayMs)});`
      : body,
  ].join("\n");
};

class PckPatchStdioFaultRunner implements ProcessRunner {
  private readonly delegate = new NodeProcessRunner();
  private sequence = 0;

  public constructor(private readonly controlDirectory: string) {}

  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const scenario = await this.readScenario();
    const startup = /[\\/]\.gdre[\\/]startup[\\/]/u.test(options.cwd);
    const scriptIndex = options.argv.indexOf("--script");
    const script =
      scriptIndex >= 0 ? options.argv[scriptIndex + 1] : undefined;
    const combinedKind: PckPatchCombinedKind | null =
      script !== undefined && script.endsWith(PCK_PATCH_COMBINED_PREPARE_FILE)
        ? "combined-preparation"
        : script !== undefined && script.endsWith(PCK_PATCH_COMBINED_VERIFY_FILE)
          ? "combined-verification"
          : null;
    if (!startup && combinedKind !== null) {
      const separator = options.argv.indexOf("--");
      const requestPath =
        separator >= 0 ? options.argv[separator + 1] : undefined;
      const reportPath =
        separator >= 0 ? options.argv[separator + 2] : undefined;
      if (requestPath === undefined || reportPath === undefined) {
        throw new Error(
          "controlled stdio combined launch did not carry request/report arguments",
        );
      }
      await this.record({
        kind: combinedKind,
        argv: options.argv,
        packagePath: null,
        reportPath,
        outputPath: null,
        cwd: options.cwd,
      });
      const override =
        combinedKind === "combined-preparation"
          ? scenario.combinedPreparation
          : scenario.combinedVerification;
      const delivery = materialize(
        override?.delivery ?? "missing",
        reportPath,
      ) as CombinedReportDelivery;
      return this.delegate.run({
        ...options,
        executable: process.execPath,
        argv: [
          "-e",
          combinedScript(
            reportPath,
            delivery,
            override?.exitCode ?? 0,
            override?.holdUntilKilled === true,
          ),
        ],
      });
    }
    if (
      !startup &&
      script !== undefined &&
      script.endsWith(PCK_PATCH_INSPECTOR_FILE)
    ) {
      const separator = options.argv.indexOf("--");
      const reportPath =
        separator >= 0 ? options.argv[separator + 1] : undefined;
      const packagePath =
        separator >= 0 ? options.argv[separator + 2] : undefined;
      if (reportPath === undefined || packagePath === undefined) {
        throw new Error(
          "controlled stdio inspector launch did not carry report/package arguments",
        );
      }
      const kind = /[\\/]pck-source-inspection[\\/]/u.test(reportPath)
        ? "source-inspection"
        : "output-inspection";
      await this.record({
        kind,
        argv: options.argv,
        packagePath,
        reportPath,
        outputPath: null,
        cwd: options.cwd,
      });
      const override =
        kind === "source-inspection"
          ? scenario.sourceInspection
          : scenario.outputInspection;
      const configured =
        override?.delivery ??
        (kind === "source-inspection"
          ? scenario.sourceReport
          : scenario.outputReport) ??
        "missing";
      const delivery = materialize(
        configured,
        packagePath,
      ) as PckPatchReportDelivery;
      const exitCode = override?.exitCode ?? 0;
      return this.delegate.run({
        ...options,
        executable: process.execPath,
        argv: [
          "-e",
          inspectorScript(
            reportPath,
            packagePath,
            delivery,
            exitCode,
            override?.holdUntilKilled === true,
            override?.removePackageAfterReport === true,
          ),
        ],
      });
    }

    const sourcePath = valueAfter(options.argv, "--pck-patch=");
    if (!startup && sourcePath !== null) {
      const outputPath = valueAfter(options.argv, "--output=");
      if (outputPath === null) {
        throw new Error(
          "controlled stdio patch launch did not carry an explicit output",
        );
      }
      await this.record({
        kind: "patch",
        argv: options.argv,
        packagePath: sourcePath,
        reportPath: null,
        outputPath,
        cwd: options.cwd,
      });
      return this.delegate.run({
        ...options,
        executable: process.execPath,
        argv: ["-e", patchScript(outputPath, scenario.patch ?? {})],
      });
    }

    if (!startup && script !== undefined) {
      await this.record({
        kind: "other",
        argv: options.argv,
        packagePath: null,
        reportPath: null,
        outputPath: null,
        cwd: options.cwd,
      });
      throw new Error(
        `controlled stdio fault harness received an unrecognized script launch: ${script}`,
      );
    }

    await this.record({
      kind: startup ? "startup" : "other",
      argv: options.argv,
      packagePath: null,
      reportPath: null,
      outputPath: null,
      cwd: options.cwd,
    });
    return this.delegate.run({
      ...options,
      executable: process.execPath,
      argv: ["-e", versionScript(options.statusPath)],
    });
  }

  private async readScenario(): Promise<PckPatchStdioScenario> {
    try {
      return JSON.parse(
        await readFile(
          path.join(this.controlDirectory, "scenario.json"),
          "utf8",
        ),
      ) as PckPatchStdioScenario;
    } catch {
      return {};
    }
  }

  private async record(
    launch: Omit<PckPatchStdioLaunch, "sequence">,
  ): Promise<void> {
    // Capture the call-local sequence before the first await so concurrent
    // launches cannot overwrite each other's record filename or payload.
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    await mkdir(this.controlDirectory, { recursive: true });
    await writeFile(
      path.join(
        this.controlDirectory,
        `launch-${String(sequence).padStart(4, "0")}.json`,
      ),
      JSON.stringify({ sequence, ...launch }),
      "utf8",
    );
  }
}

export async function runPckPatchStdioLauncher(): Promise<void> {
  const controlDirectory = process.env[PCK_PATCH_STDIO_CONTROL_ENV];
  const installationRoot = process.env[PCK_PATCH_STDIO_INSTALLATION_ENV];
  if (controlDirectory === undefined || installationRoot === undefined) {
    throw new Error(
      `${PCK_PATCH_STDIO_CONTROL_ENV} and ${PCK_PATCH_STDIO_INSTALLATION_ENV} are required`,
    );
  }
  const execution = await openExecution(installationRoot, {
    processRunner: new PckPatchStdioFaultRunner(controlDirectory),
  });
  const handle = serveStdioConnection(execution);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await handle.close("shutdown");
  };
  process.once("SIGINT", () => void shutdown().catch(() => undefined));
  process.once("SIGTERM", () => void shutdown().catch(() => undefined));
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  void runPckPatchStdioLauncher().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Package-patch fault launcher failed: ${message}\n`);
    process.exitCode = 1;
  });
}
