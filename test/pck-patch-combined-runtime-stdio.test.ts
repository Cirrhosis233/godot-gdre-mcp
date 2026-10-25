import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  combinedFixtureExplicitEnCsv,
  combinedFixtureExpectedExplicitEn,
  combinedFixtureExpectedOmittedJa,
  combinedFixtureNewLocaleMember,
  combinedFixtureOmittedJaCsv,
  combinedFixtureOrdinaryTarget,
  combinedFixtureProjectMember,
  combinedFixtureReplacementBytes,
  combinedVerifyScriptPath,
  createCombinedTranslationFixture,
  runCombinedNative,
  type CombinedTranslationFixture,
} from "./support/pck-patch-combined-fixtures.js";
import {
  nativePath,
  pckPatchFixtureExpectedMetadata,
  readIndependentFormat2PckFile,
  sha256File,
} from "./support/pck-patch-fixtures.js";

/**
 * C3: production MCP/stdio combined translation/package-patch acceptance on the
 * real fixed runtime.
 *
 * Each test starts the unmodified production entrypoint (`dist/src/index.js`)
 * and lets it launch `vendor/GDRE_tools` for source inspection, combined
 * preparation, the direct combined patch, output inspection and independent
 * verification. Package content is never trusted from the product report: the
 * accepted independent format-2 reader parses actual output bytes, and native
 * getters are asked independently with authored A/B/C/en/zh literals.
 *
 * C1/C2 already prove report-shape and host semantics. This file adds only the
 * production stdio claims: translation-only success, mixed binary-config
 * success, repeated-call profile/temp isolation, and real overlapping owned
 * work where one call is cancelled and the other completes.
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
const MAX_TIMEOUT_MS = 3_600_000;

const POLL_INTERVAL_MS = 10;
const OPERATION_WAIT_MS = 60_000;
const LAUNCH_WAIT_MS = 60_000;
const PROCESS_GONE_MS = 30_000;
const MANIFEST_WAIT_MS = 60_000;

type AnyRecord = Record<string, any>;

/** Default package product beside the admitted source for one operation. */
const defaultPatchedOutput = (
  source: string,
  operationDirectory: string,
): string =>
  path.join(
    path.dirname(source),
    `${path.parse(source).name}-patched-${path.basename(operationDirectory)}.pck`,
  );

interface Started {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly root: string;
  readonly workspace: string;
  readonly diagnostics: () => string;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizePath = (value: string): string =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    path.join(os.tmpdir(), "gdre-mcp-combined-runtime-stdio-"),
  );
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller-cwd");
  await mkdir(workspace, { recursive: true });
  await mkdir(callerCwd, { recursive: true });
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
    name: "ticket-10c-combined-runtime-stdio",
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
    diagnostics: () => diagnosticChunks.join(""),
  };
}

async function closeClient(started: Started): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const callPckPatch = async (
  started: Started,
  arguments_: AnyRecord,
  signal?: AbortSignal,
): Promise<AnyRecord> =>
  (await started.client.callTool(
    { name: "gdre_pck_patch", arguments: arguments_ },
    signal === undefined
      ? clientRequestOptions
      : { ...clientRequestOptions, signal },
  )) as AnyRecord;

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const writeBomCsv = async (file: string, text: string): Promise<string> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]),
    { flag: "wx" },
  );
  return file;
};

const treeSnapshot = async (
  directory: string,
): Promise<Record<string, string>> => {
  const entries: Record<string, string> = {};
  const visit = async (current: string, prefix: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of dirents.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        entries[`d ${relative}`] = "";
        await visit(full, relative);
      } else {
        entries[`f ${relative}`] = await sha256File(full);
      }
    }
  };
  await visit(directory, "");
  return entries;
};

const packageMembers = <T extends { readonly logicalMember: string }>(
  members: readonly T[],
): Map<string, T> =>
  new Map(members.map((member) => [member.logicalMember, member] as const));

const assertRetainedBytes = (
  outputByName: ReadonlyMap<
    string,
    { readonly logicalMember: string; readonly bytes: Buffer }
  >,
  sourceMember: { readonly logicalMember: string; readonly bytes: Buffer },
  label: string,
): void => {
  const actual = outputByName.get(sourceMember.logicalMember);
  assert.ok(actual !== undefined, `${label}: missing ${sourceMember.logicalMember}`);
  assert.deepEqual(
    actual.bytes,
    sourceMember.bytes,
    `${label}: ${sourceMember.logicalMember} must be byte-identical`,
  );
};

interface AuthoredVerifySpec {
  readonly name: string;
  readonly output: {
    readonly member: string;
    readonly locale: string;
    readonly desired: Readonly<Record<string, string>>;
    readonly expectedValues: readonly string[];
  };
  readonly retainedLocales: readonly {
    readonly member: string;
    readonly locale: string;
    readonly expectedValues: readonly string[];
  }[];
  readonly projectConfig: {
    readonly member: string;
    readonly registration: readonly string[];
  } | null;
}

/**
 * Independently ask the fixed native getter reader to verify actual output
 * content against the authored literals. The product's own report is not used
 * to derive this request.
 */
const verifyWithAuthoredLiterals = async (
  root: string,
  fixture: CombinedTranslationFixture,
  outputPath: string,
  spec: AuthoredVerifySpec,
): Promise<AnyRecord> => {
  const run = await runCombinedNative({
    workspace: path.join(root, "independent-verify", spec.name),
    name: spec.name,
    scriptPath: combinedVerifyScriptPath,
    request: {
      version: 1,
      package: nativePath(outputPath),
      translations: [
        {
          resource: fixture.importSource,
          member: spec.output.member,
          locale: spec.output.locale,
          desired: { ...spec.output.desired },
          expectedValues: [...spec.output.expectedValues],
        },
      ],
      retainedLocales: spec.retainedLocales.map((entry) => ({
        resource: fixture.importSource,
        member: entry.member,
        locale: entry.locale,
        expectedValues: [...entry.expectedValues],
      })),
      projectConfig:
        spec.projectConfig === null
          ? null
          : {
              member: spec.projectConfig.member,
              registration: [...spec.projectConfig.registration],
            },
    },
  });
  assert.equal(
    run.report.ok,
    true,
    `independent authored getter verification failed: ${String(run.report.error)}`,
  );
  assert.equal(run.report.stage, "complete");
  assert.equal(run.report.nativeCode, 0);
  const outputs = run.report.outputs as AnyRecord[];
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]!.member, spec.output.member);
  assert.equal(outputs[0]!.locale, spec.output.locale);
  assert.equal(outputs[0]!.class, "OptimizedTranslation");
  assert.equal(
    outputs[0]!.verifiedTexts,
    Object.keys(spec.output.desired).length,
  );
  assert.equal(outputs[0]!.retainedContentVerified, true);
  assert.equal(
    (run.report.retainedLocales as AnyRecord[]).length,
    spec.retainedLocales.length,
  );
  for (const retained of run.report.retainedLocales as AnyRecord[]) {
    assert.equal(retained.retainedContentVerified, true, String(retained.locale));
  }
  assert.deepEqual(run.report.projectConfig, spec.projectConfig);
  return run.report;
};

const explicitEnVerifySpec = (
  projectConfig: { readonly member: string; readonly registration: readonly string[] },
): AuthoredVerifySpec => ({
  name: "explicit-en",
  output: {
    member: combinedFixtureExpectedExplicitEn.output.member,
    locale: "en",
    desired: combinedFixtureExpectedExplicitEn.output.desired,
    expectedValues: combinedFixtureExpectedExplicitEn.output.expectedValues,
  },
  retainedLocales: combinedFixtureExpectedExplicitEn.retainedLocales.map(
    (entry) => ({
      member: entry.member,
      locale: entry.locale,
      expectedValues: entry.expectedValues,
    }),
  ),
  projectConfig,
});

const omittedJaVerifySpec = (
  projectConfig: { readonly member: string; readonly registration: readonly string[] },
): AuthoredVerifySpec => ({
  name: "omitted-ja",
  output: {
    member: combinedFixtureExpectedOmittedJa.output.member,
    locale: "ja",
    desired: combinedFixtureExpectedOmittedJa.output.desired,
    expectedValues: combinedFixtureExpectedOmittedJa.output.expectedValues,
  },
  retainedLocales: combinedFixtureExpectedOmittedJa.retainedLocales.map(
    (entry) => ({
      member: entry.member,
      locale: entry.locale,
      expectedValues: entry.expectedValues,
    }),
  ),
  projectConfig,
});

const translationCsvState = async (
  data: AnyRecord,
  label: string,
): Promise<{
  readonly original: string;
  readonly prepared: string;
  readonly originalSha256: string;
  readonly preparedSha256: string;
  readonly userData: string;
  readonly tempRoot: string;
}> => {
  const items = data.translations.preparedCsvs.items as AnyRecord[];
  assert.equal(items.length, 1, `${label}: prepared CSV item count`);
  const original = String(items[0]!.original);
  const prepared = String(items[0]!.prepared);
  assert.equal(items[0]!.bomNormalized, true, `${label}: BOM normalization`);
  const reportPath = data.translations.reports.preparation;
  assert.equal(typeof reportPath, "string", `${label}: preparation report`);
  const report = await readJson(String(reportPath));
  assert.equal(report.ok, true, `${label}: preparation report is accepted`);
  assert.equal(typeof report.userData, "string", `${label}: native userData`);
  return {
    original,
    prepared,
    originalSha256: await sha256File(original),
    preparedSha256: await sha256File(prepared),
    userData: String(report.userData),
    tempRoot: path.join(String(report.userData), ".tmp_translations"),
  };
};

const assertPreparedCsv = async (
  state: Awaited<ReturnType<typeof translationCsvState>>,
  expectedText: string,
  originalBytes: Buffer,
  label: string,
): Promise<void> => {
  assert.deepEqual(
    await readFile(state.original),
    originalBytes,
    `${label}: original CSV bytes`,
  );
  assert.deepEqual(
    await readFile(state.prepared),
    Buffer.from(expectedText, "utf8"),
    `${label}: prepared CSV must be the BOM-stripped owned copy`,
  );
  assert.equal(await sha256File(state.original), state.originalSha256, label);
  assert.equal(await sha256File(state.prepared), state.preparedSha256, label);
};

const operationsRoot = (workspace: string): string =>
  path.join(workspace, ".gdre", "operations");

const listOperationIds = async (workspace: string): Promise<string[]> => {
  try {
    const entries = await readdir(operationsRoot(workspace), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const waitForNewOperation = async (
  workspace: string,
  existing: ReadonlySet<string>,
  deadlineMs = OPERATION_WAIT_MS,
): Promise<string> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const newIds = (await listOperationIds(workspace)).filter(
      (id) => !existing.has(id),
    );
    if (newIds.length > 0) return path.join(operationsRoot(workspace), newIds[0]!);
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for a new operation directory under ${operationsRoot(workspace)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

const ownershipCandidatePaths = (
  operationDirectory: string,
): readonly string[] => [
  path.join(operationDirectory, "ownership.json"),
  path.join(operationDirectory, "pck-source-inspection", "ownership.json"),
  path.join(operationDirectory, "pck-combined-preparation", "ownership.json"),
  path.join(operationDirectory, "pck-output-inspection", "ownership.json"),
  path.join(operationDirectory, "pck-combined-verification", "ownership.json"),
];

interface LiveOwnership {
  readonly statusPath: string;
  readonly pid: number;
}

/**
 * Establish an actual live owned native launch from the existing durable
 * ownership status written by the process-tree helper, corroborated by the
 * process still being alive. This is bounded polling of the authored operation
 * path, not a product-state assumption.
 */
const currentLiveOwnership = async (
  operationDirectory: string,
): Promise<LiveOwnership | undefined> => {
  for (const statusPath of ownershipCandidatePaths(operationDirectory)) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8")) as AnyRecord;
      const launch = (status.launch ?? {}) as AnyRecord;
      const root = (status.root ?? {}) as AnyRecord;
      const candidate = launch.rootPid ?? root.pid;
      if (
        launch.started === true &&
        typeof candidate === "number" &&
        candidate > 0 &&
        isAlive(candidate)
      ) {
        return { statusPath, pid: candidate };
      }
    } catch {
      // A status file that is absent or being replaced is observed again.
    }
  }
  return undefined;
};

const waitForLiveOwnership = async (
  operationDirectory: string,
  deadlineMs = LAUNCH_WAIT_MS,
): Promise<LiveOwnership> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const live = await currentLiveOwnership(operationDirectory);
    if (live !== undefined) return live;
    if (Date.now() >= deadline) {
      throw new Error(
        `no live owned launch was observed under ${operationDirectory}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

/**
 * Require both operations to own a live native child in one observation
 * window: this is the actual overlap claim, not an assumption from call order.
 */
const waitForSimultaneousLiveOwnership = async (
  firstOperation: string,
  secondOperation: string,
  deadlineMs = LAUNCH_WAIT_MS,
): Promise<{ readonly first: LiveOwnership; readonly second: LiveOwnership }> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const first = await currentLiveOwnership(firstOperation);
    const second = await currentLiveOwnership(secondOperation);
    if (first !== undefined && second !== undefined) return { first, second };
    if (Date.now() >= deadline) {
      throw new Error(
        `owned native launches never overlapped for ${firstOperation} and ${secondOperation}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

const waitForProcessGone = async (
  pid: number,
  label: string,
  deadlineMs = PROCESS_GONE_MS,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} (pid ${String(pid)}) is still alive`);
};

const waitForManifest = async (
  manifestPath: string,
  predicate: (manifest: AnyRecord) => boolean,
  deadlineMs = MANIFEST_WAIT_MS,
): Promise<AnyRecord> => {  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const manifest = await readJson(manifestPath);
      if (predicate(manifest) || Date.now() >= deadline) return manifest;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

const assertMetadata = (
  parsed: Awaited<ReturnType<typeof readIndependentFormat2PckFile>>,
  label: string,
): void => {
  assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata, label);
};

const assertOutputArtifact = async (
  result: AnyRecord,
  outputPath: string,
  label: string,
): Promise<void> => {
  assert.equal(result.artifacts.count, 1, `${label}: artifact count`);
  assert.equal(result.artifacts.complete, true, `${label}: artifacts complete`);
  assert.equal(result.artifacts.truncated, false, `${label}: artifacts truncated`);
  const artifact = result.artifacts.items[0] as AnyRecord;
  assert.equal(normalizePath(String(artifact.path)), normalizePath(outputPath));
  assert.equal(artifact.role, "output-package", `${label}: artifact role`);
  const bytes = await readFile(outputPath);
  assert.equal(artifact.bytes, bytes.byteLength, label);
  assert.equal(artifact.sha256, sha256(bytes), label);
};

const assertTranslationCounts = (
  data: AnyRecord,
  expected: {
    readonly verifiedTexts: number;
    readonly retainedLocales: number;
    readonly permittedAdditions: number;
  },
  label: string,
): void => {
  assert.deepEqual(data.translations.counts, {
    mappings: 1,
    outputs: 1,
    verifiedResources: 1,
    verifiedTexts: expected.verifiedTexts,
    retainedLocales: expected.retainedLocales,
    permittedAdditions: expected.permittedAdditions,
  }, label);
};

test(
  "production translation-only combined patch is package- and getter-verified",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-runtime-only-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const started = await startClient();
    try {
      const fixture = await createCombinedTranslationFixture({
        root: path.join(root, "fixture"),
      });
      const csvPath = path.join(started.workspace, "translations.csv");
      const csvText = combinedFixtureExplicitEnCsv.text;
      const csvBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(csvText, "utf8"),
      ]);
      await writeBomCsv(csvPath, csvText);
      const sourceSha256 = await sha256File(fixture.packagePath);

      const wire = await callPckPatch(started, {
        source: fixture.packagePath,
        patches: [],
        translations: [
          { csv: csvPath, resource: fixture.importSource },
        ],
        locales: ["en"],
      });
      const result = wire.structuredContent as AnyRecord;
      assert.equal(
        wire.isError,
        false,
        JSON.stringify({
          error: result.error,
          semantic: result.semantic,
          diagnostics: started.diagnostics(),
        }),
      );
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(result.status, "succeeded");
      assert.equal(result.error, null);
      assert.equal(result.runtime.health, "ready");
      assert.equal(result.runtime.actualVersion, "2.8.0-beta.2");
      assert.equal(result.persistence.state, "complete");
      assert.equal(result.cleanup.state, "confirmed");
      assert.equal(result.cleanup.trigger, null);
      assert.equal(result.semantic.status, "succeeded");

      const data = result.semantic.data as AnyRecord;
      assert.equal(data.completeness, "complete");
      const operation = String(result.paths.operation);
      // Output omitted: the default product sits beside the source package.
      const outputPath = defaultPatchedOutput(fixture.packagePath, operation);
      assert.equal(path.dirname(outputPath), fixture.root);
      assert.equal(data.outputPath, outputPath);
      assert.equal(result.paths.effectiveDestination, outputPath);
      assert.equal(existsSync(outputPath), true);
      assert.deepEqual(data.counts, {
        mappings: 0,
        verifiedReplacements: 0,
        verifiedRetainedMembers: 4,
        unverifiedFiles: 0,
      });
      assertTranslationCounts(
        data,
        { verifiedTexts: 2, retainedLocales: 1, permittedAdditions: 0 },
        "translation-only",
      );
      assert.deepEqual(data.translations.localeSelection, {
        mode: "explicit",
        locales: ["en"],
      });
      assert.deepEqual(data.translations.samples, {
        outputs: [combinedFixtureExpectedExplicitEn.output.member],
        permittedAdditions: [],
        retainedLocales: [
          combinedFixtureExpectedExplicitEn.retainedLocales[0]!.member,
        ],
        truncated: false,
      });

      const csvState = await translationCsvState(data, "translation-only");
      assert.equal(normalizePath(csvState.original), normalizePath(csvPath));
      assert.equal(
        isWithin(path.join(operation, "profile"), csvState.userData),
        true,
        "native userData belongs to the operation profile",
      );
      await assertPreparedCsv(csvState, csvText, csvBytes, "translation-only");
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);

      const parsed = await readIndependentFormat2PckFile(outputPath);
      assertMetadata(parsed, "translation-only metadata");
      const sourceByName = packageMembers(fixture.members);
      const outputByName = packageMembers(parsed.members);
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys()].sort(),
        "translation-only must not add or remove members",
      );
      const sourceEn = sourceByName.get(fixture.translationMembers.en)!;
      const outputEn = outputByName.get(fixture.translationMembers.en)!;
      assert.notEqual(
        outputEn.sha256,
        sourceEn.sha256,
        "selected en translation must be regenerated",
      );
      for (const member of fixture.members) {
        if (member.logicalMember === fixture.translationMembers.en) continue;
        if (member.logicalMember === fixture.projectConfigMember) continue;
        assertRetainedBytes(outputByName, member, "translation-only");
      }
      assert.deepEqual(
        outputByName.get(fixture.unrelatedMember)!.bytes,
        fixture.unrelatedBytes,
      );
      assert.deepEqual(
        outputByName.get(combinedFixtureOrdinaryTarget)!.bytes,
        fixture.ordinaryBytes,
        "translation-only must not require or mutate a dummy ordinary member",
      );
      assert.deepEqual(
        outputByName.get(fixture.importMember)!.bytes,
        Buffer.from(fixture.importText, "utf8"),
      );

      const verify = await verifyWithAuthoredLiterals(
        root,
        fixture,
        outputPath,
        explicitEnVerifySpec({
          member: combinedFixtureProjectMember,
          registration: combinedFixtureExpectedExplicitEn.registration,
        }),
      );
      const verified = (verify.outputs as AnyRecord[])[0]!;
      assert.equal(verified.verifiedTexts, 2);
      assert.equal(verified.retainedContentVerified, true);
      assert.deepEqual(verify.projectConfig, {
        member: combinedFixtureProjectMember,
        registration: combinedFixtureExpectedExplicitEn.registration,
      });

      await assertOutputArtifact(result, outputPath, "translation-only");
      const artifact = result.artifacts.items[0] as AnyRecord;
      assert.equal(artifact.sha256, sha256(await readFile(outputPath)));
      assert.equal(normalizePath(outputPath), normalizePath(data.outputPath));
      assert.notEqual(normalizePath(outputPath), normalizePath(fixture.packagePath));
      assert.notDeepEqual(
        await readFile(outputPath),
        await readFile(fixture.packagePath),
        "output must be a separate package",
      );

      // Originals and the operation-owned prepared copy remain unchanged.
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);
      await assertPreparedCsv(csvState, csvText, csvBytes, "translation-only");
      assert.equal(
        await sha256File(outputPath),
        String(artifact.sha256),
        "independent verification must not mutate the output",
      );
    } finally {
      await closeClient(started);
    }
  },
);

test(
  "production mixed combined patch keeps binary config identity and exact ordinary bytes",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-runtime-mixed-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const started = await startClient();
    try {
      const fixture = await createCombinedTranslationFixture({
        root: path.join(root, "fixture"),
        projectConfig: "binary",
      });
      assert.equal(fixture.projectConfigKind, "binary");
      assert.equal(fixture.projectConfigMember, "res://project.binary");

      const csvPath = path.join(started.workspace, "translations.csv");
      const csvText = combinedFixtureExplicitEnCsv.text;
      const csvBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(csvText, "utf8"),
      ]);
      await writeBomCsv(csvPath, csvText);
      const replacementPath = path.join(started.workspace, "replacement.bin");
      await writeFile(replacementPath, combinedFixtureReplacementBytes, {
        flag: "wx",
      });
      const replacementSha256 = await sha256File(replacementPath);
      const sourceSha256 = await sha256File(fixture.packagePath);

      const wire = await callPckPatch(started, {
        source: fixture.packagePath,
        patches: [
          {
            hostSource: replacementPath,
            logicalMember: combinedFixtureOrdinaryTarget,
          },
        ],
        translations: [
          { csv: csvPath, resource: fixture.importSource },
        ],
        locales: ["en"],
      });
      const result = wire.structuredContent as AnyRecord;
      assert.equal(
        wire.isError,
        false,
        JSON.stringify({
          error: result.error,
          semantic: result.semantic,
          diagnostics: started.diagnostics(),
        }),
      );
      assert.equal(result.success, true, JSON.stringify(result.error));
      assert.equal(result.status, "succeeded");
      const outputPath = defaultPatchedOutput(
        fixture.packagePath,
        String(result.paths.operation),
      );
      assert.equal(
        result.paths.effectiveDestination,
        outputPath,
        "the default stays beside the source, not the CSV/replacement workspace",
      );
      assert.equal(path.dirname(outputPath), fixture.root);
      assert.equal(existsSync(outputPath), true);

      const data = result.semantic.data as AnyRecord;
      assert.equal(data.completeness, "complete");
      assert.deepEqual(data.counts, {
        mappings: 1,
        verifiedReplacements: 1,
        verifiedRetainedMembers: 3,
        unverifiedFiles: 0,
      });
      assertTranslationCounts(
        data,
        { verifiedTexts: 2, retainedLocales: 1, permittedAdditions: 0 },
        "mixed",
      );
      assert.deepEqual(data.samples.replacements, [
        combinedFixtureOrdinaryTarget,
      ]);

      const csvState = await translationCsvState(data, "mixed");
      await assertPreparedCsv(csvState, csvText, csvBytes, "mixed");
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);
      assert.equal(await sha256File(replacementPath), replacementSha256);

      const parsed = await readIndependentFormat2PckFile(outputPath);
      assertMetadata(parsed, "mixed metadata");
      const sourceByName = packageMembers(fixture.members);
      const outputByName = packageMembers(parsed.members);
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys()].sort(),
        "mixed output must not add or remove members",
      );
      assert.deepEqual(
        outputByName.get(combinedFixtureOrdinaryTarget)!.bytes,
        combinedFixtureReplacementBytes,
        "ordinary replacement bytes must match the host input exactly",
      );
      assert.equal(
        outputByName.get(combinedFixtureOrdinaryTarget)!.sha256,
        replacementSha256,
      );
      assert.notEqual(
        outputByName.get(fixture.translationMembers.en)!.sha256,
        sourceByName.get(fixture.translationMembers.en)!.sha256,
        "selected en translation must be regenerated",
      );
      for (const member of fixture.members) {
        if (member.logicalMember === fixture.translationMembers.en) continue;
        if (member.logicalMember === combinedFixtureOrdinaryTarget) continue;
        if (member.logicalMember === fixture.projectConfigMember) continue;
        assertRetainedBytes(outputByName, member, "mixed");
      }
      assert.deepEqual(
        outputByName.get(fixture.unrelatedMember)!.bytes,
        fixture.unrelatedBytes,
      );
      assert.deepEqual(
        outputByName.get(fixture.importMember)!.bytes,
        Buffer.from(fixture.importText, "utf8"),
      );
      assert.ok(
        outputByName.has("res://project.binary"),
        "binary project config remains its actual identity",
      );
      assert.equal(outputByName.has("res://project.godot"), false);

      // Actual parsed binary config identity and registration are established
      // by the independent native getter request over authored literals.
      const verify = await verifyWithAuthoredLiterals(
        root,
        fixture,
        outputPath,
        explicitEnVerifySpec({
          member: "res://project.binary",
          registration: combinedFixtureExpectedExplicitEn.registration,
        }),
      );
      assert.deepEqual(verify.projectConfig, {
        member: "res://project.binary",
        registration: combinedFixtureExpectedExplicitEn.registration,
      });
      assert.equal((verify.outputs as AnyRecord[])[0]!.verifiedTexts, 2);
      assert.equal(
        (verify.retainedLocales as AnyRecord[])[0]!.retainedContentVerified,
        true,
      );

      await assertOutputArtifact(result, outputPath, "mixed");
      const artifact = result.artifacts.items[0] as AnyRecord;
      assert.equal(
        String(artifact.sha256),
        sha256(await readFile(outputPath)),
        "artifact evidence matches actual output bytes",
      );
      assert.notEqual(
        normalizePath(outputPath),
        normalizePath(fixture.packagePath),
      );
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);
      assert.equal(await sha256File(replacementPath), replacementSha256);
      await assertPreparedCsv(csvState, csvText, csvBytes, "mixed");
    } finally {
      await closeClient(started);
    }
  },
);

test(
  "repeated new-locale omission uses a distinct profile and leaves the prior output/temp unchanged",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-runtime-repeat-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const started = await startClient();
    try {
      const fixture = await createCombinedTranslationFixture({
        root: path.join(root, "fixture"),
      });
      const sourceSha256 = await sha256File(fixture.packagePath);

      const explicitCsvPath = path.join(
        started.workspace,
        "translations-explicit.csv",
      );
      const explicitCsvText = combinedFixtureExplicitEnCsv.text;
      const explicitCsvBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(explicitCsvText, "utf8"),
      ]);
      await writeBomCsv(explicitCsvPath, explicitCsvText);

      const firstWire = await callPckPatch(started, {
        source: fixture.packagePath,
        patches: [],
        translations: [
          { csv: explicitCsvPath, resource: fixture.importSource },
        ],
        locales: ["en"],
      });
      const firstResult = firstWire.structuredContent as AnyRecord;
      assert.equal(
        firstResult.success,
        true,
        JSON.stringify(firstResult.error),
      );
      const firstData = firstResult.semantic.data as AnyRecord;
      const firstOperation = String(firstResult.paths.operation);
      const firstOutput = defaultPatchedOutput(
        fixture.packagePath,
        firstOperation,
      );
      assert.equal(path.dirname(firstOutput), fixture.root);
      const firstCsvState = await translationCsvState(firstData, "first call");
      await assertPreparedCsv(
        firstCsvState,
        explicitCsvText,
        explicitCsvBytes,
        "first call",
      );
      const firstOutputSha256 = await sha256File(firstOutput);
      const firstTempSnapshot = await treeSnapshot(firstCsvState.tempRoot);
      assert.ok(
        Object.keys(firstTempSnapshot).length > 0,
        "the first call retains its generated native temp content",
      );
      assert.equal(
        existsSync(
          path.join(
            firstCsvState.tempRoot,
            combinedFixtureExpectedExplicitEn.output.member.slice(
              "res://".length,
            ),
          ),
        ),
        true,
        "the first call's known temp member is retained",
      );

      const omittedCsvPath = path.join(
        started.workspace,
        "translations-omitted.csv",
      );
      const omittedCsvText = combinedFixtureOmittedJaCsv.text;
      const omittedCsvBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(omittedCsvText, "utf8"),
      ]);
      await writeBomCsv(omittedCsvPath, omittedCsvText);

      const secondWire = await callPckPatch(started, {
        source: fixture.packagePath,
        patches: [],
        translations: [
          { csv: omittedCsvPath, resource: fixture.importSource },
        ],
      });
      const secondResult = secondWire.structuredContent as AnyRecord;
      assert.equal(
        secondWire.isError,
        false,
        JSON.stringify({
          error: secondResult.error,
          semantic: secondResult.semantic,
          diagnostics: started.diagnostics(),
        }),
      );
      assert.equal(
        secondResult.success,
        true,
        JSON.stringify(secondResult.error),
      );
      const secondData = secondResult.semantic.data as AnyRecord;
      assert.equal(secondData.completeness, "complete");
      assert.deepEqual(secondData.translations.localeSelection, {
        mode: "new-locales-only",
        locales: [],
      });
      assertTranslationCounts(
        secondData,
        { verifiedTexts: 2, retainedLocales: 2, permittedAdditions: 1 },
        "second call",
      );
      assert.deepEqual(secondData.translations.samples.outputs, [
        combinedFixtureNewLocaleMember,
      ]);
      assert.deepEqual(secondData.translations.samples.permittedAdditions, [
        combinedFixtureNewLocaleMember,
      ]);

      const secondOperation = String(secondResult.paths.operation);
      assert.notEqual(
        normalizePath(secondOperation),
        normalizePath(firstOperation),
      );
      const secondOutput = defaultPatchedOutput(
        fixture.packagePath,
        secondOperation,
      );
      assert.notEqual(
        normalizePath(secondOutput),
        normalizePath(firstOutput),
        "repeated omitted outputs stay distinct",
      );
      const secondCsvState = await translationCsvState(secondData, "second call");
      await assertPreparedCsv(
        secondCsvState,
        omittedCsvText,
        omittedCsvBytes,
        "second call",
      );

      // Operation-local profiles, native userData and the fixed
      // .tmp_translations directory are distinct.
      assert.notEqual(
        normalizePath(firstCsvState.userData),
        normalizePath(secondCsvState.userData),
      );
      assert.notEqual(
        normalizePath(firstCsvState.tempRoot),
        normalizePath(secondCsvState.tempRoot),
      );
      assert.equal(
        isWithin(path.join(firstOperation, "profile"), firstCsvState.userData),
        true,
      );
      assert.equal(
        isWithin(path.join(secondOperation, "profile"), secondCsvState.userData),
        true,
      );
      const secondTempSnapshot = await treeSnapshot(secondCsvState.tempRoot);
      assert.ok(
        Object.keys(secondTempSnapshot).length > 0,
        "the new-locale call retains its own generated temp content",
      );
      assert.equal(
        existsSync(
          path.join(
            secondCsvState.tempRoot,
            combinedFixtureNewLocaleMember.slice("res://".length),
          ),
        ),
        true,
        "new-locale temp content is written under the second profile",
      );

      // The previous call's output, prepared CSV and retained native temp are
      // unchanged by the later operation. Native temp is intentionally not
      // promised to be deleted.
      assert.equal(await sha256File(firstOutput), firstOutputSha256);
      assert.deepEqual(
        await treeSnapshot(firstCsvState.tempRoot),
        firstTempSnapshot,
        "the first call's native temp is untouched by a different-profile call",
      );
      await assertPreparedCsv(
        firstCsvState,
        explicitCsvText,
        explicitCsvBytes,
        "first call after repeat",
      );

      const parsed = await readIndependentFormat2PckFile(secondOutput);
      assertMetadata(parsed, "omitted-ja metadata");
      const sourceByName = packageMembers(fixture.members);
      const outputByName = packageMembers(parsed.members);
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys(), combinedFixtureNewLocaleMember].sort(),
        "omission adds exactly the permitted new-locale member",
      );
      assert.ok(outputByName.has(combinedFixtureNewLocaleMember));
      for (const member of fixture.members) {
        if (member.logicalMember === fixture.projectConfigMember) continue;
        assertRetainedBytes(outputByName, member, "omitted-ja");
      }

      // Authored getters prove A/B from the CSV, newer C from the default en
      // resource and the retained en/zh locales.
      const verify = await verifyWithAuthoredLiterals(
        root,
        fixture,
        secondOutput,
        omittedJaVerifySpec({
          member: combinedFixtureProjectMember,
          registration: combinedFixtureExpectedOmittedJa.registration,
        }),
      );
      const verifiedJa = (verify.outputs as AnyRecord[])[0]!;
      assert.equal(verifiedJa.locale, "ja");
      assert.equal(verifiedJa.verifiedTexts, 2);
      assert.equal(verifiedJa.retainedContentVerified, true);
      assert.deepEqual(verify.projectConfig, {
        member: combinedFixtureProjectMember,
        registration: combinedFixtureExpectedOmittedJa.registration,
      });

      assert.equal(await sha256File(fixture.packagePath), sourceSha256);
      await assertOutputArtifact(secondResult, secondOutput, "omitted-ja");
    } finally {
      await closeClient(started);
    }
  },
);

test(
  "real overlapping combined calls: cancelling one owned call leaves the other complete and isolated",
  { timeout: 900_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "gdre-mcp-combined-runtime-overlap-"),
    );
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const started = await startClient();
    const pending: Promise<unknown>[] = [];
    try {
      const fixture = await createCombinedTranslationFixture({
        root: path.join(root, "fixture"),
      });
      const csvPath = path.join(started.workspace, "translations.csv");
      const csvText = combinedFixtureExplicitEnCsv.text;
      const csvBytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(csvText, "utf8"),
      ]);
      await writeBomCsv(csvPath, csvText);
      const sourceSha256 = await sha256File(fixture.packagePath);
      await mkdir(path.join(started.workspace, "out"), { recursive: true });
      const survivorOutput = path.join(
        started.workspace,
        "out",
        "survivor.pck",
      );
      assert.equal(existsSync(survivorOutput), false);

      // --- call A: cancelled while its owned native work is actually live ---
      const existingOperations = new Set(await listOperationIds(started.workspace));
      const controller = new AbortController();
      const cancelledPromise = callPckPatch(
        started,
        {
          source: fixture.packagePath,
          patches: [],
          translations: [
            { csv: csvPath, resource: fixture.importSource },
          ],
          locales: ["en"],
        },
        controller.signal,
      )
        .then((wire) => ({ wire }))
        .catch((error: unknown) => ({ error }));
      pending.push(cancelledPromise);

      const cancelledOperation = await waitForNewOperation(
        started.workspace,
        existingOperations,
      );
      const firstLive = await waitForLiveOwnership(cancelledOperation);

      // --- call B: starts while A owns a live child and completes naturally ---
      const survivorPromise = callPckPatch(started, {
        source: fixture.packagePath,
        patches: [],
        translations: [
          { csv: csvPath, resource: fixture.importSource },
        ],
        locales: ["en"],
        output: "out/survivor.pck",
      });
      pending.push(survivorPromise);
      const survivorOperation = await waitForNewOperation(
        started.workspace,
        new Set([...existingOperations, path.basename(cancelledOperation)]),
      );
      const survivorTempRoot = path.join(
        survivorOperation,
        "profile",
        "appdata",
        "Godot",
        "app_userdata",
        "Godot RE Tools",
        ".tmp_translations",
      );

      // Actual overlap: both requests own a live native process in the same
      // observation window, and A has not already completed before the abort.
      const overlap = await waitForSimultaneousLiveOwnership(
        cancelledOperation,
        survivorOperation,
      );
      assert.equal(
        isAlive(overlap.first.pid),
        true,
        `cancelled call is still a live owned launch (${String(overlap.first.statusPath)})`,
      );
      assert.equal(
        isAlive(overlap.second.pid),
        true,
        `survivor call is still a live owned launch (${String(overlap.second.statusPath)})`,
      );
      assert.notEqual(
        normalizePath(cancelledOperation),
        normalizePath(survivorOperation),
      );

      const abortedAt = Date.now();
      controller.abort();
      const cancelledOutcome = await cancelledPromise;
      if ("wire" in cancelledOutcome) {
        const cancelledWire = cancelledOutcome.wire as AnyRecord;
        const cancelledResult = cancelledWire.structuredContent as AnyRecord;
        assert.equal(
          cancelledResult.status,
          "cancelled",
          "a client-visible stopped result must be cancelled, not successful",
        );
        assert.equal(cancelledResult.success, false);
      }

      // The survivor is independent of the cancellation and completes.
      const survivorWire = await survivorPromise;
      const survivorResult = survivorWire.structuredContent as AnyRecord;
      assert.equal(
        survivorWire.isError,
        false,
        JSON.stringify({
          error: survivorResult.error,
          semantic: survivorResult.semantic,
          diagnostics: started.diagnostics(),
        }),
      );
      assert.equal(
        survivorResult.success,
        true,
        JSON.stringify(survivorResult.error),
      );
      assert.equal(survivorResult.status, "succeeded");
      assert.equal(survivorResult.paths.effectiveDestination, survivorOutput);
      assert.equal(survivorResult.cleanup.state, "confirmed");
      assert.ok(
        Date.parse(String(survivorResult.timing.finishedAt)) >= abortedAt,
        "the survivor completed after the other call was cancelled",
      );

      // A's durable stopped manifest is truthful and owns no verified output.
      const cancelledManifest = await waitForManifest(
        path.join(cancelledOperation, "manifest.json"),
        (manifest) =>
          manifest.state === "cancelled" ||
          manifest.state === "failed" ||
          manifest.state === "interrupted",
      );
      assert.equal(cancelledManifest.state, "cancelled");
      assert.equal(cancelledManifest.success, false);
      assert.equal(cancelledManifest.status, "cancelled");
      assert.equal(cancelledManifest.error?.code, "cancelled");
      assert.equal(cancelledManifest.cleanup?.state, "confirmed");
      assert.equal(cancelledManifest.cleanup?.trigger, "cancel");
      assert.equal(cancelledManifest.artifacts?.count, 0);
      assert.deepEqual(cancelledManifest.artifacts?.items, []);
      assert.equal(cancelledManifest.artifacts?.complete, false);
      assert.notEqual(cancelledManifest.semantic?.status, "succeeded");
      if (cancelledManifest.semantic?.data !== null) {
        const cancelledData = cancelledManifest.semantic.data as AnyRecord;
        assert.notEqual(cancelledData.completeness, "complete");
        assert.equal(cancelledData.counts.verifiedReplacements, 0);
        if (cancelledData.translations !== undefined) {
          assert.equal(
            cancelledData.translations.counts.verifiedResources,
            0,
            "a stopped call publishes no verified translation resources",
          );
        }
      }
      const cancelledOutput = defaultPatchedOutput(
        fixture.packagePath,
        cancelledOperation,
      );
      // A stop may leave a partially or completely written output that was not
      // verified. It must never be published as a verified package artifact.
      if (existsSync(cancelledOutput)) {
        const stoppedData = cancelledManifest.semantic?.data as
          | AnyRecord
          | null;
        assert.ok(stoppedData !== null, "stopped output observation is bounded evidence");
        const unverified = stoppedData.samples?.unverifiedFiles as
          | string[]
          | undefined;
        assert.ok(
          Array.isArray(unverified) &&
            unverified.some(
              (file) =>
                normalizePath(String(file)) === normalizePath(cancelledOutput),
            ),
          "an existing stopped output is listed as unverified, not verified",
        );
      }
      if (typeof cancelledManifest.process?.pid === "number") {
        await waitForProcessGone(
          cancelledManifest.process.pid,
          "cancelled operation root",
        );
      }
      await waitForProcessGone(
        overlap.first.pid,
        "launch live at cancellation",
      );
      await waitForProcessGone(firstLive.pid, "observed cancelled launch");

      // B's own package, content and native temp are intact and independent.
      const survivorData = survivorResult.semantic.data as AnyRecord;
      assert.equal(survivorData.completeness, "complete");
      assertTranslationCounts(
        survivorData,
        { verifiedTexts: 2, retainedLocales: 1, permittedAdditions: 0 },
        "survivor",
      );
      const survivorCsvState = await translationCsvState(
        survivorData,
        "survivor",
      );
      await assertPreparedCsv(
        survivorCsvState,
        csvText,
        csvBytes,
        "survivor",
      );
      assert.equal(
        isWithin(
          path.join(survivorOperation, "profile"),
          survivorCsvState.userData,
        ),
        true,
      );
      assert.equal(
        normalizePath(survivorCsvState.userData) ===
          normalizePath(path.join(cancelledOperation, "profile")),
        false,
        "the survivor native userData is not the cancelled operation profile",
      );
      const cancelledProfileRoot = (
        cancelledManifest.invocation?.environmentProfile as
          | AnyRecord
          | undefined
      )?.root;
      if (typeof cancelledProfileRoot === "string") {
        assert.equal(
          normalizePath(cancelledProfileRoot),
          normalizePath(path.join(cancelledOperation, "profile")),
          "the stopped call's profile is its own operation profile",
        );
        assert.notEqual(
          normalizePath(cancelledProfileRoot),
          normalizePath(path.join(survivorOperation, "profile")),
          "the two calls use distinct operation profiles",
        );
      }
      const survivorTempSnapshot = await treeSnapshot(
        survivorCsvState.tempRoot,
      );
      assert.equal(
        normalizePath(survivorCsvState.tempRoot),
        normalizePath(survivorTempRoot),
        "the survivor temp identity is its own profile",
      );
      assert.ok(
        Object.keys(survivorTempSnapshot).length > 0,
        "the survivor's known native temp remains intact after completion",
      );
      for (const member of [
        combinedFixtureExpectedExplicitEn.output.member,
        combinedFixtureProjectMember,
      ]) {
        assert.ok(
          Object.hasOwn(
            survivorTempSnapshot,
            `f ${member.slice("res://".length)}`,
          ),
          `survivor temp retains ${member}`,
        );
      }
      const cancelledManifestJson = JSON.stringify(cancelledManifest);
      assert.equal(
        cancelledManifestJson.includes(survivorCsvState.tempRoot),
        false,
        "the stopped call never references the survivor temp",
      );
      assert.equal(
        cancelledManifestJson.includes(survivorOutput),
        false,
        "the stopped call never references the survivor output",
      );

      const parsed = await readIndependentFormat2PckFile(survivorOutput);
      assertMetadata(parsed, "survivor metadata");
      const sourceByName = packageMembers(fixture.members);
      const outputByName = packageMembers(parsed.members);
      assert.deepEqual(
        [...outputByName.keys()].sort(),
        [...sourceByName.keys()].sort(),
      );
      for (const member of fixture.members) {
        if (member.logicalMember === fixture.translationMembers.en) continue;
        if (member.logicalMember === fixture.projectConfigMember) continue;
        assertRetainedBytes(outputByName, member, "survivor");
      }
      assert.notEqual(
        outputByName.get(fixture.translationMembers.en)!.sha256,
        sourceByName.get(fixture.translationMembers.en)!.sha256,
      );
      await assertOutputArtifact(survivorResult, survivorOutput, "survivor");
      const survivorArtifact = survivorResult.artifacts.items[0] as AnyRecord;
      assert.equal(
        String(survivorArtifact.sha256),
        sha256(await readFile(survivorOutput)),
      );

      const verify = await verifyWithAuthoredLiterals(
        root,
        fixture,
        survivorOutput,
        explicitEnVerifySpec({
          member: combinedFixtureProjectMember,
          registration: combinedFixtureExpectedExplicitEn.registration,
        }),
      );
      assert.equal((verify.outputs as AnyRecord[])[0]!.verifiedTexts, 2);
      assert.deepEqual(verify.projectConfig, {
        member: combinedFixtureProjectMember,
        registration: combinedFixtureExpectedExplicitEn.registration,
      });

      // Inputs remain unchanged; a stopped output, if present, stays unverified.
      assert.equal(await sha256File(fixture.packagePath), sourceSha256);
      await assertPreparedCsv(
        survivorCsvState,
        csvText,
        csvBytes,
        "survivor after verification",
      );
      if (existsSync(cancelledOutput)) {
        const unverified = (cancelledManifest.semantic?.data as AnyRecord)
          .samples.unverifiedFiles as string[];
        assert.ok(
          unverified.some(
            (file) =>
              normalizePath(String(file)) === normalizePath(cancelledOutput),
          ),
          "the stopped output remains explicitly unverified",
        );
      }
    } finally {
      // Best-effort settle of any still-pending request before teardown.
      await Promise.allSettled(pending).catch(() => undefined);
      await closeClient(started);
    }
  },
);
