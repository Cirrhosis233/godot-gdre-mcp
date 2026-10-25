import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
  authorFormat2Pck,
  authoredExtractionFile,
  type AuthoredExtractionFile,
} from "./support/extraction-input-fixtures.js";
import { createExtractionFixture } from "./support/extraction-fixtures.js";
import { createExportFixture } from "./support/export-fixtures.js";
import {
  createStandaloneTranslationFixture,
  readTranslationOutputs,
  sha256File,
} from "./support/translation-fixtures.js";

/**
 * T2 acceptance through production stdio with no workspace configuration,
 * environment override, or per-call workspace. Inputs are absolute host paths
 * under a test-owned fixture root; internal state is confined to a distinct
 * process TEMP directory. Every product path and its independently authored
 * content are asserted.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ??
  path.join(repositoryRoot, "vendor", "GDRE_tools");
const runtimeExecutable = path.join(runtimeDirectory, "gdre_tools.exe");
const clientRequestOptions = { timeout: 300_000, maxTotalTimeout: 300_000 };

type AnyRecord = Record<string, any>;

interface StartedClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly root: string;
  readonly systemTemp: string;
  readonly builtinWorkspace: string;
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

async function startClient(): Promise<StartedClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-output-placement-"));
  const systemTemp = path.join(root, "system temp");
  const callerCwd = path.join(root, "caller cwd");
  await Promise.all([
    mkdir(systemTemp, { recursive: true }),
    mkdir(callerCwd, { recursive: true }),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: {
      ...inheritedEnvironment(),
      TMP: systemTemp,
      TEMP: systemTemp,
      GDRE_MCP_RUNTIME_DIR: runtimeDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "t2-output-placement", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    root,
    systemTemp,
    builtinWorkspace: path.join(systemTemp, "GodotGdreMcp"),
  };
}

async function closeClient(started: StartedClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const callTool = async (
  started: StartedClient,
  name: string,
  arguments_: AnyRecord,
): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord }> => {
  const wire = (await started.client.callTool(
    { name, arguments: arguments_ },
    clientRequestOptions,
  )) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
};

const diagnostic = (result: AnyRecord): string =>
  JSON.stringify({
    error: result?.error,
    semantic: result?.semantic,
    process: result?.process,
    stdout: result?.stdout?.text,
    stderr: result?.stderr?.text,
  });

async function walk(
  root: string,
): Promise<{ readonly files: string[]; readonly directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await visit(root, "");
  return { files, directories };
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

async function assertExtractedContent(
  destination: string,
  expectedFiles: readonly AuthoredExtractionFile[],
): Promise<void> {
  const destinationTree = await walk(destination);
  assert.deepEqual(
    [...destinationTree.files].sort(),
    [...expectedFiles.map((file) => file.relative), "gdre_export.log"].sort(),
  );
  for (const file of expectedFiles) {
    const bytes = await readFile(path.join(destination, ...file.relative.split("/")));
    assert.deepEqual(bytes, file.bytes, `exact bytes for ${file.relative}`);
    assert.equal(sha256(bytes), file.sha256, file.relative);
  }
}

const assertPositive = (
  started: StartedClient,
  wire: AnyRecord,
  result: AnyRecord,
  commandId: string,
): void => {
  assert.equal(wire.isError, false, diagnostic(result));
  assert.equal(result.success, true, diagnostic(result));
  assert.equal(result.commandId, commandId);
  assert.equal(result.status, "succeeded", diagnostic(result));
  assert.equal(result.error, null, diagnostic(result));
  assert.equal(result.process.exitCode, 0, diagnostic(result));
  assert.equal(typeof result.process.pid, "number");
  assert.equal(
    result.paths.workspace,
    started.builtinWorkspace,
    "the invocation uses the builtin temporary workspace",
  );
};

const listIfExists = async (directory: string): Promise<string[]> => {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

test("extraction defaults beside directory, multi, glob, repeated, and explicit destinations without workspace configuration", async (t) => {
  const started = await startClient();
  try {
    const inputsRoot = path.join(started.root, "inputs");
    await mkdir(inputsRoot, { recursive: true });

    await t.test("directory input default is a sibling, never a child", async () => {
      const directoryInput = path.join(inputsRoot, "project.bundle");
      await mkdir(directoryInput, { recursive: true });
      await mkdir(path.join(directoryInput, ".godot"), { recursive: true });
      const expectedFiles = [
        authoredExtractionFile("project.godot", "config_version=5\n"),
        authoredExtractionFile("data/value space.txt", "directory sibling 内容\n"),
      ];
      await writeFile(path.join(directoryInput, "project.godot"), expectedFiles[0]!.bytes);
      await mkdir(path.join(directoryInput, "data"), { recursive: true });
      await writeFile(
        path.join(directoryInput, "data", "value space.txt"),
        expectedFiles[1]!.bytes,
      );

      const { wire, result } = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "path", path: directoryInput }],
      });
      assertPositive(started, wire, result, "extract");
      const effective = result.paths.effectiveDestination as string;
      assert.equal(
        effective,
        path.join(
          inputsRoot,
          `project.bundle-extracted-${path.basename(result.paths.operation!)}`,
        ),
      );
      assert.notEqual(path.dirname(effective), directoryInput);
      assert.equal(result.paths.output, path.join(result.paths.operation!, "output"));
      assert.notEqual(effective, result.paths.output);
      await assertExtractedContent(effective, expectedFiles);
    });

    await t.test("same-parent multi-input and glob defaults share the gdre name", async () => {
      const multiRoot = path.join(inputsRoot, "multi");
      await mkdir(multiRoot, { recursive: true });
      const alphaFiles = await authorFormat2Pck(path.join(multiRoot, "alpha.pck"), [
        { relative: "alpha/one.txt", bytes: Buffer.from("alpha one\n", "utf8") },
        { relative: "alpha/共享 空间.bin", bytes: Buffer.from([0x00, 0x41, 0x42, 0xff]) },
      ]);
      const betaFiles = await authorFormat2Pck(path.join(multiRoot, "beta.pck"), [
        { relative: "beta/two.txt", bytes: Buffer.from("beta two\n", "utf8") },
        { relative: "beta/二.bin", bytes: Buffer.from([0x10, 0x20, 0x30, 0x00]) },
      ]);
      const expectedFiles = [...alphaFiles, ...betaFiles];

      const literal = await callTool(started, "gdre_extract", {
        inputs: [
          { kind: "path", path: path.join(multiRoot, "beta.pck") },
          { kind: "path", path: path.join(multiRoot, "alpha.pck") },
        ],
      });
      assertPositive(started, literal.wire, literal.result, "extract");
      const literalOutput = literal.result.paths.effectiveDestination as string;
      assert.equal(
        literalOutput,
        path.join(
          multiRoot,
          `gdre-extracted-${path.basename(literal.result.paths.operation!)}`,
        ),
      );
      await assertExtractedContent(literalOutput, expectedFiles);

      const glob = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "glob", pattern: path.join(multiRoot, "*.pck") }],
      });
      assertPositive(started, glob.wire, glob.result, "extract");
      const globOutput = glob.result.paths.effectiveDestination as string;
      assert.equal(
        globOutput,
        path.join(
          multiRoot,
          `gdre-extracted-${path.basename(glob.result.paths.operation!)}`,
        ),
      );
      await assertExtractedContent(globOutput, expectedFiles);
      assert.notEqual(literalOutput, globOutput, "repeated defaults stay distinct");

      const manifest = JSON.parse(
        await readFile(glob.result.paths.manifest!, "utf8"),
      ) as AnyRecord;
      assert.deepEqual(
        (manifest.invocation.argv as string[])
          .filter((token) => token.startsWith("--extract="))
          .map((token) => path.basename(token.slice("--extract=".length))),
        ["alpha.pck", "beta.pck"],
        "glob expansion stays ordered and absolute",
      );
    });

    await t.test("mixed primary parents require explicit output before any product exists", async () => {
      const firstRoot = path.join(inputsRoot, "mixed first");
      const secondRoot = path.join(inputsRoot, "mixed second");
      await Promise.all([
        mkdir(firstRoot, { recursive: true }),
        mkdir(secondRoot, { recursive: true }),
      ]);
      const first = path.join(firstRoot, "first.pck");
      const second = path.join(secondRoot, "second.pck");
      await authorFormat2Pck(first, [
        { relative: "first.txt", bytes: Buffer.from("first\n", "utf8") },
      ]);
      await authorFormat2Pck(second, [
        { relative: "second.txt", bytes: Buffer.from("second\n", "utf8") },
      ]);

      const { wire, result } = await callTool(started, "gdre_extract", {
        inputs: [
          { kind: "path", path: first },
          { kind: "path", path: second },
        ],
      });
      assert.equal(wire.isError, true);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "path_unsupported");
      assert.equal(result.error.stage, "validating");
      assert.equal(result.process.pid, null, "no native process was started");
      assert.match(result.error.message, /explicit output/u);
      assert.deepEqual(await listIfExists(firstRoot), ["first.pck"]);
      assert.deepEqual(await listIfExists(secondRoot), ["second.pck"]);
    });

    await t.test("repeated omitted output stays beside the input and distinct", async () => {
      const fixture = await createExtractionFixture(path.join(inputsRoot, "single"));
      const before = await sha256File(fixture.pck);
      const first = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "path", path: fixture.pck }],
      });
      assertPositive(started, first.wire, first.result, "extract");
      const second = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "path", path: fixture.pck }],
      });
      assertPositive(started, second.wire, second.result, "extract");
      for (const result of [first.result, second.result]) {
        assert.equal(
          result.paths.effectiveDestination,
          path.join(
            fixture.root,
            `authored 空间-extracted-${path.basename(result.paths.operation!)}`,
          ),
        );
        assert.notEqual(result.paths.effectiveDestination, result.paths.output);
      }
      assert.notEqual(
        first.result.paths.effectiveDestination,
        second.result.paths.effectiveDestination,
      );
      await assertExtractedContent(first.result.paths.effectiveDestination, [
        ...fixture.members.map((member) =>
          authoredExtractionFile(member.relative, member.bytes),
        ),
      ]);
      assert.equal(await sha256File(fixture.pck), before, "package input unchanged");
    });

    await t.test("explicit destinations stay exact and nonempty targets are not overwritten", async () => {
      const fixture = await createExtractionFixture(path.join(inputsRoot, "explicit"));
      const explicit = path.join(started.root, "explicit 空间", "out");
      const accepted = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "path", path: fixture.pck }],
        output: explicit,
      });
      assertPositive(started, accepted.wire, accepted.result, "extract");
      assert.equal(accepted.result.paths.effectiveDestination, explicit);
      assert.notEqual(accepted.result.paths.effectiveDestination, accepted.result.paths.output);
      await assertExtractedContent(explicit, [
        ...fixture.members.map((member) =>
          authoredExtractionFile(member.relative, member.bytes),
        ),
      ]);

      const occupied = path.join(started.root, "occupied");
      await mkdir(occupied, { recursive: true });
      await writeFile(path.join(occupied, "existing.txt"), "keep me\n", "utf8");
      const rejected = await callTool(started, "gdre_extract", {
        inputs: [{ kind: "path", path: fixture.pck }],
        output: occupied,
      });
      assert.equal(rejected.wire.isError, true);
      assert.equal(rejected.result.success, false);
      assert.equal(rejected.result.error.code, "path_unsupported");
      assert.equal(rejected.result.process.pid, null);
      assert.match(rejected.result.error.message, /not empty/u);
      assert.equal(
        await readFile(path.join(occupied, "existing.txt"), "utf8"),
        "keep me\n",
      );
    });
  } finally {
    await closeClient(started);
  }
});

test("export and standalone translation defaults follow the primary input while auxiliary files live elsewhere", async (t) => {
  const started = await startClient();
  try {
    const inputsRoot = path.join(started.root, "inputs");
    const auxiliaryRoot = path.join(started.root, "auxiliary");
    await Promise.all([
      mkdir(inputsRoot, { recursive: true }),
      mkdir(auxiliaryRoot, { recursive: true }),
    ]);

    await t.test("export hint in another directory does not choose the product parent", async () => {
      const fixture = await createExportFixture({
        root: path.join(inputsRoot, "export fixture"),
        runtimeExecutable,
      });
      const packageBefore = await sha256File(fixture.packagePath);
      const hint = path.join(auxiliaryRoot, "hints", "keys.txt");
      await mkdir(path.dirname(hint), { recursive: true });
      await writeFile(hint, "unused hint content\n", "utf8");

      const { wire, result } = await callTool(started, "gdre_export_resources", {
        inputs: [{ kind: "path", path: fixture.packagePath }],
        selection: { kind: "group", group: "scripts" },
        translationHints: [hint],
      });
      assertPositive(started, wire, result, "export-resources");
      const effective = result.paths.effectiveDestination as string;
      assert.equal(
        effective,
        path.join(
          fixture.root,
          `fixture-exported-${path.basename(result.paths.operation!)}`,
        ),
      );
      assert.notEqual(effective, result.paths.output);
      assert.equal(
        await readFile(path.join(effective, "main.gd"), "utf8"),
        fixture.script.expectedText,
      );
      const data = result.semantic.data as AnyRecord;
      assert.equal(data.outputPath, effective);
      assert.equal(await sha256File(fixture.packagePath), packageBefore);
      const manifest = JSON.parse(
        await readFile(result.paths.manifest!, "utf8"),
      ) as AnyRecord;
      assert.ok((manifest.effects.reads as string[]).includes(hint));
      assert.ok((manifest.effects.writes as string[]).includes(effective));
    });

    await t.test("standalone translation CSV in another directory does not choose the product parent", async () => {
      const fixture = await createStandaloneTranslationFixture({
        root: path.join(inputsRoot, "translation fixture"),
      });
      const packageBefore = await sha256File(fixture.packagePath);
      const csv = path.join(auxiliaryRoot, "csv", "edited.csv");
      await mkdir(path.dirname(csv), { recursive: true });
      await writeFile(csv, "en,zh,key\nEdited English,远程 CSV,A\n", "utf8");

      const { wire, result } = await callTool(started, "gdre_patch_translations", {
        inputs: [{ kind: "path", path: fixture.packagePath }],
        translations: [{ csv, resource: fixture.importSource }],
        locales: ["zh"],
      });
      assertPositive(started, wire, result, "patch-translations");
      const effective = result.paths.effectiveDestination as string;
      assert.equal(
        effective,
        path.join(
          fixture.root,
          `fixture-translations-${path.basename(result.paths.operation!)}`,
        ),
      );
      assert.notEqual(effective, result.paths.output);
      const data = result.semantic.data as AnyRecord;
      const report = JSON.parse(
        await readFile(data.reports.native as string, "utf8"),
      ) as AnyRecord;
      const output = (report.outputs as AnyRecord[])[0]!;
      assert.equal(
        output.path.replaceAll("\\", "/").toLowerCase(),
        path.join(effective, fixture.translationMembers.zh.slice("res://".length))
          .replaceAll("\\", "/")
          .toLowerCase(),
      );
      assert.equal(await sha256File(output.path as string), output.sha256);
      const read = await readTranslationOutputs({
        fixture,
        workspace: path.join(started.root, "reader operations"),
        outputs: [output.path as string],
      });
      assert.equal(read.outputs[0]!.locale, "zh");
      assert.equal(read.outputs[0]!.A, "远程 CSV");
      assert.equal(read.outputs[0]!.B, fixture.values.zh.B);
      assert.equal(await sha256File(fixture.packagePath), packageBefore);
    });
  } finally {
    await closeClient(started);
  }
});
