import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPckPatchPlan } from "../src/pck-patch-planning.js";
import type { OperationPaths } from "../src/storage.js";
import type { PckPatchInput } from "../src/types.js";
import { writeIndependentPck } from "./support/extraction-fixtures.js";
import {
  createPckPatchFixture,
  IndependentPckFormatError,
  inspectOwnedPck,
  nativePath,
  pckPatchFixtureContent,
  pckPatchFixtureExpectedMetadata,
  pckPatchInspectScriptPath,
  readIndependentFormat2Pck,
  readIndependentFormat2PckFile,
  runOwnedPckCommand,
  sha256File,
  type PckInspectRun,
  type PckPatchFixture,
} from "./support/pck-patch-fixtures.js";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes: Buffer): string => createHash("md5").update(bytes).digest("hex");

interface InspectorMetadata {
  readonly formatVersion: number;
  readonly engineVersion: { readonly major: number; readonly minor: number; readonly patch: number };
  readonly encrypted: boolean;
}

interface InspectorMember {
  readonly logicalMember: string;
  readonly size: number;
  readonly sha256: string;
}

interface InspectorReport {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly packagePath: string;
  readonly metadata?: InspectorMetadata;
  readonly members?: readonly InspectorMember[];
  readonly error: string | null;
}

const assertInspectorTransport = (run: PckInspectRun): void => {
  const { result } = run;
  assert.equal(result.stdout.complete, true, "stdout capture incomplete");
  assert.equal(result.stderr.complete, true, "stderr capture incomplete");
  assert.equal(result.captureError, null);
  assert.equal(result.storageError, null);
  assert.equal(result.error, null);
  assert.equal(result.cleanup.state, "confirmed", `cleanup: ${JSON.stringify(result.cleanup)}`);
};

/** Complete durable evidence, not the bounded preview in the run result. */
const readDurableStreams = async (
  operation: OperationPaths,
): Promise<{ readonly stdout: string; readonly stderr: string }> => ({
  stdout: await readFile(operation.stdoutText, "utf8"),
  stderr: await readFile(operation.stderrText, "utf8"),
});

const knownSyntheticDiagnostic = "OS_Windows::get_system_dir";

/** Mirror the accepted translation-native whitelist: only this pair is expected. */
const assertNoUnexpectedNativeErrors = (stderrText: string): void => {
  const lines = stderrText.split(/\r?\n/u);
  const unexpected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("ERROR")) continue;
    if (lines[index + 1]?.includes(knownSyntheticDiagnostic) === true) continue;
    if (line.includes(knownSyntheticDiagnostic)) continue;
    unexpected.push(line);
  }
  assert.deepEqual(unexpected, [], `unexpected native stderr:\n${stderrText}`);
};

const assertNoUnexpectedNativeStdoutErrors = (stdoutText: string, label: string): void => {
  assert.doesNotMatch(stdoutText, /^(?:ERROR|Error):/mu, `${label} printed an error line`);
};

const assertInspectSuccess = async (run: PckInspectRun, packagePath: string): Promise<InspectorReport> => {
  assertInspectorTransport(run);
  assert.equal(run.result.exitCode, 0, `inspector stderr: ${run.result.stderrText.slice(-2_000)}`);
  const streams = await readDurableStreams(run.operation);
  assertNoUnexpectedNativeErrors(streams.stderr);
  assertNoUnexpectedNativeStdoutErrors(streams.stdout, "inspector");
  const { report } = run;
  assert.ok(report !== null, `missing inspector report: ${run.reportPath}`);
  assert.deepEqual(Object.keys(report).sort(), [
    "error",
    "members",
    "metadata",
    "ok",
    "packagePath",
    "schemaVersion",
  ]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true, `inspector error: ${String(report.error)}`);
  assert.equal(report.error, null);
  assert.equal(nativePath(String(report.packagePath)).toLowerCase(), nativePath(packagePath).toLowerCase());
  const typed = report as unknown as InspectorReport;
  assert.ok(typed.metadata !== undefined);
  assert.ok(typed.members !== undefined);
  return typed;
};

const assertInspectFailure = (run: PckInspectRun, packagePath: string): InspectorReport => {
  assertInspectorTransport(run);
  assert.notEqual(run.result.exitCode, 0, "a failed inspection must not exit zero");
  const { report } = run;
  assert.ok(report !== null, `missing failure report: ${run.reportPath}`);
  assert.deepEqual(Object.keys(report).sort(), ["error", "ok", "packagePath", "schemaVersion"]);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, false);
  assert.equal(typeof report.error, "string");
  assert.ok(String(report.error).length > 0);
  assert.equal(nativePath(String(report.packagePath)).toLowerCase(), nativePath(packagePath).toLowerCase());
  return report as unknown as InspectorReport;
};

const normalizeForComparison = (value: string): string =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

/**
 * Test-composition preflight: the accepted CLI adds missing members rather than
 * rejecting them, so the acceptance transaction must establish the exact
 * existing target and a free, distinct output before launch. This is not a
 * claim about upstream native protection.
 */
const assertPrePatchAdmissible = (
  sourceReport: InspectorReport,
  fixture: PckPatchFixture,
  outputPath: string,
): void => {
  const members = sourceReport.members ?? [];
  if (!members.some((member) => member.logicalMember === fixture.target.logicalMember)) {
    throw new Error(`target logical member does not exist: ${fixture.target.logicalMember}`);
  }
  for (const protectedPath of [fixture.sourcePackage, fixture.replacementFile]) {
    if (normalizeForComparison(outputPath) === normalizeForComparison(protectedPath)) {
      throw new Error(`output collides with an input: ${outputPath}`);
    }
  }
  if (existsSync(outputPath)) throw new Error(`output already exists: ${outputPath}`);
  if (existsSync(`${outputPath}.tmp`)) {
    throw new Error(`output temporary sibling is occupied: ${outputPath}.tmp`);
  }
};

const assertPatchProcessSuccess = async (
  result: PckInspectRun["result"],
  operation: OperationPaths,
  outputPath: string,
): Promise<void> => {
  assert.equal(
    result.exitCode,
    0,
    `patch exited ${String(result.exitCode)}; stdout tail: ${result.stdoutText.slice(-2_000)}; stderr tail: ${result.stderrText.slice(-2_000)}`,
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanup.state, "confirmed", `cleanup: ${JSON.stringify(result.cleanup)}`);
  assert.equal(result.stdout.complete, true);
  assert.equal(result.stderr.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.captureError, null);
  assert.equal(result.storageError, null);
  const streams = await readDurableStreams(operation);
  assertNoUnexpectedNativeErrors(streams.stderr);
  assertNoUnexpectedNativeStdoutErrors(streams.stdout, "native patch");
  const lines = streams.stdout.split(/[\r\n]+/u);
  assert.ok(
    lines.includes(`Patched PCK file: ${outputPath}`),
    `missing success marker in durable stdout (${String(streams.stdout.length)} bytes); tail: ${streams.stdout.slice(-2_000)}`,
  );
};

test("controlled package fixture exposes literal header, metadata and payload bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-fixture-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = await createPckPatchFixture(root);
  assert.equal(fixture.target.logicalMember, "res://data/replace.txt");
  assert.equal(fixture.retained.logicalMember, "res://data/keep.txt");

  const bytes = await readFile(fixture.sourcePackage);
  // Exact layout for the authored package: 100-byte prefix, three 56-byte
  // directory entries, 20 bytes of header padding, then 32-byte aligned
  // payloads and the trailing magic.
  assert.equal(bytes.byteLength, 484);
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "GDPC");
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), 4);
  assert.equal(bytes.readUInt32LE(12), 4);
  assert.equal(bytes.readUInt32LE(16), 0);
  assert.equal(bytes.readUInt32LE(20), 0);
  assert.equal(bytes.readBigUInt64LE(24), 288n);
  assert.ok(bytes.subarray(32, 96).every((value) => value === 0), "reserved header bytes");
  assert.equal(bytes.readUInt32LE(96), 3);

  const expectedProject = Buffer.from(pckPatchFixtureContent.project, "utf8");
  const expectedRetained = Buffer.from(pckPatchFixtureContent.retained, "utf8");
  const expectedTarget = Buffer.from(pckPatchFixtureContent.target, "utf8");
  const expectedEntries = [
    { name: "project.godot", storedNameLength: 16, offset: 0n, size: 78n, bytes: expectedProject },
    { name: "data/keep.txt", storedNameLength: 16, offset: 96n, size: 48n, bytes: expectedRetained },
    { name: "data/replace.txt", storedNameLength: 16, offset: 160n, size: 27n, bytes: expectedTarget },
  ] as const;

  let cursor = 100;
  for (const entry of expectedEntries) {
    assert.equal(bytes.readUInt32LE(cursor), entry.storedNameLength, `${entry.name} stored name length`);
    cursor += 4;
    assert.equal(
      bytes.subarray(cursor, cursor + entry.storedNameLength).toString("utf8").replace(/\0+$/u, ""),
      entry.name,
    );
    cursor += entry.storedNameLength;
    assert.equal(bytes.readBigUInt64LE(cursor), entry.offset, `${entry.name} offset`);
    cursor += 8;
    assert.equal(bytes.readBigUInt64LE(cursor), entry.size, `${entry.name} size`);
    cursor += 8;
    assert.equal(bytes.subarray(cursor, cursor + 16).toString("hex"), md5(entry.bytes), `${entry.name} md5`);
    cursor += 16;
    assert.equal(bytes.readUInt32LE(cursor), 0, `${entry.name} flags`);
    cursor += 4;
  }
  assert.equal(cursor, 268);
  assert.ok(bytes.subarray(cursor, 288).every((value) => value === 0), "header alignment padding");
  assert.deepEqual(bytes.subarray(288, 288 + expectedProject.byteLength), expectedProject);
  assert.deepEqual(bytes.subarray(288 + 96, 288 + 96 + expectedRetained.byteLength), expectedRetained);
  assert.deepEqual(bytes.subarray(288 + 160, 288 + 160 + expectedTarget.byteLength), expectedTarget);
  assert.equal(bytes.subarray(bytes.byteLength - 4).toString("latin1"), "GDPC");

  const parsed = await readIndependentFormat2PckFile(fixture.sourcePackage);
  assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata);
  assert.deepEqual(
    parsed.members.map((member) => member.logicalMember),
    ["res://project.godot", "res://data/keep.txt", "res://data/replace.txt"],
  );
  assert.deepEqual(
    parsed.members.map((member) => member.storedName),
    ["project.godot", "data/keep.txt", "data/replace.txt"],
  );
  assert.deepEqual(parsed.members.map((member) => member.offset), [0, 96, 160]);
  assert.deepEqual(parsed.members.map((member) => member.size), [78, 48, 27]);
  for (const [index, member] of fixture.members.entries()) {
    const actual = parsed.members[index];
    assert.ok(actual !== undefined, `reader member ${String(index)}`);
    assert.equal(actual.logicalMember, member.logicalMember);
    assert.deepEqual(actual.bytes, member.bytes);
    assert.equal(actual.size, member.size);
    assert.equal(actual.sha256, member.sha256);
    assert.equal(actual.md5, member.md5);
  }

  // The replacement file is a distinct literal, not the retained source member.
  assert.deepEqual(await readFile(fixture.replacementFile), pckPatchFixtureContent.replacement);
  assert.equal(fixture.replacement.size, pckPatchFixtureContent.replacement.byteLength);
  assert.equal(fixture.replacement.sha256, sha256(pckPatchFixtureContent.replacement));
  assert.notDeepEqual(pckPatchFixtureContent.replacement, expectedTarget);
});

test("bounded reader rejects truncated and malformed format-2 packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-corrupt-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const original = await readFile(fixture.sourcePackage);
  const mutate = (change: (copy: Buffer) => void): Buffer => {
    const copy = Buffer.from(original);
    change(copy);
    return copy;
  };

  const cases: readonly { readonly label: string; readonly bytes: Buffer }[] = [
    { label: "truncated header", bytes: original.subarray(0, 60) },
    { label: "truncated payload", bytes: original.subarray(0, 400) },
    { label: "missing leading magic", bytes: mutate((copy) => { copy.writeUInt32LE(0, 0); }) },
    { label: "unsupported format", bytes: mutate((copy) => { copy.writeUInt32LE(3, 4); }) },
    { label: "encrypted directory flag", bytes: mutate((copy) => { copy.writeUInt32LE(1, 20); }) },
    { label: "nonzero reserved header byte", bytes: mutate((copy) => { copy[32] = 1; }) },
    { label: "member count beyond directory", bytes: mutate((copy) => { copy.writeUInt32LE(4, 96); }) },
    { label: "member size beyond package", bytes: mutate((copy) => { copy.writeBigUInt64LE(4096n, 128); }) },
    { label: "unaligned member offset", bytes: mutate((copy) => { copy.writeBigUInt64LE(1n, 120); }) },
    { label: "missing trailing magic", bytes: mutate((copy) => { copy.writeUInt32LE(0, copy.byteLength - 4); }) },
    { label: "nonzero member name padding", bytes: mutate((copy) => { copy[118] = 0x58; }) },
    {
      label: "duplicate logical member",
      bytes: mutate((copy) => { original.copy(copy, 216, 104, 120); }),
    },
    {
      label: "overlapping member payloads",
      bytes: mutate((copy) => { copy.writeBigUInt64LE(0n, 176); }),
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => readIndependentFormat2Pck(entry.bytes),
      IndependentPckFormatError,
      `${entry.label} must be rejected`,
    );
  }
});

test("fixed inspector reports the authored source package completely", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-inspect-source-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);

  const run = await inspectOwnedPck({
    workspace: path.join(root, "inspect-source"),
    packagePath: nativePath(fixture.sourcePackage),
    name: "source",
  });
  const report = await assertInspectSuccess(run, fixture.sourcePackage);

  assert.deepEqual(report.metadata, pckPatchFixtureExpectedMetadata);
  const expected = [...fixture.members]
    .map((member) => ({
      logicalMember: member.logicalMember,
      size: member.size,
      sha256: member.sha256,
    }))
    .sort((left, right) => left.logicalMember.localeCompare(right.logicalMember));
  const actual = [...(report.members ?? [])].sort((left, right) =>
    left.logicalMember.localeCompare(right.logicalMember),
  );
  assert.deepEqual(actual, expected);
  assert.ok(
    actual.some(
      (member) =>
        member.logicalMember === fixture.target.logicalMember &&
        member.sha256 === sha256(Buffer.from(pckPatchFixtureContent.target, "utf8")),
    ),
    "source report identifies the original target",
  );
  assert.ok(actual.some((member) => member.logicalMember === fixture.retained.logicalMember));
});

test("fixed inspector fails truthfully for malformed, non-PCK and encrypted inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-inspect-invalid-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const sourceBytes = await readFile(fixture.sourcePackage);

  const truncated = path.join(root, "truncated.pck");
  await writeFile(truncated, sourceBytes.subarray(0, 200));
  const encrypted = path.join(root, "encrypted-flag.pck");
  const encryptedBytes = Buffer.from(sourceBytes);
  encryptedBytes.writeUInt32LE(1, 20); // PACK_DIR_ENCRYPTED, no key
  await writeFile(encrypted, encryptedBytes);
  const directoryInput = path.join(root, "input-directory");
  await mkdir(directoryInput, { recursive: true });

  const cases: readonly { readonly label: string; readonly packagePath: string }[] = [
    { label: "truncated PCK", packagePath: truncated },
    { label: "non-PCK input", packagePath: fixture.replacementFile },
    { label: "encrypted input", packagePath: encrypted },
    { label: "directory input", packagePath: directoryInput },
  ];
  for (const entry of cases) {
    const run = await inspectOwnedPck({
      workspace: path.join(root, "inspect", entry.label.replaceAll(" ", "-")),
      packagePath: nativePath(entry.packagePath),
      name: "invalid",
    });
    assertInspectFailure(run, entry.packagePath);
  }

  // A report path that cannot be opened must exit nonzero rather than publish
  // an apparent success or silently omit the requested evidence.
  const unwritable = await inspectOwnedPck({
    workspace: path.join(root, "inspect", "unwritable-report"),
    packagePath: nativePath(fixture.sourcePackage),
    reportPath: nativePath(path.join(root, "missing-report-directory", "report.json")),
    name: "unwritable",
  });
  assertInspectorTransport(unwritable);
  assert.notEqual(unwritable.result.exitCode, 0);
  assert.equal(unwritable.report, null);

  // Invocation grammar is fixed: one report path and one package path.
  const reportPath = path.join(root, "invalid-args.json");
  const invalidArgs = await runOwnedPckCommand({
    workspace: path.join(root, "inspect", "invalid-args"),
    name: "invalid-args",
    buildArgv: () => [
      "--headless",
      "--script",
      nativePath(pckPatchInspectScriptPath),
      "--",
      nativePath(reportPath),
    ],
  });
  assertInspectorTransport({ ...invalidArgs, report: null, reportPath });
  assert.equal(invalidArgs.result.exitCode, 2);
  assert.equal(await readFile(reportPath).catch(() => null), null);
});

test("fixed inspector rejects malformed and ambiguous logical member identities", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-inspect-names-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const packageDirectory = path.join(root, "malformed");
  await mkdir(packageDirectory, { recursive: true });

  const writePackage = async (
    filename: string,
    relatives: readonly string[],
  ): Promise<string> => {
    const target = path.join(packageDirectory, filename);
    await writeIndependentPck(target, [
      { relative: "project.godot", bytes: Buffer.from(pckPatchFixtureContent.project, "utf8") },
      { relative: "data/keep.txt", bytes: Buffer.from(pckPatchFixtureContent.retained, "utf8") },
      ...relatives.map((relative, index) => ({
        relative,
        bytes: Buffer.from(`malformed member ${String(index)}: ${relative}`, "utf8"),
      })),
    ]);
    return target;
  };

  // Every case is rejected: the inspector validates the raw native file-info
  // identity before payload reads, so fix_path normalization cannot turn a
  // malformed header spelling into an accepted logical member. Mapping-only
  // restrictions (=, single quote, edge spaces, trailing-dot segments) are not
  // applied here; those spellings are valid retained inventory and are covered
  // by the positive retention test below.
  const cases: readonly { readonly label: string; readonly packagePath: string }[] = [
    { label: "dot-dot segment", packagePath: await writePackage("dotdot.pck", ["data/../bad.txt"]) },
    { label: "scheme-like bare identity", packagePath: await writePackage("scheme.pck", ["user://bad.txt"]) },
    { label: "control character", packagePath: await writePackage("control.pck", ["data/control\u0001.txt"]) },
    { label: "backslash", packagePath: await writePackage("backslash.pck", ["data/back\\slash.txt"]) },
    { label: "colon segment", packagePath: await writePackage("colon.pck", ["data/bad:name.txt"]) },
    { label: "drive-like identity", packagePath: await writePackage("drive.pck", ["C:/bad.txt"]) },
    { label: "single-dot segment", packagePath: await writePackage("singledot.pck", ["data/./bad.txt"]) },
    { label: "leading slash", packagePath: await writePackage("leading-slash.pck", ["/absolute.txt"]) },
    { label: "star", packagePath: await writePackage("star.pck", ["data/wild*card.txt"]) },
    { label: "question mark", packagePath: await writePackage("question.pck", ["data/wild?card.txt"]) },
    { label: "double quote", packagePath: await writePackage("double-quote.pck", ['data/quote"name.txt']) },
    { label: "empty segment", packagePath: await writePackage("empty-segment.pck", ["data//empty.txt"]) },
    {
      label: "exact duplicate member",
      packagePath: await writePackage("duplicate.pck", ["data/duplicate.txt", "data/duplicate.txt"]),
    },
    {
      label: "case-folded ambiguity",
      packagePath: await writePackage("case-ambiguous.pck", ["data/Keep.txt", "data/keep.txt"]),
    },
  ];

  for (const entry of cases) {
    const run = await inspectOwnedPck({
      workspace: path.join(root, "inspect", entry.label.replaceAll(/[^a-z0-9]+/giu, "-")),
      packagePath: nativePath(entry.packagePath),
      name: "malformed",
    });
    assert.notEqual(
      run.result.exitCode,
      0,
      `${entry.label} must be rejected; report: ${JSON.stringify(run.report)}; stdout tail: ${run.result.stdoutText.slice(-1_000)}; stderr tail: ${run.result.stderrText.slice(-1_000)}`,
    );
    const report = assertInspectFailure(run, entry.packagePath);
    assert.equal(
      typeof report.error,
      "string",
      `${entry.label} must produce a truthful failure report`,
    );
  }

  // The valid controlled fixture remains accepted after the malformed matrix.
  const validRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect", "valid-control"),
    packagePath: nativePath(fixture.sourcePackage),
    name: "valid",
  });
  await assertInspectSuccess(validRun, fixture.sourcePackage);
});

test("fixed inspector rejects unsupported absolute path spellings before opening evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-inspect-paths-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const sourceSha256 = await sha256File(fixture.sourcePackage);
  const tag = path.basename(root).replaceAll(/[^a-z0-9]+/giu, "-");

  // The fixed runtime is Windows: only a drive letter followed by :/ or :\ is
  // a supported local absolute path. UNC/device/rooted drive-less and
  // non-letter drives must be rejected before normalization or report open.
  const invalidReports: readonly { readonly label: string; readonly reportPath: string }[] = [
    { label: "rooted drive-less", reportPath: `\\gdre-mcp-nonexistent-${tag}\\report.json` },
    { label: "nonletter drive", reportPath: `1:/gdre-mcp-nonexistent-${tag}/report.json` },
    { label: "device", reportPath: `\\\\?\\C:\\gdre-mcp-nonexistent-${tag}\\report.json` },
    { label: "UNC", reportPath: `\\\\server\\share\\gdre-mcp-nonexistent-${tag}\\report.json` },
  ];

  for (const entry of invalidReports) {
    const command = await runOwnedPckCommand({
      workspace: path.join(root, "invalid-report", entry.label.replaceAll(/[^a-z0-9]+/giu, "-")),
      name: "invalid-report",
      buildArgv: () => [
        "--headless",
        "--script",
        nativePath(pckPatchInspectScriptPath),
        "--",
        entry.reportPath,
        nativePath(fixture.sourcePackage),
      ],
    });
    assert.equal(
      command.result.exitCode,
      2,
      `${entry.label} report path must be rejected before opening evidence; stderr: ${command.result.stderrText.slice(-2_000)}`,
    );
    assert.equal(command.result.cleanup.state, "confirmed");
    const streams = await readDurableStreams(command.operation);
    assert.ok(
      streams.stderr.includes("requires absolute report and package paths"),
      `${entry.label} rejection must be explicit in retained stderr`,
    );
    assert.equal(await sha256File(fixture.sourcePackage), sourceSha256, "input must remain unchanged");
  }

  // An unsupported package spelling with a valid report path must also fail
  // before loading the package or writing any report.
  let reportPath = "";
  const invalidPackage = `\\gdre-mcp-nonexistent-${tag}.pck`;
  const packageCommand = await runOwnedPckCommand({
    workspace: path.join(root, "invalid-package"),
    name: "invalid-package",
    buildArgv: (paths: OperationPaths) => {
      reportPath = path.join(paths.operation, "should-not-exist.json");
      return [
        "--headless",
        "--script",
        nativePath(pckPatchInspectScriptPath),
        "--",
        nativePath(reportPath),
        invalidPackage,
      ];
    },
  });
  assert.equal(
    packageCommand.result.exitCode,
    2,
    `unsupported package path must be rejected before loading; stderr: ${packageCommand.result.stderrText.slice(-2_000)}`,
  );
  assert.equal(packageCommand.result.cleanup.state, "confirmed");
  assert.equal(existsSync(reportPath), false, "no report may be written before path admission");
  assert.equal(await sha256File(fixture.sourcePackage), sourceSha256, "input must remain unchanged");
});

test("inspector and native patch retain inventory-only member spellings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-inventory-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const sourcePackage = path.join(root, "inventory-source.pck");

  // These are valid retained source identities: they are not CLI mapping
  // components, so admitted-target grammar (=, quotes, edge spaces, trailing-dot
  // segments) must not reject them.
  const retainedSpellings = [
    ["data/equal=name.txt", "retained equals\n"],
    ["data/quote'name.txt", "retained quote\n"],
    ["data/ leading.txt", "retained leading space\n"],
    ["data/trailing.txt ", "retained trailing space\n"],
    ["data/trailing./segment.txt", "retained trailing dot\n"],
  ] as const;
  const authored = [
    { relative: "project.godot", bytes: Buffer.from(pckPatchFixtureContent.project, "utf8") },
    { relative: "data/keep.txt", bytes: Buffer.from(pckPatchFixtureContent.retained, "utf8") },
    { relative: "data/replace.txt", bytes: Buffer.from(pckPatchFixtureContent.target, "utf8") },
    ...retainedSpellings.map(([relative, text]) => ({ relative, bytes: Buffer.from(text, "utf8") })),
  ];
  await writeIndependentPck(sourcePackage, authored);
  const expected = authored.map(({ relative, bytes }) => ({
    logicalMember: `res://${relative}`,
    bytes,
    size: bytes.byteLength,
    sha256: sha256(bytes),
  }));
  const sourceSha256 = await sha256File(sourcePackage);
  const replacementSha256 = await sha256File(fixture.replacementFile);
  const sourceTargetSha256 = sha256(Buffer.from(pckPatchFixtureContent.target, "utf8"));

  const assertMemberSet = (
    report: InspectorReport,
    label: string,
    targetSha256: string,
    targetSize: number,
  ): void => {
    const actualByName = new Map(
      (report.members ?? []).map((member) => [member.logicalMember, member]),
    );
    assert.deepEqual(
      [...actualByName.keys()].sort(),
      expected.map((member) => member.logicalMember).sort(),
      `${label} member identities`,
    );
    for (const member of expected) {
      const actual = actualByName.get(member.logicalMember);
      assert.ok(actual !== undefined, `${label} missing ${member.logicalMember}`);
      if (member.logicalMember === fixture.target.logicalMember) {
        assert.equal(actual.sha256, targetSha256, `${label} target bytes`);
        assert.equal(actual.size, targetSize);
      } else {
        assert.equal(actual.sha256, member.sha256, `${label} retained ${member.logicalMember}`);
        assert.equal(actual.size, member.size);
      }
    }
  };

  const sourceRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect-source"),
    packagePath: nativePath(sourcePackage),
    name: "source",
  });
  const sourceReport = await assertInspectSuccess(sourceRun, sourcePackage);
  assertMemberSet(sourceReport, "source", sourceTargetSha256, Buffer.byteLength(pckPatchFixtureContent.target));

  let outputPath = "";
  const patch = await runOwnedPckCommand({
    workspace: path.join(root, "patch-operation"),
    name: "patch",
    timeoutMs: 120_000,
    buildArgv: (paths: OperationPaths) => {
      outputPath = nativePath(path.join(paths.output, "patched.pck"));
      assertPrePatchAdmissible(sourceReport, fixture, outputPath);
      const mapping = {
        hostSource: nativePath(fixture.replacementFile),
        logicalMember: fixture.target.logicalMember,
      };
      const input: PckPatchInput = {
        source: nativePath(sourcePackage),
        patches: [mapping],
        output: outputPath,
        session: [{ kind: "multithreading", disabled: true }],
      };
      return buildPckPatchPlan({
        input,
        resolvedPckSource: nativePath(sourcePackage),
        resolvedPatches: [mapping],
        effectiveOutput: outputPath,
        operationDirectory: nativePath(paths.operation),
      }).argv;
    },
  });
  await assertPatchProcessSuccess(patch.result, patch.operation, outputPath);

  const outputRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect-output"),
    packagePath: outputPath,
    name: "output",
  });
  const outputReport = await assertInspectSuccess(outputRun, outputPath);
  assertMemberSet(outputReport, "output", fixture.replacement.sha256, fixture.replacement.size);

  const parsed = await readIndependentFormat2PckFile(outputPath);
  const parsedByName = new Map(parsed.members.map((member) => [member.logicalMember, member]));
  assert.deepEqual(parsedByName.get(fixture.target.logicalMember)?.bytes, fixture.replacement.bytes);
  for (const member of expected) {
    if (member.logicalMember === fixture.target.logicalMember) continue;
    assert.deepEqual(parsedByName.get(member.logicalMember)?.bytes, member.bytes, member.logicalMember);
  }

  assert.equal(await sha256File(sourcePackage), sourceSha256);
  assert.equal(await sha256File(fixture.replacementFile), replacementSha256);
});

test("native package patch writes exact replacement and retained bytes with inherited metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-native-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const sourceSha256 = await sha256File(fixture.sourcePackage);
  const replacementSha256 = await sha256File(fixture.replacementFile);

  const sourceRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect-source"),
    packagePath: nativePath(fixture.sourcePackage),
    name: "source",
  });
  const sourceReport = await assertInspectSuccess(sourceRun, fixture.sourcePackage);
  assert.deepEqual(sourceReport.metadata, pckPatchFixtureExpectedMetadata);

  let outputPath = "";
  const patch = await runOwnedPckCommand({
    workspace: path.join(root, "patch-operation"),
    name: "patch",
    timeoutMs: 120_000,
    buildArgv: (paths: OperationPaths) => {
      outputPath = nativePath(path.join(paths.output, "patched.pck"));
      assertPrePatchAdmissible(sourceReport, fixture, outputPath);
      const mapping = {
        hostSource: nativePath(fixture.replacementFile),
        logicalMember: fixture.target.logicalMember,
      };
      const input: PckPatchInput = {
        source: nativePath(fixture.sourcePackage),
        patches: [mapping],
        output: outputPath,
        session: [{ kind: "multithreading", disabled: true }],
      };
      return buildPckPatchPlan({
        input,
        resolvedPckSource: nativePath(fixture.sourcePackage),
        resolvedPatches: [mapping],
        effectiveOutput: outputPath,
        operationDirectory: nativePath(paths.operation),
      }).argv;
    },
  });
  await assertPatchProcessSuccess(patch.result, patch.operation, outputPath);
  assert.equal(existsSync(outputPath), true);
  assert.equal(existsSync(`${outputPath}.tmp`), false);

  const outputRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect-output"),
    packagePath: outputPath,
    name: "output",
  });
  const outputReport = await assertInspectSuccess(outputRun, outputPath);
  assert.deepEqual(outputReport.metadata, sourceReport.metadata);

  const sourceByName = new Map(
    (sourceReport.members ?? []).map((member) => [member.logicalMember, member]),
  );
  const outputByName = new Map(
    (outputReport.members ?? []).map((member) => [member.logicalMember, member]),
  );
  assert.deepEqual(
    [...outputByName.keys()].sort(),
    [...sourceByName.keys()].sort(),
    "output member set must match the source member set",
  );

  const targetBefore = sourceByName.get(fixture.target.logicalMember);
  const targetAfter = outputByName.get(fixture.target.logicalMember);
  assert.ok(targetBefore !== undefined && targetAfter !== undefined);
  assert.equal(targetAfter.size, fixture.replacement.size);
  assert.equal(targetAfter.sha256, fixture.replacement.sha256);
  assert.notEqual(targetAfter.sha256, targetBefore.sha256);

  for (const member of fixture.members) {
    if (member.logicalMember === fixture.target.logicalMember) continue;
    const before = sourceByName.get(member.logicalMember);
    const after = outputByName.get(member.logicalMember);
    assert.ok(before !== undefined && after !== undefined);
    assert.equal(after.sha256, before.sha256, `${member.logicalMember} retained bytes`);
    assert.equal(after.size, before.size);
    assert.equal(after.sha256, member.sha256);
  }

  // Independent reader agreement: metadata and actual payload bytes, not merely
  // names or runtime self-reporting.
  const parsed = await readIndependentFormat2PckFile(outputPath);
  assert.deepEqual(parsed.metadata, pckPatchFixtureExpectedMetadata);
  const parsedByName = new Map(parsed.members.map((member) => [member.logicalMember, member]));
  assert.deepEqual([...parsedByName.keys()].sort(), [...sourceByName.keys()].sort());
  assert.deepEqual(parsedByName.get(fixture.target.logicalMember)?.bytes, fixture.replacement.bytes);
  assert.deepEqual(parsedByName.get(fixture.retained.logicalMember)?.bytes, fixture.retained.bytes);
  assert.deepEqual(
    parsedByName.get("res://project.godot")?.bytes,
    Buffer.from(pckPatchFixtureContent.project, "utf8"),
  );

  assert.equal(await sha256File(fixture.sourcePackage), sourceSha256);
  assert.equal(await sha256File(fixture.replacementFile), replacementSha256);
  assert.notEqual(await sha256File(outputPath), sourceSha256);
});

test("composition rejects invalid targets/collisions before launch and stops alive native errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-pck-patch-reject-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = await createPckPatchFixture(root);
  const sourceSha256 = await sha256File(fixture.sourcePackage);
  const replacementSha256 = await sha256File(fixture.replacementFile);

  const sourceRun = await inspectOwnedPck({
    workspace: path.join(root, "inspect-source"),
    packagePath: nativePath(fixture.sourcePackage),
    name: "source",
  });
  const sourceReport = await assertInspectSuccess(sourceRun, fixture.sourcePackage);
  const candidate = path.join(root, "rejected", "patched.pck");

  assert.throws(
    () =>
      assertPrePatchAdmissible(
        {
          ...sourceReport,
          members: (sourceReport.members ?? []).filter(
            (member) => member.logicalMember !== fixture.target.logicalMember,
          ),
        },
        fixture,
        candidate,
      ),
    /target logical member does not exist/u,
  );
  assert.throws(
    () => assertPrePatchAdmissible(sourceReport, fixture, fixture.sourcePackage),
    /output collides with an input/u,
  );
  assert.throws(
    () => assertPrePatchAdmissible(sourceReport, fixture, fixture.replacementFile),
    /output collides with an input/u,
  );

  await mkdir(path.dirname(candidate), { recursive: true });
  await writeFile(candidate, "occupied output");
  assert.throws(
    () => assertPrePatchAdmissible(sourceReport, fixture, candidate),
    /output already exists/u,
  );
  await rm(candidate);
  await writeFile(`${candidate}.tmp`, "occupied temporary output");
  assert.throws(
    () => assertPrePatchAdmissible(sourceReport, fixture, candidate),
    /temporary sibling is occupied/u,
  );
  assert.equal(existsSync(candidate), false, "composition must not create an output while rejecting");

  const buildAliveErrorArgv = (): readonly string[] => [
    "--headless",
    "--no-header",
    "--",
    `--pck-patch=${nativePath(fixture.sourcePackage)}`,
    `--patch-file=${nativePath(fixture.replacementFile)}=${fixture.target.logicalMember}`,
  ];

  // An unrepresentable mapping grammar is rejected naturally; the error line is
  // retained and the process must not produce a patch output.
  let grammarOutput = "";
  const grammarRun = await runOwnedPckCommand({
    workspace: path.join(root, "invalid-grammar"),
    name: "invalid-grammar",
    buildArgv: (paths: OperationPaths) => {
      grammarOutput = nativePath(path.join(paths.output, "patched.pck"));
      return [
        "--headless",
        "--no-header",
        "--",
        `--pck-patch=${nativePath(fixture.sourcePackage)}`,
        `--output=${grammarOutput}`,
        "--patch-file=invalid=extra=equals",
      ];
    },
  });
  const grammarStreams = await readDurableStreams(grammarRun.operation);
  assert.notEqual(grammarRun.result.exitCode, 0);
  assert.equal(grammarRun.result.cleanup.state, "confirmed");
  assert.match(
    `${grammarStreams.stdout}${grammarStreams.stderr}`,
    /invalid --patch-file format/u,
  );
  assert.doesNotMatch(grammarStreams.stdout, /Patched PCK file:/u);
  assert.equal(existsSync(grammarOutput), false);
  await assert.rejects(
    () => assertPatchProcessSuccess(grammarRun.result, grammarRun.operation, grammarOutput),
    "rejected grammar must not become semantic success",
  );
  assert.equal(await sha256File(fixture.sourcePackage), sourceSha256, "source changed after grammar failure");
  assert.equal(
    await sha256File(fixture.replacementFile),
    replacementSha256,
    "replacement changed after grammar failure",
  );

  const timeoutRun = await runOwnedPckCommand({
    workspace: path.join(root, "alive-timeout"),
    name: "alive-timeout",
    timeoutMs: 5_000,
    buildArgv: buildAliveErrorArgv,
  });
  const timeoutOutput = nativePath(path.join(timeoutRun.operation.output, "patched.pck"));
  const timeoutStreams = await readDurableStreams(timeoutRun.operation);
  assert.equal(timeoutRun.result.timedOut, true);
  assert.equal(timeoutRun.result.trigger, "timeout");
  assert.equal(timeoutRun.result.cleanup.state, "confirmed");
  assert.equal(timeoutRun.result.cleanup.trigger, "timeout");
  assert.equal(timeoutRun.result.stdout.complete, true);
  assert.equal(timeoutRun.result.stderr.complete, true);
  assert.match(
    `${timeoutStreams.stdout}${timeoutStreams.stderr}`,
    /--output is required/u,
    "the alive native error is retained in durable evidence",
  );
  assert.doesNotMatch(timeoutStreams.stdout, /Patched PCK file:/u);
  assert.equal(existsSync(timeoutOutput), false);
  await assert.rejects(
    () => assertPatchProcessSuccess(timeoutRun.result, timeoutRun.operation, timeoutOutput),
    "timed-out evidence must not become semantic success",
  );
  assert.equal(await sha256File(fixture.sourcePackage), sourceSha256, "source changed after timeout stop");
  assert.equal(
    await sha256File(fixture.replacementFile),
    replacementSha256,
    "replacement changed after timeout stop",
  );

  // Synchronize cancellation with the actual alive-error line through the
  // existing StreamSink seam, so this proves alive-error cancellation rather
  // than a pre-spawn or startup-only cancel. The watchdog is a bounded budget.
  const controller = new AbortController();
  let cancelStdout = "";
  let sawAliveError = false;
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    controller.abort();
  }, 20_000);
  let cancelOutput = "";
  const cancelRun = await runOwnedPckCommand({
    workspace: path.join(root, "alive-cancel"),
    name: "alive-cancel",
    signal: controller.signal,
    onStreamText: (kind, text) => {
      if (kind !== "stdout" || sawAliveError) return;
      cancelStdout += text;
      if (cancelStdout.includes("Error: --output is required")) {
        sawAliveError = true;
        controller.abort();
      }
    },
    buildArgv: (paths: OperationPaths) => {
      cancelOutput = nativePath(path.join(paths.output, "patched.pck"));
      return buildAliveErrorArgv();
    },
  });
  clearTimeout(watchdog);
  assert.equal(watchdogFired, false, "alive error line was not observed within the test budget");
  assert.equal(sawAliveError, true, "cancellation must follow the retained alive-error line");
  const cancelStreams = await readDurableStreams(cancelRun.operation);
  assert.match(
    cancelStreams.stdout,
    /Error: --output is required/u,
    "retained stdout must contain the alive-error line",
  );
  assert.equal(cancelRun.result.timedOut, false);
  assert.equal(cancelRun.result.trigger, "cancel");
  assert.equal(cancelRun.result.cleanup.state, "confirmed");
  assert.equal(cancelRun.result.cleanup.trigger, "cancel");
  assert.equal(cancelRun.result.stdout.complete, true);
  assert.equal(cancelRun.result.stderr.complete, true);
  assert.doesNotMatch(cancelStreams.stdout, /Patched PCK file:/u);
  assert.equal(existsSync(cancelOutput), false);
  await assert.rejects(
    () => assertPatchProcessSuccess(cancelRun.result, cancelRun.operation, cancelOutput),
    "cancelled evidence must not become semantic success",
  );
  assert.equal(await sha256File(fixture.sourcePackage), sourceSha256, "source changed after cancel stop");
  assert.equal(
    await sha256File(fixture.replacementFile),
    replacementSha256,
    "replacement changed after cancel stop",
  );
});
