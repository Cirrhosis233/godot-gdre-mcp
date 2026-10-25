import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  combinedFixtureExplicitEnCsv,
  combinedFixtureOrdinaryTarget,
  combinedFixtureReplacementBytes,
  createCombinedTranslationFixture,
} from "./support/pck-patch-combined-fixtures.js";
import {
  createPckPatchFixture,
  pckPatchFixtureExpectedMetadata,
  readIndependentFormat2PckFile,
  sha256File,
} from "./support/pck-patch-fixtures.js";

/**
 * T3 acceptance through production stdio with no workspace configuration,
 * environment workspace override, or per-call workspace. Every host path is
 * absolute; the input fixture root and the process TEMP root are distinct.
 * Default package products must be written beside the admitted source and are
 * verified with the independent format-2 reader, never from product reports.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ??
  path.join(repositoryRoot, "vendor", "GDRE_tools");
const clientRequestOptions = { timeout: 300_000, maxTotalTimeout: 300_000 };

const TARGET_MEMBER = "res://data/replace.txt";

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
  const root = await mkdtemp(
    path.join(os.tmpdir(), "gdre-mcp-pck-default-output-"),
  );
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
  const client = new Client({
    name: "t3-pck-default-output",
    version: "0.1.0",
  });
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

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const callPckPatch = async (
  started: StartedClient,
  arguments_: AnyRecord,
): Promise<AnyRecord> =>
  (await started.client.callTool(
    { name: "gdre_pck_patch", arguments: arguments_ },
    clientRequestOptions,
  )) as AnyRecord;

const diagnostic = (result: AnyRecord): string =>
  JSON.stringify({
    error: result?.error,
    semantic: result?.semantic,
    stdout: result?.stdout?.text,
    stderr: result?.stderr?.text,
  });

const assertPositive = (
  started: StartedClient,
  wire: AnyRecord,
  result: AnyRecord,
): void => {
  assert.equal(wire.isError, false, diagnostic(result));
  assert.equal(result.success, true, diagnostic(result));
  assert.equal(result.status, "succeeded", diagnostic(result));
  assert.equal(result.error, null, diagnostic(result));
  assert.equal(result.process.exitCode, 0, diagnostic(result));
  assert.equal(
    result.paths.workspace,
    started.builtinWorkspace,
    "the invocation uses the builtin temporary workspace",
  );
};

const writeBomCsv = async (file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]),
    { flag: "wx" },
  );
};

const assertDefaultDestination = (
  started: StartedClient,
  expected: string,
  inputRoot: string,
  result: AnyRecord,
): void => {
  assert.equal(
    result.paths.effectiveDestination,
    expected,
    "the default package product is the proposed sibling path",
  );
  assert.equal(path.dirname(expected), inputRoot);
  assert.notEqual(path.resolve(expected), path.resolve(result.paths.output));
  assert.equal(
    isWithin(started.systemTemp, expected),
    false,
    "the product must not fall back into internal TEMP state",
  );
  assert.equal(
    existsSync(path.join(result.paths.operation, "output", "result.pck")),
    false,
    "no operation-owned default package was written",
  );
  const data = result.semantic.data as AnyRecord;
  assert.equal(data.outputPath, expected);
};

const assertArtifact = async (
  result: AnyRecord,
  output: string,
): Promise<void> => {
  assert.equal(result.artifacts.count, 1);
  assert.equal(result.artifacts.complete, true);
  const artifact = result.artifacts.items[0] as AnyRecord;
  assert.equal(path.resolve(String(artifact.path)), path.resolve(output));
  assert.equal(artifact.role, "output-package");
  const bytes = await readFile(output);
  assert.equal(artifact.bytes, bytes.byteLength);
  assert.equal(artifact.sha256, sha256(bytes));
};

test(
  "ordinary package patching defaults beside the source with no workspace configuration",
  { timeout: 300_000 },
  async (t) => {
    const started = await startClient();
    try {
      const inputRoot = path.join(started.root, "inputs");
      const fixture = await createPckPatchFixture(inputRoot);
      const before = {
        source: await sha256File(fixture.sourcePackage),
        replacement: await sha256File(fixture.replacementFile),
      };
      const input = {
        source: fixture.sourcePackage,
        patches: [
          { hostSource: fixture.replacementFile, logicalMember: TARGET_MEMBER },
        ],
      };

      await t.test("default output is a distinct sibling and verifies independently", async () => {
        const wire = await callPckPatch(started, input);
        const result = wire.structuredContent as AnyRecord;
        assertPositive(started, wire, result);
        const output = defaultPatchedOutput(
          fixture.sourcePackage,
          String(result.paths.operation),
        );
        assertDefaultDestination(started, output, inputRoot, result);

        const parsed = await readIndependentFormat2PckFile(output);
        assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata);
        const byName = new Map(
          parsed.members.map((member) => [member.logicalMember, member] as const),
        );
        assert.deepEqual(
          [...byName.keys()].sort(),
          fixture.members.map((member) => member.logicalMember).sort(),
        );
        for (const member of fixture.members) {
          const actual = byName.get(member.logicalMember);
          assert.ok(actual !== undefined, member.logicalMember);
          if (member.logicalMember === fixture.target.logicalMember) {
            assert.deepEqual(actual.bytes, fixture.replacement.bytes);
          } else {
            assert.deepEqual(actual.bytes, member.bytes, member.logicalMember);
          }
        }
        await assertArtifact(result, output);
        assert.equal(await sha256File(fixture.sourcePackage), before.source);
        assert.equal(
          await sha256File(fixture.replacementFile),
          before.replacement,
        );
      });

      await t.test("a repeated call uses a distinct sibling default", async () => {
        const first = await callPckPatch(started, input);
        const firstResult = first.structuredContent as AnyRecord;
        assertPositive(started, first, firstResult);
        const second = await callPckPatch(started, input);
        const secondResult = second.structuredContent as AnyRecord;
        assertPositive(started, second, secondResult);
        const firstOutput = defaultPatchedOutput(
          fixture.sourcePackage,
          String(firstResult.paths.operation),
        );
        const secondOutput = defaultPatchedOutput(
          fixture.sourcePackage,
          String(secondResult.paths.operation),
        );
        assert.notEqual(
          path.resolve(firstOutput),
          path.resolve(secondOutput),
          "repeated defaults stay distinct",
        );
        assertDefaultDestination(started, firstOutput, inputRoot, firstResult);
        assertDefaultDestination(started, secondOutput, inputRoot, secondResult);
        assert.equal(existsSync(firstOutput), true);
        assert.equal(existsSync(secondOutput), true);
        const parsed = await readIndependentFormat2PckFile(secondOutput);
        const target = parsed.members.find(
          (member) => member.logicalMember === fixture.target.logicalMember,
        );
        assert.ok(target !== undefined);
        assert.deepEqual(target.bytes, fixture.replacement.bytes);
        assert.equal(await sha256File(fixture.sourcePackage), before.source);
      });
    } finally {
      await closeClient(started);
    }
  },
);

test(
  "combined translation-only and mixed patching default beside the source while CSV and replacements live elsewhere",
  { timeout: 600_000 },
  async (t) => {
    const started = await startClient();
    try {
      const inputRoot = path.join(started.root, "inputs");
      const auxiliaryRoot = path.join(started.root, "auxiliary");
      const fixture = await createCombinedTranslationFixture({
        root: path.join(inputRoot, "combined"),
      });
      const csv = path.join(auxiliaryRoot, "translations.csv");
      await writeBomCsv(csv, combinedFixtureExplicitEnCsv.text);
      const sourceBefore = await sha256File(fixture.packagePath);
      const csvBefore = await sha256File(csv);
      const input = {
        source: fixture.packagePath,
        translations: [{ csv, resource: fixture.importSource }],
        locales: ["en"],
      };

      await t.test("translation-only default sits beside the source, not the CSV", async () => {
        const wire = await callPckPatch(started, {
          ...input,
          patches: [],
        });
        const result = wire.structuredContent as AnyRecord;
        assertPositive(started, wire, result);
        const output = defaultPatchedOutput(
          fixture.packagePath,
          String(result.paths.operation),
        );
        assertDefaultDestination(started, output, fixture.root, result);
        assert.equal(isWithin(auxiliaryRoot, output), false);

        const parsed = await readIndependentFormat2PckFile(output);
        assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata);
        const sourceByName = new Map(
          fixture.members.map(
            (member) => [member.logicalMember, member] as const,
          ),
        );
        const outputByName = new Map(
          parsed.members.map((member) => [member.logicalMember, member] as const),
        );
        assert.deepEqual(
          [...outputByName.keys()].sort(),
          [...sourceByName.keys()].sort(),
        );
        assert.notEqual(
          outputByName.get(fixture.translationMembers.en)!.sha256,
          sourceByName.get(fixture.translationMembers.en)!.sha256,
          "the selected en translation is regenerated",
        );
        for (const member of fixture.members) {
          if (member.logicalMember === fixture.translationMembers.en) continue;
          if (member.logicalMember === fixture.projectConfigMember) continue;
          assert.deepEqual(
            outputByName.get(member.logicalMember)!.bytes,
            member.bytes,
            member.logicalMember,
          );
        }
        await assertArtifact(result, output);
        assert.equal(await sha256File(fixture.packagePath), sourceBefore);
        assert.equal(await sha256File(csv), csvBefore);
      });

      await t.test("mixed default ignores the foreign replacement directory", async () => {
        const replacement = path.join(auxiliaryRoot, "replacement.bin");
        await writeFile(replacement, combinedFixtureReplacementBytes, {
          flag: "wx",
        });
        const replacementBefore = await sha256File(replacement);
        const wire = await callPckPatch(started, {
          ...input,
          patches: [
            {
              hostSource: replacement,
              logicalMember: combinedFixtureOrdinaryTarget,
            },
          ],
        });
        const result = wire.structuredContent as AnyRecord;
        assertPositive(started, wire, result);
        const output = defaultPatchedOutput(
          fixture.packagePath,
          String(result.paths.operation),
        );
        assertDefaultDestination(started, output, fixture.root, result);
        assert.equal(isWithin(auxiliaryRoot, output), false);

        const parsed = await readIndependentFormat2PckFile(output);
        const outputByName = new Map(
          parsed.members.map((member) => [member.logicalMember, member] as const),
        );
        assert.deepEqual(
          outputByName.get(combinedFixtureOrdinaryTarget)!.bytes,
          combinedFixtureReplacementBytes,
          "ordinary replacement bytes are exact",
        );
        assert.notEqual(
          outputByName.get(fixture.translationMembers.en)!.sha256,
          fixture.members.find(
            (member) =>
              member.logicalMember === fixture.translationMembers.en,
          )!.sha256,
        );
        assert.deepEqual(
          outputByName.get(fixture.translationMembers.zh)!.bytes,
          fixture.members.find(
            (member) =>
              member.logicalMember === fixture.translationMembers.zh,
          )!.bytes,
        );
        await assertArtifact(result, output);
        assert.equal(await sha256File(fixture.packagePath), sourceBefore);
        assert.equal(await sha256File(csv), csvBefore);
        assert.equal(await sha256File(replacement), replacementBefore);
      });
    } finally {
      await closeClient(started);
    }
  },
);
