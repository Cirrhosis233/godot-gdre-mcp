import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  PCK_PATCH_DEFAULT_OUTPUT_BYTES,
  PCK_PATCH_INSPECTOR_FILE,
  PCK_PATCH_PACKAGE_PATH_TOKEN,
  PCK_PATCH_STDIO_CONTROL_ENV,
  PCK_PATCH_STDIO_INSTALLATION_ENV,
  readPckPatchStdioLaunches,
  writePckPatchStdioScenario,
  type PckPatchInspectorReport,
  type PckPatchStdioLaunch,
  type PckPatchStdioScenario,
} from "./support/pck-patch-faults.js";

/**
 * Production MCP/stdio package-patch acceptance with a controlled adapter.
 *
 * The dedicated test launcher runs the production Execution/stdio server and
 * substitutes only the runtime through the existing ProcessRunner seam. Every
 * substituted launch is still a real owned Node process, so the Job Object
 * launch/terminate path is exercised. Reports and package bytes here are
 * independently authored literals; this is adapter evidence, not real native
 * transaction success (09b/09d own that).
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const launcherPath = path.join(
  repositoryRoot,
  "dist",
  "test",
  "support",
  "pck-patch-faults.js",
);
const clientRequestOptions = { timeout: 120_000, maxTotalTimeout: 120_000 };
const MAX_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 5_000;

type AnyRecord = Record<string, any>;

const TARGET_MEMBER = "res://data/replace.txt";
const RETAINED_MEMBER = "res://data/keep.txt";

const SOURCE_BYTES = Buffer.from("GDPC controlled stdio source package\n", "utf8");
const ORIGINAL_TARGET = Buffer.from("controlled original target v1\n", "utf8");
const RETAINED_BYTES = Buffer.from(
  "controlled retained member bytes\n",
  "utf8",
);
const REPLACEMENT_BYTES = Buffer.concat([
  Buffer.from("controlled replacement v2:"),
  Buffer.from([0x00, 0x02, 0xfe]),
  Buffer.from(":end\n"),
]);
const OUTPUT_PACKAGE_BYTES = Buffer.from(
  "controlled stdio output package bytes\n",
  "utf8",
);

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

const sourceReport = (packagePath: string): PckPatchInspectorReport => ({
  schemaVersion: 1,
  ok: true,
  packagePath,
  metadata: {
    formatVersion: 2,
    engineVersion: { major: 4, minor: 4, patch: 0 },
    encrypted: false,
  },
  members: [
    {
      logicalMember: TARGET_MEMBER,
      size: ORIGINAL_TARGET.byteLength,
      sha256: sha256(ORIGINAL_TARGET),
    },
    {
      logicalMember: RETAINED_MEMBER,
      size: RETAINED_BYTES.byteLength,
      sha256: sha256(RETAINED_BYTES),
    },
  ],
  error: null,
});

const outputReport = (): PckPatchInspectorReport => ({
  schemaVersion: 1,
  ok: true,
  packagePath: PCK_PATCH_PACKAGE_PATH_TOKEN,
  metadata: {
    formatVersion: 2,
    engineVersion: { major: 4, minor: 4, patch: 0 },
    encrypted: false,
  },
  members: [
    {
      logicalMember: RETAINED_MEMBER,
      size: RETAINED_BYTES.byteLength,
      sha256: sha256(RETAINED_BYTES),
    },
    {
      logicalMember: TARGET_MEMBER,
      size: REPLACEMENT_BYTES.byteLength,
      sha256: sha256(REPLACEMENT_BYTES),
    },
  ],
  error: null,
});

const successScenario = (): PckPatchStdioScenario => ({
  sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
  outputReport: outputReport(),
  patch: {
    outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
  },
});

interface Fixture {
  readonly source: string;
  readonly replacement: string;
}

interface Started {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly controlDirectory: string;
  readonly root: string;
  readonly fixture: Fixture;
  readonly diagnostics: () => string;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

const readdirSafe = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const makeFakeRuntime = async (root: string): Promise<string> => {
  const directory = path.join(root, "runtime");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "gdre_tools.exe"), "fake executable", "utf8"),
    writeFile(path.join(directory, "gdre_tools.pck"), "fake pck", "utf8"),
    writeFile(
      path.join(directory, "GodotMonoDecompNativeAOT.dll"),
      "fake dll",
      "utf8",
    ),
  ]);
  return directory;
};

const makeInstallation = async (root: string): Promise<string> => {
  const installation = path.join(root, "installation");
  await cp(path.join(repositoryRoot, "native"), path.join(installation, "native"), {
    recursive: true,
  });
  await writeFile(
    path.join(installation, "native", PCK_PATCH_INSPECTOR_FILE),
    "# inert controlled inspector placeholder\n",
    "utf8",
  );
  return installation;
};

const childEnvironment = (
  configFile: string,
  controlDirectory: string,
  installationRoot: string,
): Record<string, string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // The config file owns workspace/runtime selection for this controlled run.
  delete environment.GDRE_MCP_RUNTIME_DIR;
  delete environment.GDRE_MCP_WORKSPACE;
  return {
    ...environment,
    GDRE_MCP_CONFIG: configFile,
    [PCK_PATCH_STDIO_CONTROL_ENV]: controlDirectory,
    [PCK_PATCH_STDIO_INSTALLATION_ENV]: installationRoot,
  };
};

async function startClient(): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-stdio-"));
  const workspace = path.join(root, "workspace");
  const controlDirectory = path.join(root, "control");
  const inputs = path.join(workspace, "fixtures");
  await mkdir(inputs, { recursive: true });
  await mkdir(controlDirectory, { recursive: true });
  const source = path.join(inputs, "source.pck");
  const replacement = path.join(inputs, "replacement.bin");
  await writeFile(source, SOURCE_BYTES);
  await writeFile(replacement, REPLACEMENT_BYTES);
  const runtimeDirectory = await makeFakeRuntime(root);
  const installationRoot = await makeInstallation(root);
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory,
      targetVersion: "2.8.0-beta.2",
      timeouts: { maxMs: MAX_TIMEOUT_MS },
      defaults: {},
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcherPath],
    cwd: root,
    env: childEnvironment(configFile, controlDirectory, installationRoot),
    stderr: "pipe",
  });
  const client = new Client({
    name: "ticket-09c-pck-patch-stdio",
    version: "0.1.0",
  });
  const diagnosticChunks: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) =>
    diagnosticChunks.push(chunk.toString()),
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    transport,
    workspace,
    controlDirectory,
    root,
    fixture: { source, replacement },
    diagnostics: () => diagnosticChunks.join(""),
  };
}

const closeClient = async (started: Started): Promise<void> => {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
};

const callPckPatch = async (
  started: Started,
  arguments_: AnyRecord,
): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord | undefined }> => {
  const wire = (await started.client.callTool(
    { name: "gdre_pck_patch", arguments: arguments_ },
    clientRequestOptions,
  )) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord | undefined };
};

const baseInput = (started: Started): AnyRecord => ({
  source: started.fixture.source,
  patches: [
    {
      hostSource: started.fixture.replacement,
      logicalMember: TARGET_MEMBER,
    },
  ],
});

const pckLaunches = (
  launches: readonly PckPatchStdioLaunch[],
): PckPatchStdioLaunch[] =>
  launches.filter(
    (launch) =>
      launch.kind === "source-inspection" ||
      launch.kind === "patch" ||
      launch.kind === "output-inspection",
  );

const waitFor = async <T>(
  action: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 60_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await action();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await sleep(50);
  }
};

const waitForLaunch = async (
  started: Started,
  kind: PckPatchStdioLaunch["kind"],
  expected: number,
): Promise<PckPatchStdioLaunch[]> =>
  waitFor(
    async () => {
      const matches = (await readPckPatchStdioLaunches(started.controlDirectory)).filter(
        (launch) => launch.kind === kind,
      );
      return matches.length >= expected ? matches : undefined;
    },
    `${String(expected)} ${kind} launch(es)`,
  );

test("production stdio preserves discovery and guards while adapting controlled package-patch outcomes", async (t) => {
  const started = await startClient();
  try {
    const operationsRoot = path.join(started.workspace, ".gdre", "operations");

    await t.test("discovers the typed tool with its strict schema", async () => {
      const listed = await started.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      for (const name of [
        "gdre_version",
        "gdre_list_files",
        "gdre_extract",
        "gdre_export_resources",
        "gdre_patch_translations",
        "gdre_pck_patch",
      ]) {
        assert.ok(names.includes(name), name);
      }
      const tool = listed.tools.find((candidate) => candidate.name === "gdre_pck_patch");
      assert.ok(tool);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
        [
          "locales",
          "output",
          "patches",
          "session",
          "source",
          "timeoutMs",
          "translations",
          "workspace",
        ],
      );
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    });

    await t.test("schema-invalid requests stay rejected before execution", async () => {
      assert.deepEqual(await readdirSafe(operationsRoot), []);
      const invalid: readonly AnyRecord[] = [
        { ...baseInput(started), patches: [] },
        {
          ...baseInput(started),
          patches: [
            { hostSource: "replacement.bin", logicalMember: "not-a-resource" },
          ],
        },
        {
          ...baseInput(started),
          patches: [
            { hostSource: "same.bin", logicalMember: "res://one.txt" },
            { hostSource: "same.bin", logicalMember: "res://two.txt" },
          ],
        },
        {
          ...baseInput(started),
          patches: [
            { hostSource: "one.bin", logicalMember: "res://A.txt" },
            { hostSource: "two.bin", logicalMember: "res://a.txt" },
          ],
        },
        {
          ...baseInput(started),
          patches: [{ hostSource: "a=b.bin", logicalMember: "res://a.txt" }],
        },
        {
          ...baseInput(started),
          patches: [
            { hostSource: 'repla"cement.bin', logicalMember: "res://a.txt" },
          ],
        },
        {
          ...baseInput(started),
          patches: [{ hostSource: "replacement.bin", logicalMember: "res://a'b.txt" }],
        },
        {
          ...baseInput(started),
          patches: [{ hostSource: "replacement.bin'", logicalMember: "res://a.txt" }],
        },
        {
          ...baseInput(started),
          patches: [{ hostSource: "replacement.bin", logicalMember: 'res://a.txt"' }],
        },
        {
          ...baseInput(started),
          translations: [
            { csv: "a.csv", resource: "res://a.csv" },
            { csv: "b.csv", resource: "res://b.csv" },
          ],
        },
        {
          ...baseInput(started),
          translations: [{ csv: "a=b.csv", resource: "res://a.csv" }],
        },
        { ...baseInput(started), locales: ["zh"] },
        { ...baseInput(started), include: ["res://*.txt"] },
        { ...baseInput(started), key: "a".repeat(64) },
        { ...baseInput(started), unexpected: true },
      ];
      for (const arguments_ of invalid) {
        const { wire, result } = await callPckPatch(started, arguments_);
        assert.equal(wire.isError, true, JSON.stringify(arguments_));
        assert.equal(result, undefined, JSON.stringify(arguments_));
      }
      assert.deepEqual(await readdirSafe(operationsRoot), []);
    });

    await t.test("combined calls enter preparation and fail closed before native launch", async () => {
      assert.deepEqual(await readdirSafe(operationsRoot), []);
      const missing = path.join(started.workspace, "missing");
      const translation = {
        csv: path.join(missing, "translations.csv"),
        resource: "res://i18n/translations.csv",
      };
      const cases: AnyRecord[] = [
        {
          source: path.join(missing, "source.pck"),
          translations: [translation],
        },
        {
          source: path.join(missing, "source.pck"),
          patches: [],
          translations: [translation],
        },
        { ...baseInput(started), translations: [translation] },
        {
          source: path.join(missing, "source.pck"),
          patches: [],
          translations: [translation],
          locales: ["en", "zh"],
        },
      ];
      for (const arguments_ of cases) {
        const { wire, result } = await callPckPatch(started, arguments_);
        assert.equal(wire.isError, true, JSON.stringify(arguments_));
        assert.ok(result, JSON.stringify(arguments_));
        assert.equal(result.success, false);
        assert.equal(result.error.code, "validation_failed");
        assert.equal(result.error.stage, "validating");
        assert.notEqual(result.error.code, "unsupported_capability");
        assert.equal(result.semantic.status, "not_evaluated");
        assert.equal(result.semantic.data, null);
        assert.equal(result.process.pid, null);
        assert.notEqual(result.paths.operation, null);
        assert.equal(result.paths.effectiveDestination, null);
        assert.equal(
          await exists(path.join(result.paths.operation, "output")),
          true,
        );
        assert.deepEqual(
          pckLaunches(
            await readPckPatchStdioLaunches(started.controlDirectory),
          ),
          [],
        );
      }
      assert.equal(
        (await readdirSafe(operationsRoot)).length,
        cases.length,
        "each combined request allocates one preparation operation but launches no native process",
      );

      const overBudget = await callPckPatch(started, {
        ...cases[0],
        timeoutMs: MAX_TIMEOUT_MS + 1_000,
      });
      assert.equal(overBudget.wire.isError, true);
      assert.ok(overBudget.result);
      assert.equal(overBudget.result.error.code, "validation_failed");
      assert.equal(overBudget.result.semantic.data, null);
      assert.equal(
        (await readdirSafe(operationsRoot)).length,
        cases.length,
        "prelaunch validation still allocates no operation",
      );
    });

    await t.test(
      "execution-level validation keeps the pck identity without allocation",
      async () => {
        const { wire, result } = await callPckPatch(started, {
          ...baseInput(started),
          timeoutMs: MAX_TIMEOUT_MS + 1_000,
        });
        assert.equal(wire.isError, true);
        assert.ok(result);
        assert.equal(result.success, false);
        assert.equal(result.error.code, "validation_failed");
        assert.equal(result.error.stage, "validating");
        assert.match(result.error.message, /timeoutMs/u);
        assert.equal(result.semantic.status, "not_evaluated");
        assert.equal(result.semantic.rule, "gdre-pck-patch-v1");
        assert.equal(result.semantic.summary, "GDRE package patch was not evaluated.");
        assert.equal(result.semantic.data, null);
        for (const field of [
          "workspace",
          "operation",
          "output",
          "effectiveDestination",
          "manifest",
          "artifactInventory",
        ]) {
          assert.equal(result.paths[field], null, field);
        }
        assert.equal(result.process.pid, null);
        assert.equal(
          (await readdirSafe(operationsRoot)).length,
          4,
          "prelaunch validation allocates no additional operation",
        );
      },
    );

    await t.test("omitted output adapts a complete controlled success", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, successScenario());
      const { wire, result } = await callPckPatch(started, baseInput(started));
      assert.equal(wire.isError, false, started.diagnostics());
      assert.ok(result);
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(result.status, "succeeded");
      const operation = result.paths.operation as string;
      const expectedOutput = defaultPatchedOutput(
        started.fixture.source,
        operation,
      );
      assert.equal(path.dirname(expectedOutput), path.join(started.workspace, "fixtures"));
      assert.equal(result.paths.effectiveDestination, expectedOutput);
      assert.equal(result.semantic.data.completeness, "complete");
      assert.equal(result.semantic.data.outputPath, expectedOutput);
      assert.deepEqual(result.semantic.data.counts, {
        mappings: 1,
        verifiedReplacements: 1,
        verifiedRetainedMembers: 1,
        unverifiedFiles: 0,
      });
      assert.equal(result.semantic.data.reports.sourceInspection, path.join(operation, "pck-source-inspection", "report.json"));
      assert.equal(result.semantic.data.reports.outputInspection, path.join(operation, "pck-output-inspection", "report.json"));
      assert.equal(result.semantic.data.reports.verification, path.join(operation, "pck-patch", "verification.json"));
      for (const file of Object.values(result.semantic.data.reports) as string[]) {
        assert.equal(await exists(file), true, file);
      }
      const verification = JSON.parse(
        await readFile(result.semantic.data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.patchProcess.exitCode, 0);
      assert.ok(verification.patchProcess.stdoutBytes > 0);
      assert.equal(verification.outputInspectionProcess.exitCode, 0);
      assert.equal(verification.outputInspectionProcess.signal, null);
      assert.equal(
        Object.hasOwn(verification.outputInspectionProcess, "stdoutBytes"),
        false,
      );
      assert.deepEqual(result.artifacts.items, [
        {
          path: expectedOutput,
          role: "output-package",
          bytes: OUTPUT_PACKAGE_BYTES.byteLength,
          sha256: sha256(OUTPUT_PACKAGE_BYTES),
        },
      ]);
      assert.equal(result.artifacts.complete, true);
      assert.deepEqual(await readFile(expectedOutput), OUTPUT_PACKAGE_BYTES);
      assert.deepEqual(await readFile(started.fixture.source), SOURCE_BYTES);
      assert.deepEqual(await readFile(started.fixture.replacement), REPLACEMENT_BYTES);

      const launches = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      );
      assert.deepEqual(
        launches.map((launch) => launch.kind),
        ["source-inspection", "patch", "output-inspection"],
      );
      const patch = launches[1]!;
      assert.ok(patch.argv.includes(`--pck-patch=${started.fixture.source}`));
      assert.ok(patch.argv.includes(`--output=${expectedOutput}`));
      assert.ok(
        patch.argv.includes(
          `--patch-file=${started.fixture.replacement}=${TARGET_MEMBER}`,
        ),
      );

      const manifest = JSON.parse(
        await readFile(result.paths.manifest, "utf8"),
      ) as AnyRecord;
      assert.equal(manifest.effectiveParameters.source, started.fixture.source);
      assert.deepEqual(manifest.effectiveParameters.patches, [
        { hostSource: started.fixture.replacement, logicalMember: TARGET_MEMBER },
      ]);
      assert.equal(manifest.effectiveParameters.output, expectedOutput);
      assert.ok(manifest.effects.writes.includes(expectedOutput));
    });

    await t.test("explicit output is honored exactly", async () => {
      await mkdir(path.join(started.workspace, "out"), { recursive: true });
      await writePckPatchStdioScenario(started.controlDirectory, successScenario());
      const explicit = path.join(started.workspace, "out", "patched.pck");
      const { wire, result } = await callPckPatch(started, {
        ...baseInput(started),
        output: "out/patched.pck",
      });
      assert.equal(wire.isError, false, started.diagnostics());
      assert.ok(result);
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(result.paths.effectiveDestination, explicit);
      assert.equal(result.semantic.data.outputPath, explicit);
      assert.deepEqual(await readFile(explicit), OUTPUT_PACKAGE_BYTES);
      const launches = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      );
      assert.ok(
        launches.some((launch) => launch.argv.includes(`--output=${explicit}`)),
      );
    });

    await t.test("native forward-slash markers are accepted for backslash host outputs", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        ...successScenario(),
        patch: {
          outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
          nativeForwardSlashMarker: true,
        },
      });
      const omitted = await callPckPatch(started, baseInput(started));
      assert.equal(omitted.wire.isError, false, started.diagnostics());
      assert.ok(omitted.result);
      assert.equal(
        omitted.result.success,
        true,
        JSON.stringify(omitted.result.error),
      );
      const omittedOutput = (omitted.result.semantic.data as AnyRecord)
        .outputPath as string;
      assert.ok(omittedOutput.includes("\\"), omittedOutput);
      assert.equal(
        omittedOutput,
        defaultPatchedOutput(
          started.fixture.source,
          omitted.result.paths.operation as string,
        ),
      );
      assert.deepEqual(
        await readFile(omittedOutput),
        OUTPUT_PACKAGE_BYTES,
      );

      await mkdir(path.join(started.workspace, "out"), { recursive: true });
      const explicit = await callPckPatch(started, {
        ...baseInput(started),
        output: "out/native-marker.pck",
      });
      assert.equal(explicit.wire.isError, false, started.diagnostics());
      assert.ok(explicit.result);
      assert.equal(
        explicit.result.success,
        true,
        JSON.stringify(explicit.result.error),
      );
      const explicitOutput = path.join(
        started.workspace,
        "out",
        "native-marker.pck",
      );
      assert.ok(explicitOutput.includes("\\"), explicitOutput);
      assert.equal(
        (explicit.result.semantic.data as AnyRecord).outputPath,
        explicitOutput,
      );
      assert.deepEqual(await readFile(explicitOutput), OUTPUT_PACKAGE_BYTES);
    });

    await t.test("malformed source inspection never launches a patch", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        sourceReport: "malformed",
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, baseInput(started));
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "semantic_unknown", result.error.message);
      assert.equal(result.semantic.status, "unknown");
      const data = result.semantic.data as AnyRecord;
      assert.ok(data);
      assert.equal(data.completeness, "unknown");
      assert.notEqual(data.reports.sourceInspection, null);
      assert.equal(data.reports.outputInspection, null);
      const verification = JSON.parse(
        await readFile(data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stage, "source-inspection");
      assert.equal(verification.reportsParsed, false);
      assert.equal(verification.sourceReportObservation.exists, true);
      assert.equal(result.artifacts.count, 0);
      const launches = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      );
      assert.deepEqual(
        launches.slice(before).map((launch) => launch.kind),
        ["source-inspection"],
      );
    });

    await t.test("a natural patch error retains evidence and stops before output inspection", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        ...successScenario(),
        patch: {
          exitCode: 3,
          stdout: "Error: failed to write patching PCK: controlled failure\n",
          writeOutput: false,
        },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, baseInput(started));
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "process_failed", result.error.message);
      assert.match(result.stdout.text, /controlled failure/u);
      assert.equal(result.artifacts.count, 0);
      assert.equal(result.artifacts.complete, false);
      assert.deepEqual(
        pckLaunches(
          await readPckPatchStdioLaunches(started.controlDirectory),
        )
          .slice(before)
          .map((launch) => launch.kind),
        ["source-inspection", "patch"],
      );
      const verification = JSON.parse(
        await readFile(result.semantic.data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "patch");
      assert.equal(verification.reportsParsed, false);
    });

    await t.test("a failed output inspection never parses its report", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        ...successScenario(),
        outputInspection: { exitCode: 2, delivery: "malformed" },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, baseInput(started));
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "process_failed", result.error.message);
      assert.equal(result.semantic.data.completeness, "unknown");
      assert.equal(result.semantic.data.reports.outputInspection, null);
      assert.equal(result.artifacts.count, 0);
      const launches = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).slice(before);
      assert.deepEqual(
        launches.map((launch) => launch.kind),
        ["source-inspection", "patch", "output-inspection"],
      );
      const verification = JSON.parse(
        await readFile(result.semantic.data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "output-inspection");
      assert.equal(verification.reportsParsed, false);
      assert.equal(verification.inputFingerprintsRechecked, false);
    });

    await t.test("an explicit timeout stops the patch and retains partial output as unverified", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
        patch: {
          holdUntilKilled: true,
          writeOutput: true,
          writeTemporary: true,
          outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
        },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, {
        ...baseInput(started),
        timeoutMs: STOP_TIMEOUT_MS,
      });
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "timed_out");
      assert.equal(result.error.code, "execution_timeout");
      assert.equal(result.semantic.data.completeness, "unknown");
      assert.ok(result.semantic.data.counts.unverifiedFiles >= 2);
      const expectedOutput = defaultPatchedOutput(
        started.fixture.source,
        result.paths.operation as string,
      );
      assert.ok(
        result.semantic.data.samples.unverifiedFiles.some(
          (file: string) =>
            path.resolve(file) === path.resolve(expectedOutput),
        ),
      );
      assert.ok(
        result.semantic.data.samples.unverifiedFiles.some(
          (file: string) =>
            path.resolve(file) === path.resolve(`${expectedOutput}.tmp`),
        ),
      );
      assert.equal(result.artifacts.count, 0);
      assert.deepEqual(
        pckLaunches(
          await readPckPatchStdioLaunches(started.controlDirectory),
        )
          .slice(before)
          .map((launch) => launch.kind),
        ["source-inspection", "patch"],
      );
      const verification = JSON.parse(
        await readFile(result.semantic.data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "patch");
      assert.equal(verification.reportsParsed, false);
    });

    await t.test("a stopped source inspection retains the acquired report without parsing it", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
        sourceInspection: { holdUntilKilled: true },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, {
        ...baseInput(started),
        timeoutMs: STOP_TIMEOUT_MS,
      });
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "timed_out");
      assert.equal(result.error.code, "execution_timeout");
      const data = result.semantic.data as AnyRecord;
      assert.ok(data);
      assert.equal(data.completeness, "unknown");
      assert.notEqual(data.reports.sourceInspection, null);
      assert.equal(result.artifacts.count, 0);
      assert.deepEqual(
        pckLaunches(
          await readPckPatchStdioLaunches(started.controlDirectory),
        )
          .slice(before)
          .map((launch) => launch.kind),
        ["source-inspection"],
      );
      const verification = JSON.parse(
        await readFile(data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "source-inspection");
      assert.equal(verification.reportsParsed, false);
      assert.equal(verification.inputFingerprintsRechecked, false);
      assert.equal(verification.sourceReportObservation.exists, true);
    });

    await t.test("a stopped output inspection keeps the timeout terminal and skips report parsing", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
        outputReport: outputReport(),
        patch: {
          outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
        },
        outputInspection: { holdUntilKilled: true },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const { wire, result } = await callPckPatch(started, {
        ...baseInput(started),
        timeoutMs: STOP_TIMEOUT_MS,
      });
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "timed_out");
      assert.equal(result.error.code, "execution_timeout");
      assert.equal(result.semantic.data.completeness, "unknown");
      assert.equal(result.semantic.data.reports.outputInspection, null);
      assert.equal(result.artifacts.count, 0);
      assert.deepEqual(
        pckLaunches(
          await readPckPatchStdioLaunches(started.controlDirectory),
        )
          .slice(before)
          .map((launch) => launch.kind),
        ["source-inspection", "patch", "output-inspection"],
      );
      const verification = JSON.parse(
        await readFile(result.semantic.data.reports.verification, "utf8"),
      ) as AnyRecord;
      assert.equal(verification.stopped, true);
      assert.equal(verification.stage, "output-inspection");
      assert.equal(verification.reportsParsed, false);
      assert.equal(verification.inputFingerprintsRechecked, false);
    });

    await t.test("verified content is not published as complete when the output inventory is not accepted", async () => {
      await writePckPatchStdioScenario(started.controlDirectory, {
        ...successScenario(),
        outputInspection: { removePackageAfterReport: true },
      });
      const { wire, result } = await callPckPatch(started, baseInput(started));
      assert.equal(wire.isError, true);
      assert.ok(result);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "process_failed", result.error.message);
      assert.match(result.error.message, /inventory/iu);
      assert.equal(result.semantic.status, "unknown");
      const data = result.semantic.data as AnyRecord;
      assert.ok(data);
      assert.equal(data.completeness, "unknown");
      assert.notEqual(data.reports.sourceInspection, null);
      assert.notEqual(data.reports.outputInspection, null);
      assert.equal(await exists(data.reports.verification), true);
      assert.equal(data.counts.verifiedReplacements, 1);
      assert.equal(data.counts.verifiedRetainedMembers, 1);
      assert.ok(
        data.diagnostics.some((line: string) =>
          /inventory was not accepted/iu.test(line),
        ),
      );
      assert.equal(result.artifacts.count, 0);
      assert.equal(result.artifacts.complete, false);
    });

    await t.test("overlapping independent calls keep per-call state and outputs", async () => {
      const secondInputs = path.join(started.workspace, "second");
      await mkdir(secondInputs, { recursive: true });
      const secondSource = path.join(secondInputs, "source-b.pck");
      const secondReplacement = path.join(secondInputs, "replacement-b.bin");
      await writeFile(secondSource, SOURCE_BYTES);
      await writeFile(secondReplacement, REPLACEMENT_BYTES);
      await writePckPatchStdioScenario(started.controlDirectory, {
        ...successScenario(),
        patch: {
          outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
          delayMs: 300,
        },
      });
      const before = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).length;
      const [first, second] = await Promise.all([
        callPckPatch(started, baseInput(started)),
        callPckPatch(started, {
          source: secondSource,
          patches: [
            { hostSource: secondReplacement, logicalMember: TARGET_MEMBER },
          ],
        }),
      ]);
      for (const entry of [first, second]) {
        assert.equal(entry.wire.isError, false, started.diagnostics());
        assert.ok(entry.result);
        assert.equal(
          entry.result.success,
          true,
          JSON.stringify(entry.result.error),
        );
        assert.equal(entry.result.semantic.data.completeness, "complete");
      }
      const firstOutput = first.result!.semantic.data.outputPath as string;
      const secondOutput = second.result!.semantic.data.outputPath as string;
      assert.notEqual(first.result!.operationId, second.result!.operationId);
      assert.notEqual(firstOutput, secondOutput);
      assert.equal(await exists(firstOutput), true);
      assert.equal(await exists(secondOutput), true);
      const launches = pckLaunches(
        await readPckPatchStdioLaunches(started.controlDirectory),
      ).slice(before);
      assert.equal(launches.filter((launch) => launch.kind === "patch").length, 2);
      assert.equal(
        launches.filter((launch) => launch.kind === "source-inspection").length,
        2,
      );
      assert.equal(
        launches.filter((launch) => launch.kind === "output-inspection").length,
        2,
      );
    });
  } finally {
    await closeClient(started);
  }
});

test("production stdio recognizes combined scripts and stops truthfully", async () => {
  const started = await startClient();
  try {
    const csv = path.join(started.workspace, "combined-translations.csv");
    await writeFile(csv, "key,en\nA,new-A\n", { flag: "wx" });
    await writePckPatchStdioScenario(started.controlDirectory, {
      sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
      combinedPreparation: { delivery: "malformed" },
    });
    const { wire, result } = await callPckPatch(started, {
      source: started.fixture.source,
      patches: [],
      translations: [{ csv, resource: "res://i18n/translations.csv" }],
      locales: ["en"],
    });
    assert.equal(wire.isError, true, started.diagnostics());
    assert.ok(result);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "semantic_unknown");
    const launches = (
      await readPckPatchStdioLaunches(started.controlDirectory)
    ).filter((launch) => launch.kind !== "startup");
    assert.deepEqual(
      launches.map((launch) => launch.kind),
      ["source-inspection", "combined-preparation"],
      "the combined preparation launch must be recognized, not treated as a version probe",
    );
    assert.equal(
      (result.semantic.data as AnyRecord).translations.reports.preparation !==
        null,
      true,
      "the acquired malformed report remains referenced without becoming success",
    );
  } finally {
    await closeClient(started);
  }
});

test("a stdio disconnect stops owned work and retains bounded stopped evidence", async () => {
  const started = await startClient();
  try {
    await writePckPatchStdioScenario(started.controlDirectory, {
      sourceReport: sourceReport(PCK_PATCH_PACKAGE_PATH_TOKEN),
      patch: {
        holdUntilKilled: true,
        writeOutput: true,
        writeTemporary: true,
        outputBytesBase64: OUTPUT_PACKAGE_BYTES.toString("base64"),
      },
    });
    const pending = started.client
      .callTool(
        { name: "gdre_pck_patch", arguments: baseInput(started) },
        clientRequestOptions,
      )
      .catch((error: unknown) => error);
    await waitForLaunch(started, "patch", 1);
    const patchLaunch = (
      await readPckPatchStdioLaunches(started.controlDirectory)
    ).find((launch) => launch.kind === "patch");
    assert.ok(patchLaunch?.outputPath);
    const partialOutput = patchLaunch.outputPath;
    // The launch record is written before the owned child starts. Observe the
    // actual partial output/tmp residue before disconnecting.
    await waitFor(
      async () =>
        (await exists(partialOutput)) && (await exists(`${partialOutput}.tmp`))
          ? true
          : undefined,
      "partial output and temporary observation",
    );
    // Closing the client ends stdin, which is the production disconnect signal.
    await started.client.close().catch(() => undefined);
    await started.transport.close().catch(() => undefined);
    await pending;

    const operationsRoot = path.join(started.workspace, ".gdre", "operations");
    const evidence = await waitFor(
      async () => {
        for (const name of await readdirSafe(operationsRoot)) {
          const operation = path.join(operationsRoot, name);
          const verificationPath = path.join(
            operation,
            "pck-patch",
            "verification.json",
          );
          const manifestPath = path.join(operation, "manifest.json");
          if (
            (await exists(verificationPath)) &&
            (await exists(manifestPath))
          ) {
            return {
              verification: JSON.parse(
                await readFile(verificationPath, "utf8"),
              ) as AnyRecord,
              manifest: JSON.parse(
                await readFile(manifestPath, "utf8"),
              ) as AnyRecord,
            };
          }
        }
        return undefined;
      },
      "stopped operation evidence",
    );

    assert.equal(evidence.verification.stopped, true);
    assert.equal(evidence.verification.stage, "patch");
    assert.equal(evidence.verification.reportsParsed, false);
    assert.equal(evidence.verification.inputFingerprintsRechecked, false);
    assert.ok(
      (evidence.verification.availableFiles as AnyRecord[]).some(
        (file) =>
          file.exists === true &&
          path.resolve(String(file.path)) === path.resolve(partialOutput),
      ),
    );
    assert.equal(evidence.manifest.status, "interrupted");
    assert.equal(evidence.manifest.error.code, "disconnected");

    const launches = pckLaunches(
      await readPckPatchStdioLaunches(started.controlDirectory),
    );
    assert.deepEqual(
      launches.map((launch) => launch.kind),
      ["source-inspection", "patch"],
    );
  } finally {
    await closeClient(started);
  }
});
