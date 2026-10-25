import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ConfigError, loadConfig, type LoadedConfig } from "../src/config.js";
import { ExecutionImpl } from "../src/execution.js";
import type { RuntimeManager } from "../src/runtime.js";
import type {
  CommandId,
  OperationResult,
  RuntimeState,
} from "../src/types.js";

/**
 * T1 acceptance: automatic internal workspace plus absolute-only host-path
 * admission when that workspace is the builtin temporary root.
 *
 * The stdio case exercises the real built server and the configured external
 * runtime. Controlled admission cases only prove pre-allocation policy and do
 * not claim native content success.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const configModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "src", "config.js"),
).href;
const executionModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "src", "execution.js"),
).href;
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ??
  path.join(repositoryRoot, "vendor", "GDRE_tools");

interface NodeProbe {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const inheritedEnvironment = (): Record<string, string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GDRE_MCP_")) delete environment[key];
  }
  return environment;
};

const runNode = (
  code: string,
  options: { readonly cwd: string; readonly env: Record<string, string> },
): Promise<NodeProbe> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (codeValue) => {
      resolve({ code: codeValue, stdout, stderr });
    });
  });

const inspectMissingWorkspace = async (
  cwd: string,
  temporaryRoot: string,
): Promise<{ readonly workspaceRoot: string; readonly source: string }> => {
  const code = `
import { loadConfig } from ${JSON.stringify(configModuleUrl)};
const config = await loadConfig(${JSON.stringify(repositoryRoot)}, process.env);
process.stdout.write(JSON.stringify({
  workspaceRoot: config.workspaceRoot,
  source: config.sources.workspace,
}));
`;
  const probe = await runNode(code, {
    cwd,
    env: {
      ...inheritedEnvironment(),
      TMP: temporaryRoot,
      TEMP: temporaryRoot,
    },
  });
  assert.equal(probe.code, 0, probe.stderr);
  return JSON.parse(probe.stdout) as {
    readonly workspaceRoot: string;
    readonly source: string;
  };
};

interface WorkspaceProbe {
  readonly ok: boolean;
  readonly name?: string;
  readonly message?: string;
  readonly workspaceRoot?: string;
  readonly source?: string;
}

const inspectWorkspaceOverride = async (
  cwd: string,
  overrides: Record<string, string>,
): Promise<WorkspaceProbe> => {
  const code = `
import { loadConfig } from ${JSON.stringify(configModuleUrl)};
try {
  const config = await loadConfig(${JSON.stringify(repositoryRoot)}, process.env);
  process.stdout.write(JSON.stringify({
    ok: true,
    workspaceRoot: config.workspaceRoot,
    source: config.sources.workspace,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : null,
    message: error instanceof Error ? error.message : String(error),
  }));
}
`;
  const probe = await runNode(code, {
    cwd,
    env: {
      ...inheritedEnvironment(),
      TEMP: "",
      TMP: "",
      TMPDIR: "",
      ...overrides,
    },
  });
  assert.equal(probe.code, 0, probe.stderr);
  return JSON.parse(probe.stdout) as WorkspaceProbe;
};

const selectedTempVariable = (): { readonly primary: string; readonly lower: string } =>
  process.platform === "win32"
    ? { primary: "TEMP", lower: "TMP" }
    : { primary: "TMPDIR", lower: "TMP" };


const operations = async (workspace: string): Promise<string[]> => {
  try {
    return await readdir(path.join(workspace, ".gdre", "operations"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

test("missing workspace resolves deterministically to the synthetic temporary root without CWD rebasing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-default-workspace-"));
  try {
    const temporaryRoot = path.join(root, "system-temp");
    const firstCwd = path.join(root, "caller-cwd-a");
    const secondCwd = path.join(root, "caller-cwd-b");
    await Promise.all([
      mkdir(firstCwd, { recursive: true }),
      mkdir(secondCwd, { recursive: true }),
    ]);

    const first = await inspectMissingWorkspace(firstCwd, temporaryRoot);
    const second = await inspectMissingWorkspace(secondCwd, temporaryRoot);

    assert.deepEqual(first, {
      workspaceRoot: path.join(temporaryRoot, "GodotGdreMcp"),
      source: "builtin",
    });
    assert.deepEqual(second, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a relative system temp path is rejected without CWD rebasing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-relative-temp-"));
  const firstCwd = path.join(root, "caller-cwd-a");
  const secondCwd = path.join(root, "caller-cwd-b");
  const { primary } = selectedTempVariable();
  try {
    await Promise.all([
      mkdir(firstCwd, { recursive: true }),
      mkdir(secondCwd, { recursive: true }),
    ]);
    const overrides = { [primary]: "relative-temp" };
    const first = await inspectWorkspaceOverride(firstCwd, overrides);
    const second = await inspectWorkspaceOverride(secondCwd, overrides);

    for (const observed of [first, second]) {
      assert.equal(observed.ok, false);
      assert.equal(observed.name, "ConfigError");
      assert.match(
        observed.message ?? "",
        /automatic temporary workspace/,
      );
      assert.match(observed.message ?? "", /workspaceRoot/);
      assert.match(observed.message ?? "", /GDRE_MCP_WORKSPACE/);
      assert.equal(observed.workspaceRoot, undefined);
    }
    assert.equal(first.message, second.message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unused lower-priority relative temp variable does not block the automatic workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-unused-temp-"));
  const cwd = path.join(root, "caller-cwd");
  const temporaryRoot = path.join(root, "system-temp");
  const { primary, lower } = selectedTempVariable();
  try {
    await mkdir(cwd, { recursive: true });
    const observed = await inspectWorkspaceOverride(cwd, {
      [primary]: temporaryRoot,
      [lower]: "relative-unused",
    });
    assert.equal(observed.ok, true);
    assert.equal(observed.source, "builtin");
    assert.equal(
      observed.workspaceRoot,
      path.join(temporaryRoot, "GodotGdreMcp"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit workspace bypasses a relative selected temp override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-explicit-temp-"));
  const cwd = path.join(root, "caller-cwd");
  const explicitWorkspace = path.join(root, "explicit-workspace");
  const { primary } = selectedTempVariable();
  try {
    await mkdir(cwd, { recursive: true });
    const observed = await inspectWorkspaceOverride(cwd, {
      [primary]: "relative-temp",
      GDRE_MCP_WORKSPACE: explicitWorkspace,
    });
    assert.equal(observed.ok, true);
    assert.equal(observed.source, "environment");
    assert.equal(observed.workspaceRoot, explicitWorkspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid explicit workspace overrides remain errors instead of falling back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-invalid-workspace-"));
  const configPath = path.join(root, "selected.json");
  try {
    await assert.rejects(
      loadConfig(root, { GDRE_MCP_WORKSPACE: "" }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("GDRE_MCP_WORKSPACE"),
    );
    await assert.rejects(
      loadConfig(root, { GDRE_MCP_WORKSPACE: "relative\\workspace" }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("GDRE_MCP_WORKSPACE"),
    );

    await writeFile(configPath, JSON.stringify({ workspaceRoot: "" }), "utf8");
    await assert.rejects(
      loadConfig(root, { GDRE_MCP_CONFIG: configPath }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("workspaceRoot"),
    );

    await writeFile(configPath, JSON.stringify({ workspaceRoot: 42 }), "utf8");
    await assert.rejects(
      loadConfig(root, { GDRE_MCP_CONFIG: configPath }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes("workspaceRoot"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment and config overrides retain precedence over the builtin root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-workspace-precedence-"));
  const configDirectory = path.join(root, "config");
  const configPath = path.join(configDirectory, "selected.json");
  const configWorkspace = path.join(root, "configured-workspace");
  const environmentWorkspace = path.join(root, "environment-workspace");
  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ workspaceRoot: configWorkspace }),
      "utf8",
    );

    const configured = await loadConfig(root, { GDRE_MCP_CONFIG: configPath });
    assert.equal(configured.workspaceRoot, configWorkspace);
    assert.equal(configured.sources.workspace, "config");

    const overridden = await loadConfig(root, {
      GDRE_MCP_CONFIG: configPath,
      GDRE_MCP_WORKSPACE: environmentWorkspace,
    });
    assert.equal(overridden.workspaceRoot, environmentWorkspace);
    assert.equal(overridden.sources.workspace, "environment");

    const builtin = await loadConfig(root, {});
    assert.equal(builtin.workspaceRoot, path.join(os.tmpdir(), "GodotGdreMcp"));
    assert.equal(builtin.sources.workspace, "builtin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unusable automatic temporary root fails targeted without a CWD fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-unusable-temp-"));
  const cwd = path.join(root, "caller-cwd");
  const blocked = path.join(root, "blocked-temp");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(blocked, "not a directory", "utf8");
    const code = `
import { openExecution } from ${JSON.stringify(executionModuleUrl)};
try {
  await openExecution(${JSON.stringify(repositoryRoot)});
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : null,
    message: error instanceof Error ? error.message : String(error),
  }));
}
`;
    const probe = await runNode(code, {
      cwd,
      env: {
        ...inheritedEnvironment(),
        TMP: blocked,
        TEMP: blocked,
      },
    });
    assert.equal(probe.code, 0, probe.stderr);
    const observed = JSON.parse(probe.stdout) as {
      readonly ok: boolean;
      readonly name: string | null;
      readonly message: string;
    };
    assert.equal(observed.ok, false);
    assert.equal(observed.name, "ConfigError");
    assert.match(observed.message, /automatic temporary workspace/i);
    assert.match(observed.message, /GDRE_MCP_WORKSPACE/);
    assert.match(observed.message, /workspaceRoot/);
    assert.doesNotMatch(observed.message, /configured workspace is unsupported/i);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const runtimeState = (root: string): RuntimeState => ({
  health: "ready",
  registryVersion: "2.8.0-beta.2",
  targetVersion: "2.8.0-beta.2",
  actualVersion: "2.8.0-beta.2",
  comparison: "match",
  executable: path.join(root, "runtime", "gdre_tools.exe"),
  companions: [
    {
      path: path.join(root, "runtime", "gdre_tools.exe"),
      present: true,
      sha256: "a".repeat(64),
    },
    {
      path: path.join(root, "runtime", "gdre_tools.pck"),
      present: true,
      sha256: "b".repeat(64),
    },
    {
      path: path.join(root, "runtime", "GodotMonoDecompNativeAOT.dll"),
      present: true,
      sha256: "c".repeat(64),
    },
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
});

const admissionConfig = (
  root: string,
  source: LoadedConfig["sources"]["workspace"],
): LoadedConfig => ({
  installationRoot: root,
  configFile: null,
  workspaceRoot: path.join(root, "workspace"),
  runtimeDirectory: path.join(root, "runtime"),
  targetVersion: "2.8.0-beta.2",
  timeouts: { maxMs: 3_600_000 },
  defaults: {},
  settings: [],
  sources: {
    workspace: source,
    runtimeDirectory: "builtin",
    targetVersion: "builtin",
    timeouts: "builtin",
    defaults: "builtin",
    settings: "builtin",
  },
});

const withExecution = async <T>(
  root: string,
  source: LoadedConfig["sources"]["workspace"],
  action: (execution: ExecutionImpl) => Promise<T>,
): Promise<T> => {
  const state = runtimeState(root);
  const manager = {
    state,
    refreshIfChanged: async (): Promise<RuntimeState> => state,
  } as unknown as RuntimeManager;
  const execution = new ExecutionImpl(admissionConfig(root, source), manager, {
    processRunner: {
      async run(): Promise<never> {
        throw new Error("unexpected process launch during admission test");
      },
    },
  });
  try {
    return await action(execution);
  } finally {
    await execution.close("shutdown");
  }
};

const runCommand = (
  execution: ExecutionImpl,
  commandId: CommandId,
  input: Record<string, unknown>,
): Promise<OperationResult> =>
  execution.execute(commandId, input, {
    signal: new AbortController().signal,
  });

const assertPreallocationRejection = (
  result: OperationResult,
  field: string,
): void => {
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "validation_failed");
  assert.equal(result.error?.stage, "validating");
  assert.ok(
    result.error?.message.includes(field),
    `expected ${field} in ${result.error?.message ?? "<no message>"}`,
  );
  assert.ok(
    result.semantic.evidence.some((entry) => entry.includes(field)),
    JSON.stringify(result.semantic.evidence),
  );
  assert.equal(result.paths.workspace, null);
  assert.equal(result.paths.operation, null);
  assert.equal(result.persistence.state, "unavailable");
};

test("builtin provenance rejects relative host leaves before operation allocation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-builtin-reject-"));
  const absolute = (name: string): string => path.join(root, name);
  try {
    const cases: readonly {
      readonly label: string;
      readonly commandId: CommandId;
      readonly input: Record<string, unknown>;
      readonly field: string;
    }[] = [
      {
        label: "relative input path",
        commandId: "list-files",
        input: { inputs: [{ kind: "path", path: "pack.pck" }] },
        field: "inputs[0].path",
      },
      {
        label: "relative input glob",
        commandId: "list-files",
        input: { inputs: [{ kind: "glob", pattern: "*.pck" }] },
        field: "inputs[0].pattern",
      },
      {
        label: "relative extraction input",
        commandId: "extract",
        input: { inputs: [{ kind: "path", path: "pack.pck" }] },
        field: "inputs[0].path",
      },
      {
        label: "relative extraction output",
        commandId: "extract",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          output: "exports/out",
        },
        field: "output",
      },
      {
        label: "relative export input",
        commandId: "export-resources",
        input: {
          inputs: [{ kind: "path", path: "pack.pck" }],
          selection: { kind: "group", group: "scripts" },
        },
        field: "inputs[0].path",
      },
      {
        label: "relative translation hint",
        commandId: "export-resources",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          selection: { kind: "group", group: "scripts" },
          translationHints: ["hints/keys.txt"],
        },
        field: "translationHints[0]",
      },
      {
        label: "relative standalone translation CSV",
        commandId: "patch-translations",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          translations: [{ csv: "edited.csv", resource: "res://locale/en.csv" }],
        },
        field: "translations[0].csv",
      },
      {
        label: "relative standalone translation output",
        commandId: "patch-translations",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          translations: [
            { csv: absolute("edited.csv"), resource: "res://locale/en.csv" },
          ],
          output: "translations/out",
        },
        field: "output",
      },
      {
        label: "relative package source",
        commandId: "pck-patch",
        input: {
          source: "source.pck",
          patches: [
            { hostSource: absolute("replacement.bin"), logicalMember: "res://data/a" },
          ],
        },
        field: "source",
      },
      {
        label: "relative package replacement",
        commandId: "pck-patch",
        input: {
          source: absolute("source.pck"),
          patches: [{ hostSource: "replacement.bin", logicalMember: "res://data/a" }],
        },
        field: "patches[0].hostSource",
      },
      {
        label: "relative combined translation CSV",
        commandId: "pck-patch",
        input: {
          source: absolute("source.pck"),
          translations: [
            { csv: "edited.csv", resource: "res://locale/en.csv" },
          ],
        },
        field: "translations[0].csv",
      },
      {
        label: "relative package output",
        commandId: "pck-patch",
        input: {
          source: absolute("source.pck"),
          patches: [
            { hostSource: absolute("replacement.bin"), logicalMember: "res://data/a" },
          ],
          output: "patched/out.pck",
        },
        field: "output",
      },
    ];

    for (const value of cases) {
      await t.test(value.label, async () => {
        const result = await withExecution(root, "builtin", (execution) =>
          runCommand(execution, value.commandId, value.input),
        );
        assertPreallocationRejection(result, value.field);
        assert.deepEqual(
          await operations(path.join(root, "workspace")),
          [],
          `${value.label} must not allocate an operation record`,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builtin provenance accepts absolute host leaves and does not project logical identities", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-builtin-accept-"));
  const absolute = (name: string): string => path.join(root, name);
  try {
    const cases: readonly {
      readonly label: string;
      readonly commandId: CommandId;
      readonly input: Record<string, unknown>;
    }[] = [
      {
        label: "absolute extraction inputs, output, and logical include",
        commandId: "extract",
        input: {
          inputs: [
            { kind: "path", path: absolute("absolute.pck") },
            { kind: "glob", pattern: path.join(root, "*.pck") },
          ],
          output: absolute("exports/out"),
          include: ["*.txt", "res://scripts/**"],
        },
      },
      {
        label: "absolute export inputs, hints, output, and logical selection",
        commandId: "export-resources",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          output: absolute("exports/out"),
          translationHints: [absolute("hints/keys.txt")],
          selection: { kind: "members", include: ["res://locale/*.csv"] },
        },
      },
      {
        label: "absolute translation inputs, CSV, output, and logical resource",
        commandId: "patch-translations",
        input: {
          inputs: [{ kind: "path", path: absolute("absolute.pck") }],
          translations: [
            { csv: absolute("edited.csv"), resource: "res://locale/en.csv" },
          ],
          output: absolute("translations/out"),
        },
      },
      {
        label: "absolute package source, replacement, output, and logical member",
        commandId: "pck-patch",
        input: {
          source: absolute("source.pck"),
          patches: [
            {
              hostSource: absolute("replacement.bin"),
              logicalMember: "res://data/a",
            },
          ],
          output: absolute("patched/out.pck"),
        },
      },
    ];

    for (const value of cases) {
      await t.test(value.label, async () => {
        const result = await withExecution(root, "builtin", (execution) =>
          runCommand(execution, value.commandId, value.input),
        );
        assert.notEqual(
          result.paths.operation,
          null,
          `expected admission before preparation: ${JSON.stringify(result.error)}`,
        );
        assert.notEqual(
          result.error?.message.includes(
            "must be an absolute local path while the automatic",
          ),
          true,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit call, environment, and config workspace provenance still resolves relative paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-explicit-workspace-"));
  try {
    for (const source of ["config", "environment"] as const) {
      const result = await withExecution(root, source, (execution) =>
        runCommand(execution, "extract", {
          inputs: [{ kind: "path", path: "relative-input.pck" }],
          output: "relative-output",
        }),
      );
      assert.notEqual(
        result.paths.operation,
        null,
        `${source} workspace must retain relative resolution: ${JSON.stringify(result.error)}`,
      );
    }

    const result = await withExecution(root, "builtin", (execution) =>
      runCommand(execution, "extract", {
        workspace: admissionConfig(root, "builtin").workspaceRoot,
        inputs: [{ kind: "path", path: "relative-input.pck" }],
        output: "relative-output",
      }),
    );
    assert.notEqual(
      result.paths.operation,
      null,
      `an explicit workspace with the builtin pathname must use call provenance: ${JSON.stringify(result.error)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production stdio discovers tools and reports version without workspace configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-default-stdio-"));
  const temporaryRoot = path.join(root, "system-temp");
  const callerCwd = path.join(root, "caller-cwd");
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await Promise.all([
      mkdir(temporaryRoot, { recursive: true }),
      mkdir(callerCwd, { recursive: true }),
    ]);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: callerCwd,
      env: {
        ...inheritedEnvironment(),
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        GDRE_MCP_RUNTIME_DIR: runtimeDirectory,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "t1-default-workspace", version: "0.1.0" });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 6);

    const call = await client.callTool(
      { name: "gdre_version", arguments: {} },
      { timeout: 640_000, maxTotalTimeout: 640_000 },
    );
    const result = call.structuredContent as Record<string, any>;
    assert.equal(
      call.isError,
      false,
      JSON.stringify({
        error: result?.error,
        process: result?.process,
        runtime: result?.runtime,
      }),
    );
    assert.equal(result.success, true);
    assert.equal(result.status, "succeeded");
    assert.equal(result.commandId, "version");
    assert.equal(result.runtime.health, "ready");
    assert.equal(result.runtime.actualVersion, "2.8.0-beta.2");
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.semantic.data.version, "2.8.0-beta.2");

    const builtinRoot = path.join(temporaryRoot, "GodotGdreMcp");
    assert.equal(result.paths.workspace, builtinRoot);
    assert.ok(
      result.paths.operation.startsWith(
        path.join(builtinRoot, ".gdre", "operations"),
      ),
      result.paths.operation,
    );
    assert.deepEqual(await readdir(callerCwd), []);
  } finally {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
