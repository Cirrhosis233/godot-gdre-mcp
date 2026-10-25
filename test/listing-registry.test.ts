import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  listFilesCommand,
  LIST_FILES_ARGV_PREFIX,
} from "../src/registry.js";
import {
  listFilesInputSchema,
  listFilesSemanticDataSchema,
} from "../src/schemas.js";
import type { ProcessObservation } from "../src/types.js";

const key = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
const workspace = "D:/GDRE Work/示例";
const operation = "D:/GDRE Work/示例/.gdre/operations/op";

const observation = (
  stdout: string,
  stderr = "",
  overrides: Partial<ProcessObservation> = {},
): ProcessObservation => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const listing = (
  members: readonly string[],
  total = members.length,
  opening = "Opening file: D:/fixtures/pack 空间.pck",
): string => [
  'Input files: ["D:/fixtures/pack 空间.pck"]',
  "GDRE Tools v2.8.0-beta.2",
  "Windows 10.0.26100, headless",
  opening,
  "",
  "Contents:",
  ...members,
  "",
  `Total files: ${String(total)}`,
  "",
].join("\n");

const streamEvidence = (rawPath: string, complete = true, utf8Valid = true) => ({
  rawPath,
  textPath: null,
  complete,
  utf8Valid,
});

test("list-files schema is strict, ordered, normalized, and rejects ignored fields", () => {
  const parsed = listFilesInputSchema.safeParse({
    inputs: [
      { kind: "path", path: "packs/pack = 空间.pck" },
      { kind: "glob", pattern: "packs/format-?.pck" },
      { kind: "glob", pattern: "packs/**/format-*.pck" },
    ],
    key,
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
    workspace,
    timeoutMs: 10_000,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.key, key.toLowerCase());
    assert.deepEqual(parsed.data.inputs, [
      { kind: "path", path: "packs/pack = 空间.pck" },
      { kind: "glob", pattern: "packs/format-?.pck" },
      { kind: "glob", pattern: "packs/**/format-*.pck" },
    ]);
  }

  for (const invalid of [
    {},
    { inputs: [] },
    { inputs: [{ kind: "path", path: "packs/format-*.pck" }] },
    { inputs: [{ kind: "glob", pattern: "packs/[0].pck" }] },
    { inputs: [{ kind: "path", path: " packs/pack.pck" }] },
    { inputs: [{ kind: "path", path: "packs/pack.pck " }] },
    { inputs: [{ kind: "path", path: "'packs/pack.pck'" }] },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], output: "ignored" },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], include: ["res://*"] },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], exclude: ["res://*"] },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], key: "not-a-key" },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], session: [{ kind: "setting", key: "x", value: true }] },
    { inputs: [{ kind: "path", path: "packs/pack.pck" }], unexpected: true },
  ]) {
    assert.equal(listFilesInputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
  const unmatchedQuote = listFilesInputSchema.safeParse({
    inputs: [
      { kind: "path", path: "'packs/O'Reilly.pck" },
      { kind: "path", path: "packs/pack.pck'" },
    ],
  });
  assert.equal(unmatchedQuote.success, true);
});

test("list-files planning preserves session and input order and emits shell-free argv", () => {
  const validation = listFilesCommand.validate({
    inputs: [
      { kind: "path", path: "O'Reilly.pck" },
      { kind: "glob", pattern: "packs/*.pck" },
    ],
    key,
    session: [
      { kind: "multithreading", disabled: true },
      { kind: "multithreading", disabled: false },
    ],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const plan = listFilesCommand.plan(validation.value, {
    workspace,
    operationDirectory: operation,
    resolvedInputs: [
      "D:/fixtures/O'Reilly.pck",
      "D:/fixtures/packs/one=1.pck",
      "D:/fixtures/packs/two.pck",
    ],
  });
  assert.deepEqual(plan.argv, [
    ...LIST_FILES_ARGV_PREFIX,
    "--disable-multithreading=true",
    "--disable-multithreading=false",
    "--list-files=D:/fixtures/O'Reilly.pck",
    "--list-files=D:/fixtures/packs/one=1.pck",
    "--list-files=D:/fixtures/packs/two.pck",
    `--key=${key.toLowerCase()}`,
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, undefined);
  assert.deepEqual(plan.effects.reads, [
    "D:/fixtures/O'Reilly.pck",
    "D:/fixtures/packs/one=1.pck",
    "D:/fixtures/packs/two.pck",
  ]);
  assert.deepEqual(plan.effects.writes, [operation]);
  assert.equal(plan.effects.network, false);
  assert.equal(plan.effects.codeExecution, false);
  assert.equal(plan.effects.unknownScope, false);
  assert.deepEqual(listFilesCommand.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.ok(listFilesCommand.coverage.constraints.some((constraint) => /256 groups.*64 actions.*2048 UTF-8 bytes/u.test(constraint)));
});

test("list-files semantic data is strict and bounded", () => {
  const parsed = listFilesSemanticDataSchema.safeParse({
    totalFiles: 40,
    files: ["res://one 空间.txt"],
    truncated: true,
    stdoutPath: "D:/operation/stdout.bin",
  });
  assert.equal(parsed.success, true);
  assert.equal(
    listFilesSemanticDataSchema.safeParse({
      totalFiles: 1,
      files: ["res://one"],
      truncated: false,
      stdoutPath: "D:/operation/stdout.bin",
      sha256: "made-up",
    }).success,
    false,
  );
});

test("list-files evaluator scans complete retained streams and bounds a large Unicode sample", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-list-evaluator-positive-"));
  try {
    const members = Array.from({ length: 40 }, (_, index) => `res://目录/${String(index).padStart(2, "0")} 空间😀.txt`);
    const stdoutPath = path.join(root, "stdout.bin");
    const stderrPath = path.join(root, "stderr.bin");
    await writeFile(stdoutPath, listing(members), "utf8");
    await writeFile(stderrPath, "", "utf8");
    const result = await listFilesCommand.evaluate(observation("truncated preview", "", {
      stdoutTruncated: true,
      stdoutEvidence: streamEvidence(stdoutPath),
      stderrEvidence: streamEvidence(stderrPath),
    }));
    assert.equal(result.status, "succeeded");
    assert.equal(result.rule, "gdre-list-files-v1");
    assert.deepEqual(result.data, {
      totalFiles: 40,
      files: members.slice(0, 32),
      truncated: true,
      stdoutPath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list-files evaluator accepts the observed directory opener and rejects other opener headers", async () => {
  const directory = await listFilesCommand.evaluate(observation(
    listing(
      ["res://hello 空间.txt", "res://project.godot"],
      2,
      "Opening directory: D:/fixtures/project 空间",
    ),
  ));
  assert.equal(directory.status, "succeeded");

  const malformed = await listFilesCommand.evaluate(observation(
    listing(
      ["res://hello 空间.txt", "res://project.godot"],
      2,
      "Opening archive: D:/fixtures/project 空间",
    ),
  ));
  assert.equal(malformed.status, "unknown");
});

test("list-files evaluator corroborates expected loader paths with case/separator normalization", async () => {
  const expected = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"], 2, "Opening file: D:/fixtures/pack 空间.pck"),
    "",
    {
      expectedLoads: [{ path: "d:\\FIXTURES\\Pack 空间.pck", kind: "file", role: "input" }],
    },
  ));
  assert.equal(expected.status, "succeeded");

  const mismatch = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"]),
    "",
    {
      expectedLoads: [{ path: "D:/fixtures/other.pck", kind: "file", role: "input" }],
    },
  ));
  assert.equal(mismatch.status, "unknown");

  const secret = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  const redacted = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"], 2, `Opening file: D:/fixtures/${secret}.pck`),
    "",
    {
      expectedLoads: [{ path: `D:/fixtures/${secret}.pck`, kind: "file", role: "input" }],
      redactText: (text) => text.replaceAll(secret, "<redacted>"),
    },
  ));
  assert.equal(redacted.status, "succeeded");
  const exeSidecarMismatch = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"], 2, "Opening file: D:/fixtures/game.exe"),
    "",
    {
      expectedLoads: [
        { path: "D:/fixtures/game.exe", kind: "file", role: "input" },
        { path: "D:/fixtures/game.pck", kind: "file", role: "dependency" },
      ],
    },
  ));
  assert.equal(exeSidecarMismatch.status, "unknown");
});

test("list-files evaluator bounds excessive opening-header observations", async () => {
  const openings = Array.from({ length: 200 }, (_, index) => `Opening file: D:/fixtures/${String(index)}.pck`);
  const stdout = [
    'Input files: ["D:/fixtures/pack.pck"]',
    "GDRE Tools v2.8.0-beta.2",
    "Windows 10.0.26100, headless",
    ...openings,
    "",
    "Contents:",
    "res://project.godot",
    "",
    "Total files: 1",
    "",
  ].join("\n");
  const result = await listFilesCommand.evaluate(observation(stdout));
  assert.equal(result.status, "unknown");
});
test("list-files evaluator omits oversized member names instead of cutting a sensitive sample", async () => {
  const oversized = `res://${"x".repeat(3_000)}`;
  const result = await listFilesCommand.evaluate(observation(listing([oversized])));
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.data, {
    totalFiles: 1,
    files: [],
    truncated: true,
    stdoutPath: "inline://stdout",
  });
});

test("list-files evaluator accepts only the exact known profile diagnostic", async () => {
  const accepted = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      'ERROR: Condition "res != ((HRESULT)0L)" is true.',
      "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
    ].join("\n"),
  ));
  assert.equal(accepted.status, "succeeded");

  const acceptedReturningVariant = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
      "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
      'ERROR: Condition "res != ((HRESULT)0L)" is true. Returning: String()',
      "   at: OS_Windows::get_system_dir (platform\\windows\\os_windows.cpp:2511)",
    ].join("\n"),
  ));
  assert.equal(acceptedReturningVariant.status, "succeeded");

  const rejected = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    "ERROR: unrelated load failure\n",
  ));
  assert.notEqual(rejected.status, "succeeded");
  assert.match(rejected.summary, /stderr|diagnostic|error/iu);
});

test("list-files evaluator treats unclassified stderr warnings and info as unknown", async () => {
  const warning = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"]),
    "WARNING: unclassified metadata notice\n",
  ));
  assert.equal(warning.status, "unknown");
  assert.match(warning.summary, /unclassified diagnostic|cannot confirm/iu);
  assert.ok(warning.evidence.some((entry) => entry.includes("unclassified metadata notice")));

  const info = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"]),
    "INFO: informational runtime note\n",
  ));
  assert.equal(info.status, "unknown");
  assert.match(info.summary, /unclassified diagnostic|cannot confirm/iu);
});

test("list-files evaluator keeps clear stderr ERROR diagnostics as failed", async () => {
  const error = await listFilesCommand.evaluate(observation(
    listing(["res://hello 空间.txt", "res://project.godot"]),
    "ERROR: failed to load the selected input\n",
  ));
  assert.equal(error.status, "failed");
  assert.match(error.summary, /listing\/load error/iu);
});

test("list-files accepts only the observed fallback, sidecar, and optional XAPK diagnostics", async () => {
  const fallback = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      "WARNING: Contents/Resources directory not found in .app bundle, searching for pck in root...",
      "   at: GDRESettings::sort_and_validate_pck_files (modules\\gdsdecomp\\utility\\gdre_settings.cpp:516)",
    ].join("\n"),
  ));
  assert.equal(fallback.status, "succeeded");

  const sidecar = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      "WARNING: Could not find embedded pck in EXE, found pck file, loading from: D:/fixtures/sidecar.pck",
      "   at: GDRESettings::sort_and_validate_pck_files (modules\\gdsdecomp\\utility\\gdre_settings.cpp:613)",
    ].join("\n"),
  ));
  assert.equal(sidecar.status, "succeeded");
  assert.ok(sidecar.evidence.some((entry) => entry.includes("D:/fixtures/sidecar.pck")));

  const xapk = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      "ERROR: File does not exist in zip archive: AndroidManifest.xml",
      "   at: ZIPReader::read_file (modules\\zip\\zip_reader.cpp:99)",
      "WARNING: Failed to parse base APK manifest!",
      "   at: APKArchive::handle_xapk (modules\\gdsdecomp\\utility\\file_access_apk.cpp:307)",
      "WARNING: Could not retrieve version string from AndroidManifest.xml",
      "   at: APKArchive::try_open_pack (modules\\gdsdecomp\\utility\\file_access_apk.cpp:421)",
    ].join("\n"),
  ));
  assert.equal(xapk.status, "succeeded");

  const partialXapk = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    [
      "ERROR: File does not exist in zip archive: AndroidManifest.xml",
      "   at: ZIPReader::read_file (modules\\zip\\zip_reader.cpp:99)",
      "WARNING: Failed to parse base APK manifest!",
    ].join("\n"),
  ));
  assert.notEqual(partialXapk.status, "succeeded");

  const partialSidecar = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    "WARNING: Could not find embedded pck in EXE, found pck file, loading from: D:/fixtures/sidecar.pck",
  ));
  assert.notEqual(partialSidecar.status, "succeeded");

  const arbitraryFailedOpen = await listFilesCommand.evaluate(observation(
    listing(["res://project.godot"]),
    "ERROR: failed to open an unrelated file",
  ));
  assert.notEqual(arbitraryFailedOpen.status, "succeeded");
});

test("list-files evaluator rejects load errors, empty/ambiguous output, and incomplete evidence", async () => {
  const wrongKey = await listFilesCommand.evaluate(observation(
    [listing([]), "Error: failed to open [\"encrypted.pck\"]"].join("\n"),
    "ERROR: The MD5 sum of the decrypted file does not match the expected value.\n",
  ));
  assert.notEqual(wrongKey.status, "succeeded");

  const empty = await listFilesCommand.evaluate(observation(listing([])));
  assert.equal(empty.status, "unknown");

  const mismatch = await listFilesCommand.evaluate(observation(listing(["res://one"]), "", {
    stdoutEvidence: { rawPath: "D:/missing/stdout.bin", textPath: null, complete: true, utf8Valid: true },
  }));
  assert.equal(mismatch.status, "unknown");

  const incomplete = await listFilesCommand.evaluate(observation(listing(["res://one"]), "", {
    stdoutEvidence: { rawPath: null, textPath: null, complete: false, utf8Valid: true },
  }));
  assert.equal(incomplete.status, "unknown");
});

test("list-files redacts complete diagnostic lines before bounded evidence storage", async () => {
  const diagnostic = [
    `WARNING: Could not find embedded pck in EXE, found pck file, loading from: D:/fixtures/${"x".repeat(2_000)}${key}`,
    "   at: GDRESettings::sort_and_validate_pck_files (modules\\gdsdecomp\\utility\\gdre_settings.cpp:613)",
  ].join("\n");
  const result = await listFilesCommand.evaluate(observation(listing(["res://project.godot"]), diagnostic, {
    redactText: (text) => text.replaceAll(key, "<redacted>"),
  }));
  assert.equal(result.status, "succeeded");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes(key.slice(0, 8)), false);
  const missing = await listFilesCommand.evaluate(observation(listing(["res://project.godot"]), "", {
    stdoutEvidence: {
      rawPath: `D:/missing/${key}.bin`,
      textPath: null,
      complete: true,
      utf8Valid: true,
    },
    redactText: (text) => text.replaceAll(key, "<redacted>"),
  }));
  const missingSerialized = JSON.stringify(missing);
  assert.notEqual(missing.status, "succeeded");
  assert.equal(missingSerialized.includes(key), false);
  assert.equal(missingSerialized.includes(key.slice(0, 8)), false);
});

test("list-files evaluator preserves invalid UTF-8 and cancellation/deadline as unknown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-list-evaluator-bounds-"));
  try {
    const stdoutPath = path.join(root, "invalid.bin");
    await writeFile(stdoutPath, Buffer.from([0xc3, 0x28]));
    const invalid = await listFilesCommand.evaluate(observation("", "", {
      stdoutEvidence: streamEvidence(stdoutPath),
    }));
    assert.equal(invalid.status, "unknown");

    const cancelledController = new AbortController();
    cancelledController.abort("cancelled");
    const cancelled = await listFilesCommand.evaluate(observation(listing(["res://one"]), "", {
      abortSignal: cancelledController.signal,
    }));
    assert.equal(cancelled.status, "unknown");

    const deadline = await listFilesCommand.evaluate(observation(listing(["res://one"]), "", {
      deadlineMono: performance.now() - 1,
    }));
    assert.equal(deadline.status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
