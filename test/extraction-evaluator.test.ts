import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactEntry, ArtifactInventory } from "../src/artifacts.js";
import { collectCompleteListingMembers, evaluateListFiles } from "../src/listing.js";
import { extractCommand } from "../src/registry.js";
import type { ProcessObservation } from "../src/types.js";

const output = "D:/GDRE Work/exports/out 空间";
const members = [
  "res://project.godot",
  "res://文本/hello 空间.txt",
  "res://data/nested.bin",
] as const;

const memberPaths = [
  `${output}/project.godot`,
  `${output}/文本/hello 空间.txt`,
  `${output}/data/nested.bin`,
];

const fileEntry = (file: string, suffix = "0"): ArtifactEntry => ({
  path: file,
  role: "extracted",
  kind: "file",
  bytes: 12,
  sha256: suffix.repeat(64).slice(0, 64),
  error: null,
});

const directoryEntry = (directory: string): ArtifactEntry => ({
  path: directory,
  role: "extracted",
  kind: "directory",
  bytes: null,
  sha256: null,
  error: null,
});

const expectedEntriesFor = (root: string): ArtifactEntry[] => [
  directoryEntry(`${root}/data`),
  directoryEntry(`${root}/文本`),
  ...memberPaths.map((file, index) => fileEntry(file.replace(output, root), String(index + 1))),
  { ...fileEntry(`${root}/gdre_export.log`, "f"), role: "administrative-log" },
];

const expectedEntries = (): ArtifactEntry[] => expectedEntriesFor(output);

const inventory = (entries: readonly ArtifactEntry[], complete = true, errors: readonly string[] = []): ArtifactInventory => ({
  entries,
  errors,
  complete,
  stopReason: null,
});

const successStdout = [
  `Input files: ["D:/fixtures/pack.pck"]`,
  "GDRE Tools v2.8.0-beta.2",
  "Windows 10.0.26100, headless",
  "Opening file: D:/fixtures/pack.pck",
  "Successfully loaded PCK!",
  "Version: 4.4.0",
  "Verified 3 files, no errors detected!",
  "Extracted 3 files, no errors detected!",
  "Extraction operation complete in 00m00s",
  "Log file written to: D:/GDRE Work/exports/out 空间/gdre_export.log",
  "",
].join("\n");

const observation = (overrides: Partial<ProcessObservation> = {}): ProcessObservation => ({
  exitCode: 0,
  signal: null,
  stdout: successStdout,
  stderr: "",
  stdoutTruncated: false,
  expectedMembers: members,
  effectiveOutput: output,
  expectedLoads: [{ path: "D:/fixtures/pack.pck", kind: "file" }],
  artifacts: inventory(expectedEntries()),
  ...overrides,
});

test("extraction evaluator accepts exact members, hashes, and default checksum evidence", async () => {
  const evaluation = await extractCommand.evaluate(observation());
  assert.equal(evaluation.status, "succeeded");
  assert.equal(evaluation.rule, "gdre-extract-v1");
  assert.deepEqual(evaluation.data, {
    totalFiles: 3,
    selectedFiles: 3,
    extractedFiles: 3,
    outputPath: output,
    checksum: "default",
    checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 },
  });
  assert.ok(evaluation.evidence.some((line) => line.includes("Verified 3 files")));
  assert.ok(evaluation.evidence.some((line) => line.includes("Extracted 3 files")));
  assert.ok(evaluation.evidence.some((line) => line.includes("SHA-256")));
});

const selectedEntriesFor = (root: string, names: readonly string[]): ArtifactEntry[] => {
  const directories = new Set<string>();
  const files: ArtifactEntry[] = [];
  for (const [index, name] of names.entries()) {
    const relative = name.replace(/^res:\/\//u, "");
    const parts = relative.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(`${root}/${parts.slice(0, depth).join("/")}`);
    }
    files.push(fileEntry(`${root}/${relative}`, String(index + 1)));
  }
  return [
    ...[...directories].map((directory) => directoryEntry(directory)),
    ...files,
    { ...fileEntry(`${root}/gdre_export.log`, "f"), role: "administrative-log" },
  ];
};

test("extraction evaluator separates selected output from full-set checksum coverage", async () => {
  const selected = [members[0]];
  const stdout = successStdout
    .replace("Verified 3 files, no errors detected!", "Verified 3 files, no errors detected!")
    .replace("Extracted 3 files", "Extracted 1 files");
  const evaluation = await extractCommand.evaluate(observation({
    stdout,
    expectedSelectedMembers: selected,
    artifacts: inventory(selectedEntriesFor(output, selected)),
  }));
  assert.equal(evaluation.status, "succeeded", JSON.stringify(evaluation));
  assert.deepEqual(evaluation.data, {
    totalFiles: 3,
    selectedFiles: 1,
    extractedFiles: 1,
    outputPath: output,
    checksum: "default",
    checksumCoverage: { scope: "all-members", verifiedFiles: 3, skippedFiles: 0 },
  });
});

test("extraction evaluator requires checksum coverage over the full preflight set", async () => {
  const selected = [members[0]];
  const stdout = successStdout.replace("Extracted 3 files", "Extracted 1 files").replace(
    "Verified 3 files, no errors detected!",
    "Verified 1 files, no errors detected!",
  );
  const evaluation = await extractCommand.evaluate(observation({
    stdout,
    expectedSelectedMembers: selected,
    artifacts: inventory(selectedEntriesFor(output, selected)),
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /Checksum verification coverage/u);
});

test("extraction evaluator rejects extracted files outside the selected set", async () => {
  const selected = [members[0]];
  const stdout = successStdout.replace("Extracted 3 files", "Extracted 3 files");
  const evaluation = await extractCommand.evaluate(observation({
    stdout,
    expectedSelectedMembers: selected,
    artifacts: inventory(expectedEntries()),
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /does not match the selected member set|unexpected regular file/u);
});

test("extraction evaluator rejects a selected set that is not a subset of the full set", async () => {
  const evaluation = await extractCommand.evaluate(observation({
    expectedSelectedMembers: ["res://not-in-package.gd"],
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /not a subset/u);
});

test("extraction evaluator detects the empty-selection all-members fallback", async () => {
  const evaluation = await extractCommand.evaluate(observation({
    expectedSelectedMembers: [],
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /does not match the selected member set|empty/u);
});

test("extraction evaluator refuses an invented empty success for an empty selected set", async () => {
  const stdout = successStdout.replace("Extracted 3 files", "Extracted 0 files");
  const evaluation = await extractCommand.evaluate(observation({
    stdout,
    expectedSelectedMembers: [],
    artifacts: inventory([{ ...fileEntry(`${output}/gdre_export.log`, "f"), role: "administrative-log" }]),
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /empty/u);
});

test("extraction evaluator reports source-backed not-applicable checksum coverage for a selected subset", async () => {
  const selected = [members[0]];
  const stdout = openingFor("D:/fixtures/pack.zip", "file")
    .split("\n")
    .filter((line) => !line.startsWith("Verified "))
    .join("\n")
    .replace("Extracted 3 files", "Extracted 1 files");
  const evaluation = await extractCommand.evaluate(observation({
    stdout,
    expectedLoads: [{ path: "D:/fixtures/pack.zip", kind: "file" }],
    expectedSelectedMembers: selected,
    artifacts: inventory(selectedEntriesFor(output, selected)),
  }));
  assert.equal(evaluation.status, "succeeded", JSON.stringify(evaluation));
  assert.deepEqual(evaluation.data?.checksumCoverage, {
    scope: "not-applicable",
    verifiedFiles: null,
    skippedFiles: null,
  });
  assert.equal(evaluation.data?.totalFiles, 3);
  assert.equal(evaluation.data?.selectedFiles, 1);
});

test("extraction evaluator preserves actual MD5 skip evidence without claiming universal coverage", async () => {
  const stdout = successStdout
    .replace("Verified 3 files, no errors detected!", "Verified 2 files, 1 files skipped (MD5 hash entry was empty)")
    .replace("Extracted 3 files", "Extracted 3 files");
  const evaluation = await extractCommand.evaluate(observation({ stdout }));
  assert.equal(evaluation.status, "succeeded");
  assert.ok(evaluation.evidence.some((line) => line.includes("skipped 1 file")));
  assert.ok(evaluation.evidence.some((line) => line.includes("no universal PCK MD5 coverage")));
});

test("extraction evaluator fails on an unexpected regular file even with exit zero", async () => {
  const evaluation = await extractCommand.evaluate(observation({
    artifacts: inventory([...expectedEntries(), fileEntry(`${output}/unexpected.txt`)]),
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /unexpected regular file/u);
});

test("extraction evaluator fails on a missing expected member", async () => {
  const entries = expectedEntries().filter((entry) => entry.path !== memberPaths[1]);
  const evaluation = await extractCommand.evaluate(observation({ artifacts: inventory(entries) }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /missing from the inventory/u);
});

test("extraction evaluator fails when a member lacks bytes or SHA-256 evidence", async () => {
  const entries = expectedEntries().map((entry) =>
    entry.path === memberPaths[0] ? { ...entry, sha256: null } : entry,
  );
  const evaluation = await extractCommand.evaluate(observation({ artifacts: inventory(entries) }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /lacks complete bytes\/SHA-256/u);
});

test("extraction evaluator fails on links and unexpected directories", async () => {
  const link = await extractCommand.evaluate(observation({
    artifacts: inventory([
      ...expectedEntries().filter((entry) => entry.path !== memberPaths[0]!),
      { ...fileEntry(memberPaths[0]!), kind: "link", sha256: null, bytes: null, error: "link recorded without traversal" },
    ]),
  }));
  assert.equal(link.status, "failed");
  assert.match(link.summary, /unsupported artifact kind/u);

  const directory = await extractCommand.evaluate(observation({
    artifacts: inventory([...expectedEntries(), directoryEntry(`${output}/unexpected-dir`)]),
  }));
  assert.equal(directory.status, "failed");
  assert.match(directory.summary, /unexpected directory/u);
});

test("extraction evaluator fails on checksum, load, or write errors despite exit zero", async () => {
  for (const errorLine of [
    "ERROR: Checksum failed for res://data/nested.bin",
    "Error: failed to open pack",
    "Extracting files... [ 0% ] Error: File write error",
  ]) {
    const evaluation = await extractCommand.evaluate(observation({ stdout: `${successStdout}\n${errorLine}\n` }));
    assert.equal(evaluation.status, "failed", String(errorLine));
  }
});

test("extraction evaluator treats unclassified or incomplete evidence as unknown", async () => {
  const unknownStderr = await extractCommand.evaluate(observation({ stderr: "an unrecognized runtime diagnostic\n" }));
  assert.equal(unknownStderr.status, "unknown");

  const incompleteInventory = await extractCommand.evaluate(observation({
    artifacts: inventory(expectedEntries(), false, ["D:/dest: inventory stopped"]),
  }));
  assert.equal(incompleteInventory.status, "unknown");

  const missingArtifacts = await extractCommand.evaluate(observation({ artifacts: undefined }));
  assert.equal(missingArtifacts.status, "unknown");

  const missingMembers = await extractCommand.evaluate(observation({ expectedMembers: undefined }));
  assert.equal(missingMembers.status, "unknown");

  const missingCompletion = await extractCommand.evaluate(observation({
    stdout: successStdout.replace("Extraction operation complete in 00m00s", ""),
  }));
  assert.equal(missingCompletion.status, "unknown");
});

test("extraction evaluator refuses non-natural exits and count mismatches", async () => {
  const nonzero = await extractCommand.evaluate(observation({ exitCode: 1 }));
  assert.equal(nonzero.status, "failed");
  assert.match(nonzero.summary, /natural exit code 0/u);

  const signalled = await extractCommand.evaluate(observation({ signal: "SIGKILL" }));
  assert.equal(signalled.status, "failed");

  const mismatch = await extractCommand.evaluate(observation({
    stdout: successStdout.replace("Extracted 3 files", "Extracted 2 files"),
  }));
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.summary, /does not match/u);
});

test("extraction evaluator rejects the runtime log as an extracted member", async () => {
  const evaluation = await extractCommand.evaluate(observation({
    expectedMembers: [...members, "res://GDRE_EXPORT.LOG"],
    stdout: successStdout
      .replace("Extracted 3 files", "Extracted 4 files")
      .replace("Verified 3 files", "Verified 4 files"),
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /gdre_export\.log/u);
});

test("extraction evaluator corroborates the actual opened input and directory/dependency forms", async () => {
  const wrongInput = await extractCommand.evaluate(observation({
    expectedLoads: [{ path: "D:/fixtures/expected.pck", kind: "file" }],
  }));
  assert.equal(wrongInput.status, "unknown");
  assert.match(wrongInput.summary, /different set of input or dependency paths/u);

  const directory = await extractCommand.evaluate(observation({
    stdout: successStdout.replace(
      "Opening file: D:/fixtures/pack.pck",
      "Opening directory: D:/fixtures/project 空间",
    ),
    expectedLoads: [{ path: "D:/fixtures/project 空间", kind: "directory" }],
  }));
  assert.equal(directory.status, "succeeded");

  const dependency = await extractCommand.evaluate(observation({
    stdout: successStdout.replace(
      "Opening file: D:/fixtures/pack.pck",
      "Opening file: D:/fixtures/sidecar 空间.pck",
    ),
    expectedLoads: [{ path: "D:/fixtures/sidecar 空间.pck", kind: "file" }],
  }));
  assert.equal(dependency.status, "succeeded");

  const missingGraph = await extractCommand.evaluate(observation({ expectedLoads: undefined }));
  assert.equal(missingGraph.status, "unknown");
  assert.match(missingGraph.summary, /loader graph/u);
});

test("extraction evaluator anchors markers so path text cannot satisfy them", async () => {
  const embeddedPath = "D:/fixtures/Successfully loaded PCK! Extracted 3 files, no errors detected! Verified 3 files, no errors detected!.pck";
  const embeddedOnly = [
    `Input files: ["${embeddedPath}"]`,
    "GDRE Tools v2.8.0-beta.2",
    "Windows 10.0.26100, headless",
    `Opening file: ${embeddedPath}`,
    "",
  ].join("\n");
  const notLoaded = await extractCommand.evaluate(observation({
    stdout: embeddedOnly,
    expectedLoads: [{ path: embeddedPath, kind: "file" }],
  }));
  assert.equal(notLoaded.status, "failed");
  assert.match(notLoaded.summary, /did not confirm/u);

  const withRealMarkers = await extractCommand.evaluate(observation({
    stdout: successStdout.replace("Opening file: D:/fixtures/pack.pck", `Opening file: ${embeddedPath}`),
    expectedLoads: [{ path: embeddedPath, kind: "file" }],
  }));
  assert.equal(withRealMarkers.status, "succeeded");
});

test("extraction evaluator does not take the last of duplicate or contradictory summaries", async () => {
  const duplicateExtracted = await extractCommand.evaluate(observation({
    stdout: `${successStdout}\nExtracted 3 files, no errors detected!\n`,
  }));
  assert.equal(duplicateExtracted.status, "unknown");
  assert.match(duplicateExtracted.summary, /multiple extracted-file summaries/u);

  const contradictoryExtracted = await extractCommand.evaluate(observation({
    stdout: `${successStdout}\nExtracted 1 files, no errors detected!\n`,
  }));
  assert.equal(contradictoryExtracted.status, "unknown");
  assert.match(contradictoryExtracted.summary, /ambiguous/u);

  const duplicateVerified = await extractCommand.evaluate(observation({
    stdout: `${successStdout}\nVerified 3 files, no errors detected!\n`,
  }));
  assert.equal(duplicateVerified.status, "unknown");
  assert.match(duplicateVerified.summary, /multiple checksum summaries/u);

  const duplicateLoad = await extractCommand.evaluate(observation({
    stdout: `${successStdout}\nSuccessfully loaded PCK!\n`,
  }));
  assert.equal(duplicateLoad.status, "unknown");
  assert.match(duplicateLoad.summary, /multiple load markers/u);

  const duplicateCompletion = await extractCommand.evaluate(observation({
    stdout: `${successStdout}\nExtraction operation complete in 00m00s\n`,
  }));
  assert.equal(duplicateCompletion.status, "unknown");
  assert.match(duplicateCompletion.summary, /multiple completion markers/u);
});

const listingEvidence = (names: readonly string[]): string => [
  `Input files: ["D:/fixtures/pack.pck"]`,
  "GDRE Tools v2.8.0-beta.2",
  "Windows 10.0.26100, headless",
  "Opening file: D:/fixtures/pack.pck",
  "",
  "Contents:",
  ...names,
  "",
  `Total files: ${String(names.length)}`,
  "",
].join("\n");

test("complete preflight retention keeps more than 32 members and long names the public sample omits", async () => {
  const shortNames = Array.from(
    { length: 40 },
    (_, index) => `res://member-${String(index).padStart(2, "0")}.txt`,
  );
  const longName = `res://nested/${"a".repeat(2_100)}.bin`;
  const names = [...shortNames, longName];
  const stdout = listingEvidence(names);
  const listed: ProcessObservation = {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
  };

  const complete = await collectCompleteListingMembers(listed);
  assert.equal(complete.status, "succeeded");
  assert.equal(complete.totalFiles, names.length);
  assert.deepEqual(complete.members, names, "complete retention includes every parser-valid member name");

  const publicEvaluation = await evaluateListFiles(listed);
  assert.equal(publicEvaluation.status, "succeeded");
  assert.equal(publicEvaluation.data?.totalFiles, names.length);
  assert.equal(publicEvaluation.data?.files.length, 32);
  assert.equal(publicEvaluation.data?.truncated, true);
  assert.equal(publicEvaluation.data?.files.includes(longName), false, "public sample still omits names over 2048 bytes");
});

const stdoutWithoutVerification = successStdout
  .split("\n")
  .filter((line) => !line.startsWith("Verified "))
  .join("\n");

const openingFor = (file: string, kind: "file" | "directory"): string =>
  successStdout.replace(
    "Opening file: D:/fixtures/pack.pck",
    `${kind === "directory" ? "Opening directory" : "Opening file"}: ${file}`,
  );

test("checksum-summary absence is accepted only for source-backed non-PCK graphs", async () => {
  for (const [file, kind] of [
    ["D:/fixtures/pack.zip", "file"],
    ["D:/fixtures/pack.APK", "file"],
    ["D:/fixtures/pack.xapk", "file"],
    ["D:/fixtures/project 空间", "directory"],
  ] as const) {
    const stdout = openingFor(file, kind).split("\n").filter((line) => !line.startsWith("Verified ")).join("\n");
    const evaluation = await extractCommand.evaluate(observation({
      stdout,
      expectedLoads: [{ path: file, kind }],
    }));
    assert.equal(evaluation.status, "succeeded", file);
    assert.ok(evaluation.evidence.some((line) => /non-PCK|no MD5 verification summary/iu.test(line)), file);
    assert.equal(evaluation.data?.checksum, "default");
    assert.equal(evaluation.evidence.some((line) => /no checksum errors/u.test(line)), false, "no universal verification claim");
  }

  for (const [file, kind] of [
    ["D:/fixtures/pack.pck", "file"],
    ["D:/fixtures/game.exe", "file"],
    ["D:/fixtures/bundle.app", "file"],
    ["D:/fixtures/bundle.app", "directory"],
    ["D:/fixtures/data.bin", "file"],
  ] as const) {
    const stdout = openingFor(file, kind).split("\n").filter((line) => !line.startsWith("Verified ")).join("\n");
    const evaluation = await extractCommand.evaluate(observation({
      stdout,
      expectedLoads: [{ path: file, kind }],
    }));
    assert.equal(evaluation.status, "unknown", file);
    assert.match(evaluation.summary, /checksum verification evidence/u);
  }

  const mixedStdout = stdoutWithoutVerification.replace(
    "Opening file: D:/fixtures/pack.pck",
    "Opening file: D:/fixtures/pack.pck\nOpening file: D:/fixtures/overlay.zip",
  );
  const mixed = await extractCommand.evaluate(observation({
    stdout: mixedStdout,
    expectedLoads: [
      { path: "D:/fixtures/pack.pck", kind: "file" },
      { path: "D:/fixtures/overlay.zip", kind: "file" },
    ],
  }));
  assert.equal(mixed.status, "unknown", "a PCK in the graph still requires verification");
});

test("an observed checksum summary keeps exact count checks for non-PCK graphs", async () => {
  const zipStdout = openingFor("D:/fixtures/pack.zip", "file")
    .replace("Verified 3 files, no errors detected!", "Verified 2 files, no errors detected!");
  const evaluation = await extractCommand.evaluate(observation({
    stdout: zipStdout,
    expectedLoads: [{ path: "D:/fixtures/pack.zip", kind: "file" }],
  }));
  assert.equal(evaluation.status, "failed");
  assert.match(evaluation.summary, /Checksum verification coverage/u);
});

test("artifact verification observes cancellation during inventory traversal", async () => {
  const controller = new AbortController();
  const base = expectedEntries();
  const entries = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^[0-9]+$/u.test(property)) {
        const index = Number(property);
        if (index >= 3) {
          if (controller.signal.aborted) throw new Error("artifact verification read past cancellation");
          controller.abort();
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const evaluation = await extractCommand.evaluate(observation({
    artifacts: { entries, errors: [], complete: true, stopReason: null },
    abortSignal: controller.signal,
  }));
  assert.equal(evaluation.status, "unknown");
  assert.match(evaluation.summary, /cancelled|deadline/u);
});

test("a validated junction destination inventories its canonical root but reports the display path", async () => {
  const display = "D:/alias output/junction root";
  const real = "D:/physical output/real root";
  const evaluation = await extractCommand.evaluate(observation({
    effectiveOutput: display,
    effectiveOutputRealPath: real,
    artifacts: inventory(expectedEntriesFor(real)),
  }));
  assert.equal(evaluation.status, "succeeded");
  assert.equal(evaluation.data?.outputPath, display, "semantic outputPath keeps the caller-accepted display destination");
  assert.ok(evaluation.evidence.some((line) => line.includes("SHA-256")));
});
