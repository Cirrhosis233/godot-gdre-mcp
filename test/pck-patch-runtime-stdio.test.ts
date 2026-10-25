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
  createPckPatchFixture,
  pckPatchFixtureContent,
  pckPatchFixtureExpectedMetadata,
  readIndependentFormat2PckFile,
  sha256File,
  type PckPatchFixture,
} from "./support/pck-patch-fixtures.js";
import { writeIndependentPck } from "./support/extraction-fixtures.js";

/**
 * Integrated real-runtime package-patch acceptance through production MCP/stdio.
 *
 * Each test starts the unmodified production entrypoint (`dist/src/index.js`)
 * over MCP/stdio; one server handles several calls. Each package-patch call
 * lets the server launch the fixed local GDRE runtime for source inspection, the
 * direct patch plan and output inspection. Package content is never trusted from
 * runtime self-reporting: the accepted independent format-2 reader parses the
 * authored source fixture and the actual output bytes.
 *
 * Predecessor evidence already covers controlled partial output, disconnect,
 * cancellation/isolation and host-fault behaviour. This file adds only the
 * missing integrated-seam claims: complete production success with exact
 * independent content, safe destination rejection, a real fixed-runtime
 * inspection failure and an explicit deadline stop.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const defaultRuntimeDirectory = path.join(repositoryRoot, "vendor", "GDRE_tools");
const runtimeDirectory =
  process.env.GDRE_MCP_RUNTIME_DIR ?? defaultRuntimeDirectory;

const clientRequestOptions = { timeout: 180_000, maxTotalTimeout: 180_000 };
const MAX_TIMEOUT_MS = 3_600_000;
const DEADLINE_MS = 1;

const TARGET_MEMBER = "res://data/replace.txt";
const MISSING_MEMBER = "res://data/missing.txt";
const PROJECT_MEMBER = "res://project.godot";
const RETAINED_MEMBER = "res://data/keep.txt";

type AnyRecord = Record<string, any>;

interface Started {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly root: string;
  readonly workspace: string;
  readonly fixture: PckPatchFixture;
  readonly diagnostics: () => string;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes: Uint8Array): string =>
  createHash("md5").update(bytes).digest("hex");

/** Default package product beside the admitted source for one operation. */
const defaultPatchedOutput = (
  source: string,
  operationDirectory: string,
): string =>
  path.join(
    path.dirname(source),
    `${path.parse(source).name}-patched-${path.basename(operationDirectory)}.pck`,
  );

const samePath = (left: string, right: string): boolean =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

const childEnvironment = (configFile: string): Record<string, string> => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // The isolated test config owns workspace and runtime selection for this
  // server process; inherited overrides must not bypass it.
  delete environment.GDRE_MCP_RUNTIME_DIR;
  delete environment.GDRE_MCP_WORKSPACE;
  return { ...environment, GDRE_MCP_CONFIG: configFile };
};

async function startClient(): Promise<Started> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "gdre-mcp-pck-patch-runtime-stdio-"),
  );
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller-cwd");
  await mkdir(workspace, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
  const fixture = await createPckPatchFixture(path.join(root, "fixture"));
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
    args: [serverPath],
    cwd: callerCwd,
    env: childEnvironment(configFile),
    stderr: "pipe",
  });
  const client = new Client({
    name: "ticket-09d-pck-patch-runtime-stdio",
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
    root,
    workspace,
    fixture,
    diagnostics: () => diagnosticChunks.join(""),
  };
}

async function closeClient(started: Started): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const baseInput = (started: Started): AnyRecord => ({
  source: started.fixture.sourcePackage,
  patches: [
    {
      hostSource: started.fixture.replacementFile,
      logicalMember: TARGET_MEMBER,
    },
  ],
  session: [{ kind: "multithreading", disabled: true }],
});

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

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const inputHashes = async (
  fixture: PckPatchFixture,
): Promise<{ readonly source: string; readonly replacement: string }> => ({
  source: await sha256File(fixture.sourcePackage),
  replacement: await sha256File(fixture.replacementFile),
});

const assertInputsUnchanged = async (
  fixture: PckPatchFixture,
  before: { readonly source: string; readonly replacement: string },
): Promise<void> => {
  assert.equal(
    await sha256File(fixture.sourcePackage),
    before.source,
    "source package must remain unchanged",
  );
  assert.equal(
    await sha256File(fixture.replacementFile),
    before.replacement,
    "replacement host file must remain unchanged",
  );
};

/**
 * Assert a complete production success and then verify the actual package bytes
 * with the independent reader, not the runtime's own report.
 */
const assertVerifiedOutput = async (
  started: Started,
  result: AnyRecord,
  expectedOutput: string,
): Promise<void> => {
  const { fixture } = started;
  assert.equal(result.commandId, "pck-patch");
  assert.equal(result.success, true, JSON.stringify(result.error));
  assert.equal(result.status, "succeeded");
  assert.equal(result.error, null);
  assert.equal(result.runtime.health, "ready");
  assert.equal(result.runtime.actualVersion, "2.8.0-beta.2");
  assert.equal(result.persistence.state, "complete");
  assert.equal(result.cleanup.state, "confirmed");
  assert.equal(result.semantic.status, "succeeded");
  assert.match(String(result.semantic.summary), /patched the standalone package/u);

  const data = result.semantic.data as AnyRecord | null;
  assert.ok(data);
  assert.equal(data.completeness, "complete");
  assert.equal(data.outputPath, expectedOutput);
  assert.equal(result.paths.effectiveDestination, expectedOutput);
  assert.deepEqual(data.counts, {
    mappings: 1,
    verifiedReplacements: 1,
    verifiedRetainedMembers: 2,
    unverifiedFiles: 0,
  });
  assert.deepEqual(data.samples.replacements, [TARGET_MEMBER]);
  assert.deepEqual(
    [...(data.samples.retainedMembers as string[])].sort(),
    [PROJECT_MEMBER, RETAINED_MEMBER].sort(),
  );
  assert.deepEqual(data.samples.unverifiedFiles, []);
  assert.equal(data.samples.truncated, false);
  assert.deepEqual(data.diagnostics, []);

  const reports = data.reports as AnyRecord;
  for (const field of [
    "sourceInspection",
    "outputInspection",
    "verification",
  ] as const) {
    assert.equal(typeof reports[field], "string", field);
    assert.equal(existsSync(reports[field] as string), true, field);
  }

  const verification = await readJson(reports.verification as string);
  assert.equal(verification.schemaVersion, 1);
  assert.equal(verification.rule, "gdre-pck-patch-v1");
  assert.equal(verification.completeness, "complete");
  assert.equal(verification.outputPath, expectedOutput);
  assert.deepEqual(verification.verifiedReplacements, [TARGET_MEMBER]);
  assert.deepEqual(
    [...(verification.verifiedRetainedMembers as string[])].sort(),
    [PROJECT_MEMBER, RETAINED_MEMBER].sort(),
  );
  assert.equal(verification.patchProcess.exitCode, 0);
  assert.ok(verification.patchProcess.stdoutBytes > 0);
  assert.equal(verification.outputInspectionProcess.exitCode, 0);
  assert.equal(verification.outputInspectionProcess.signal, null);
  assert.equal(verification.inventoryAuditedByOperation, false);
  const mapping = verification.mappings[0] as AnyRecord;
  assert.equal(mapping.logicalMember, TARGET_MEMBER);
  assert.equal(samePath(String(mapping.hostSource), fixture.replacementFile), true);
  assert.equal(mapping.bytes, fixture.replacement.size);
  assert.equal(mapping.sha256, fixture.replacement.sha256);
  assert.equal(
    verification.sourceFingerprint.sha256,
    await sha256File(fixture.sourcePackage),
  );
  assert.equal(
    verification.replacementFingerprints[0].sha256,
    fixture.replacement.sha256,
  );

  // The actual file must exist at the accepted destination and the only
  // published artifact is that verified output package.
  const outputBytes = await readFile(expectedOutput);
  assert.equal(result.artifacts.count, 1);
  assert.equal(result.artifacts.complete, true);
  assert.equal(result.artifacts.truncated, false);
  const artifact = result.artifacts.items[0] as AnyRecord;
  assert.equal(samePath(String(artifact.path), expectedOutput), true);
  assert.equal(artifact.role, "output-package");
  assert.equal(artifact.bytes, outputBytes.byteLength);
  assert.equal(artifact.sha256, sha256(outputBytes));

  // Independent format-2 reader: inherited metadata and exact payload bytes.
  const parsed = await readIndependentFormat2PckFile(expectedOutput);
  assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata);
  const byMember = new Map(
    parsed.members.map((member) => [member.logicalMember, member]),
  );
  assert.deepEqual(
    [...byMember.keys()].sort(),
    fixture.members.map((member) => member.logicalMember).sort(),
  );
  for (const member of fixture.members) {
    const actual = byMember.get(member.logicalMember);
    assert.ok(actual !== undefined, `missing output member ${member.logicalMember}`);
    if (member.logicalMember === fixture.target.logicalMember) {
      assert.deepEqual(actual.bytes, fixture.replacement.bytes);
      assert.equal(actual.size, fixture.replacement.size);
      assert.equal(actual.sha256, fixture.replacement.sha256);
      assert.equal(actual.md5, md5(fixture.replacement.bytes));
    } else {
      assert.deepEqual(actual.bytes, member.bytes, member.logicalMember);
      assert.equal(actual.size, member.size, member.logicalMember);
      assert.equal(actual.sha256, member.sha256, member.logicalMember);
      assert.equal(actual.md5, member.md5, member.logicalMember);
    }
  }

  // The output is distinct from both inputs by path and content.
  assert.equal(samePath(expectedOutput, fixture.sourcePackage), false);
  assert.equal(samePath(expectedOutput, fixture.replacementFile), false);
  assert.notDeepEqual(outputBytes, await readFile(fixture.sourcePackage));
};

test("production MCP/stdio and the fixed runtime produce exact separate package outputs", async (t) => {
  const started = await startClient();
  try {
    await t.test(
      "omitted output creates a distinct sibling package with exact replacement, retained bytes and inherited metadata",
      async () => {
        const before = await inputHashes(started.fixture);
        const { wire, result } = await callPckPatch(started, baseInput(started));
        assert.equal(
          wire.isError,
          false,
          JSON.stringify({
            error: result?.error,
            stdout: result?.stdout?.text,
            stderr: result?.stderr?.text,
            diagnostics: started.diagnostics(),
          }),
        );
        assert.ok(result);
        const operation = result.paths.operation as string;
        assert.equal(typeof operation, "string");
        const expectedOutput = defaultPatchedOutput(
          started.fixture.sourcePackage,
          operation,
        );
        assert.equal(path.dirname(expectedOutput), started.fixture.root);
        assert.notEqual(
          expectedOutput,
          path.join(operation, "output", "result.pck"),
        );
        assert.equal(existsSync(expectedOutput), true);
        await assertVerifiedOutput(started, result, expectedOutput);
        await assertInputsUnchanged(started.fixture, before);
      },
    );

    await t.test(
      "explicit safe output is honored exactly without touching the source",
      async () => {
        const before = await inputHashes(started.fixture);
        await mkdir(path.join(started.workspace, "out"), { recursive: true });
        const explicit = path.join(started.workspace, "out", "patched.pck");
        assert.equal(existsSync(explicit), false);
        const { wire, result } = await callPckPatch(started, {
          ...baseInput(started),
          output: "out/patched.pck",
        });
        assert.equal(
          wire.isError,
          false,
          JSON.stringify({
            error: result?.error,
            stdout: result?.stdout?.text,
            stderr: result?.stderr?.text,
            diagnostics: started.diagnostics(),
          }),
        );
        assert.ok(result);
        await assertVerifiedOutput(started, result, explicit);
        await assertInputsUnchanged(started.fixture, before);
      },
    );

    await t.test(
      "a missing target member is rejected after real source inspection and creates no package",
      async () => {
        const before = await inputHashes(started.fixture);
        const { wire, result } = await callPckPatch(started, {
          ...baseInput(started),
          patches: [
            {
              hostSource: started.fixture.replacementFile,
              logicalMember: MISSING_MEMBER,
            },
          ],
        });
        assert.equal(wire.isError, true);
        assert.ok(result);
        assert.equal(result.success, false);
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "validation_failed", result.error.message);
        assert.equal(result.error.stage, "running");
        assert.match(
          String(result.error.message),
          /not an existing source member/u,
        );
        assert.equal(result.semantic.status, "failed");
        const data = result.semantic.data as AnyRecord | null;
        assert.ok(data);
        assert.equal(data.completeness, "failed");
        assert.deepEqual(data.counts, {
          mappings: 1,
          verifiedReplacements: 0,
          verifiedRetainedMembers: 0,
          unverifiedFiles: 0,
        });
        assert.equal(typeof data.reports.sourceInspection, "string");
        assert.equal(existsSync(data.reports.sourceInspection as string), true);
        assert.equal(data.reports.outputInspection, null);
        assert.equal(existsSync(data.reports.verification as string), true);
        assert.equal(existsSync(data.outputPath as string), false);
        assert.equal(result.paths.effectiveDestination, data.outputPath);
        assert.equal(result.artifacts.count, 0);
        assert.equal(result.artifacts.complete, false);

        const verification = await readJson(data.reports.verification as string);
        assert.equal(verification.stopped, false);
        assert.equal(verification.stage, "source-inspection");
        assert.equal(verification.code, "validation_failed");
        assert.equal(verification.completeness, "failed");
        assert.equal(verification.reportsParsed, true);
        await assertInputsUnchanged(started.fixture, before);
      },
    );

    await t.test(
      "an existing output is rejected before launch and keeps its bytes",
      async () => {
        const before = await inputHashes(started.fixture);
        const occupied = path.join(started.workspace, "out", "existing.pck");
        const sentinel = Buffer.from("existing output bytes must stay intact\n");
        await writeFile(occupied, sentinel);
        const { wire, result } = await callPckPatch(started, {
          ...baseInput(started),
          output: "out/existing.pck",
        });
        assert.equal(wire.isError, true);
        assert.ok(result);
        assert.equal(result.success, false);
        assert.equal(result.status, "failed");
        assert.equal(result.error.code, "path_unsupported", result.error.message);
        assert.equal(result.error.stage, "validating");
        assert.match(String(result.error.message), /output already exists/u);
        assert.equal(result.semantic.status, "not_evaluated");
        assert.equal(result.semantic.data, null);
        assert.equal(result.process.pid, null);
        assert.equal(result.paths.effectiveDestination, null);
        assert.deepEqual(await readFile(occupied), sentinel);
        await assertInputsUnchanged(started.fixture, before);
      },
    );

    await t.test(
      "an output that overlaps the source or replacement is rejected and preserved",
      async () => {
        const before = await inputHashes(started.fixture);
        for (const destructiveOutput of [
          started.fixture.sourcePackage,
          started.fixture.replacementFile,
        ]) {
          const { wire, result } = await callPckPatch(started, {
            ...baseInput(started),
            output: destructiveOutput,
          });
          assert.equal(wire.isError, true, destructiveOutput);
          assert.ok(result);
          assert.equal(result.success, false);
          assert.equal(result.status, "failed");
          assert.equal(
            result.error.code,
            "path_unsupported",
            result.error.message,
          );
          assert.match(
            String(result.error.message),
            /overlaps a host input/u,
          );
          assert.equal(result.semantic.status, "not_evaluated");
          assert.equal(result.semantic.data, null);
          assert.equal(existsSync(destructiveOutput), true);
        }
        await assertInputsUnchanged(started.fixture, before);
      },
    );
  } finally {
    await closeClient(started);
  }
});

test("production retains 09b-proven inventory-only member spellings through real package patching", async (t) => {
  const started = await startClient();
  try {
    // Source-informed regression: the accepted native inventory evidence proves
    // these retained names, while host canonicalMember previously applied the
    // stricter translation-target grammar to all inventory. Only the target is
    // an admitted mapping; the five spellings must be retained verbatim.
    const retainedSpellings = [
      ["data/equal=name.txt", "retained equals\n"],
      ["data/quote'name.txt", "retained quote\n"],
      ["data/ leading.txt", "retained leading space\n"],
      ["data/trailing.txt ", "retained trailing space\n"],
      ["data/trailing./segment.txt", "retained trailing dot\n"],
    ] as const;
    const authored = [
      {
        relative: "project.godot",
        bytes: Buffer.from(pckPatchFixtureContent.project, "utf8"),
      },
      {
        relative: "data/keep.txt",
        bytes: Buffer.from(pckPatchFixtureContent.retained, "utf8"),
      },
      {
        relative: "data/replace.txt",
        bytes: Buffer.from(pckPatchFixtureContent.target, "utf8"),
      },
      ...retainedSpellings.map(([relative, text]) => ({
        relative,
        bytes: Buffer.from(text, "utf8"),
      })),
    ];
    const expected = authored.map(({ relative, bytes }) => ({
      logicalMember: `res://${relative}`,
      bytes,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      md5: md5(bytes),
    }));
    const inventorySource = path.join(started.root, "inventory-source.pck");
    await writeIndependentPck(inventorySource, authored);
    const sourceSha = await sha256File(inventorySource);
    const replacementSha = await sha256File(started.fixture.replacementFile);

    const sourceParsed = await readIndependentFormat2PckFile(inventorySource);
    assert.deepEqual(sourceParsed.metadata, pckPatchFixtureExpectedMetadata);
    const sourceByName = new Map(
      sourceParsed.members.map((member) => [member.logicalMember, member]),
    );
    assert.deepEqual(
      [...sourceByName.keys()].sort(),
      expected.map((member) => member.logicalMember).sort(),
    );
    for (const member of expected) {
      const actual = sourceByName.get(member.logicalMember);
      assert.ok(actual !== undefined, member.logicalMember);
      assert.deepEqual(actual.bytes, member.bytes, member.logicalMember);
      assert.equal(actual.sha256, member.sha256, member.logicalMember);
    }

    const { wire, result } = await callPckPatch(started, {
      ...baseInput(started),
      source: inventorySource,
    });
    assert.equal(
      wire.isError,
      false,
      JSON.stringify({
        error: result?.error,
        semantic: result?.semantic,
        stdout: result?.stdout?.text,
        stderr: result?.stderr?.text,
      }),
    );
    assert.ok(result);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.status, "succeeded");
    assert.equal(result.semantic.status, "succeeded");
    const data = result.semantic.data as AnyRecord | null;
    assert.ok(data);
    assert.equal(data.completeness, "complete");
    const operation = result.paths.operation as string;
    const expectedOutput = defaultPatchedOutput(inventorySource, operation);
    assert.equal(data.outputPath, expectedOutput);
    assert.equal(path.dirname(expectedOutput), started.root);
    assert.deepEqual(data.counts, {
      mappings: 1,
      verifiedReplacements: 1,
      verifiedRetainedMembers: 7,
      unverifiedFiles: 0,
    });
    assert.deepEqual(data.samples.replacements, [TARGET_MEMBER]);
    assert.deepEqual(
      [...(data.samples.retainedMembers as string[])].sort(),
      expected
        .map((member) => member.logicalMember)
        .filter((member) => member !== TARGET_MEMBER)
        .sort(),
    );
    assert.equal(data.samples.truncated, false);

    // Independent literal bytes/header for the actual output, including every
    // retained spelling that is not a mapping component.
    const outputParsed = await readIndependentFormat2PckFile(expectedOutput);
    assert.deepEqual(outputParsed.metadata, pckPatchFixtureExpectedMetadata);
    const outputByName = new Map(
      outputParsed.members.map((member) => [member.logicalMember, member]),
    );
    assert.deepEqual(
      [...outputByName.keys()].sort(),
      expected.map((member) => member.logicalMember).sort(),
    );
    for (const member of expected) {
      const actual = outputByName.get(member.logicalMember);
      assert.ok(actual !== undefined, member.logicalMember);
      if (member.logicalMember === TARGET_MEMBER) {
        assert.deepEqual(actual.bytes, started.fixture.replacement.bytes);
        assert.equal(actual.sha256, started.fixture.replacement.sha256);
      } else {
        assert.deepEqual(actual.bytes, member.bytes, member.logicalMember);
        assert.equal(actual.size, member.size, member.logicalMember);
        assert.equal(actual.sha256, member.sha256, member.logicalMember);
        assert.equal(actual.md5, member.md5, member.logicalMember);
      }
    }

    const verification = await readJson(data.reports.verification as string);
    assert.equal(verification.completeness, "complete");
    assert.deepEqual(
      [...(verification.verifiedRetainedMembers as string[])].sort(),
      expected
        .map((member) => member.logicalMember)
        .filter((member) => member !== TARGET_MEMBER)
        .sort(),
    );
    assert.equal(await sha256File(inventorySource), sourceSha);
    assert.equal(await sha256File(started.fixture.replacementFile), replacementSha);
  } finally {
    await closeClient(started);
  }
});

test("the fixed runtime's real source-inspection failure stays truthful and non-mutating through production", async (t) => {
  const started = await startClient();
  try {
    const before = await inputHashes(started.fixture);
    const corruptSource = path.join(started.root, "truncated-source.pck");
    const sourceBytes = await readFile(started.fixture.sourcePackage);
    await writeFile(corruptSource, sourceBytes.subarray(0, 200));
    const corruptSha = await sha256File(corruptSource);

    const { wire, result } = await callPckPatch(started, {
      ...baseInput(started),
      source: corruptSource,
    });
    assert.equal(wire.isError, true);
    assert.ok(result);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "process_failed", result.error.message);
    assert.equal(result.error.stage, "running");
    assert.equal(result.semantic.status, "unknown");
    const data = result.semantic.data as AnyRecord | null;
    assert.ok(data);
    assert.equal(data.completeness, "unknown");
    assert.equal(data.counts.verifiedReplacements, 0);
    assert.equal(data.counts.verifiedRetainedMembers, 0);
    assert.equal(typeof data.reports.sourceInspection, "string");
    assert.equal(existsSync(data.reports.sourceInspection as string), true);
    assert.equal(data.reports.outputInspection, null);
    assert.equal(existsSync(data.outputPath as string), false);
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.cleanup.state, "confirmed");

    const verification = await readJson(data.reports.verification as string);
    assert.equal(verification.stopped, true);
    assert.equal(verification.stage, "source-inspection");
    assert.equal(verification.reportsParsed, false);
    assert.equal(verification.inputFingerprintsRechecked, false);
    assert.equal(verification.sourceReportObservation.exists, true);

    assert.equal(await sha256File(corruptSource), corruptSha);
    await assertInputsUnchanged(started.fixture, before);
  } finally {
    await closeClient(started);
  }
});

test("an explicit deadline through production stops owned work without claiming success", async (t) => {
  const started = await startClient();
  try {
    const before = await inputHashes(started.fixture);
    const { wire, result } = await callPckPatch(started, {
      ...baseInput(started),
      timeoutMs: DEADLINE_MS,
    });
    assert.equal(wire.isError, true);
    assert.ok(result);
    assert.equal(result.success, false);
    assert.equal(result.status, "timed_out");
    assert.equal(result.error.code, "execution_timeout", result.error.message);
    assert.notEqual(result.cleanup.state, "unconfirmed");
    if (result.cleanup.state === "confirmed") {
      assert.equal(result.cleanup.trigger, "timeout");
    } else {
      // No owned child was launched before the deadline expired; no cleanup
      // claim beyond that is made.
      assert.equal(result.cleanup.state, "not_needed");
    }
    assert.equal(result.artifacts.count, 0);
    assert.equal(result.artifacts.complete, false);
    if (result.semantic.data !== null) {
      assert.equal(result.semantic.data.completeness, "unknown");
    }
    if (typeof result.paths.effectiveDestination === "string") {
      assert.equal(existsSync(result.paths.effectiveDestination), false);
    }
    await assertInputsUnchanged(started.fixture, before);
  } finally {
    await closeClient(started);
  }
});
