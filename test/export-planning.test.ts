import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExportExpectations,
  buildExportPreflightPlan,
  buildExportRecoveryPlan,
  combineInputFingerprints,
  EXPORT_ARGV_PREFIX,
  exportAdministrativePaths,
  exportPreflightEvidencePath,
  prepareExportHints,
  revalidateExportHints,
  selectExportMembers,
  sourceKindFromPreparation,
  normalizeExportOutputPath,
  ExportPathError,
} from "../src/export-planning.js";
import type { ListingDirectoryInspector, ListingPreparation } from "../src/listing-paths.js";
import { prepareListingInputs } from "../src/listing-paths.js";
import { joinPath, pathIdentity } from "../src/paths.js";
import type { ExportImportMetadata, ExportResourcesInput } from "../src/types.js";

const output = "D:/fixtures/out";
const operation = "D:/fixtures/.gdre/operations/op";

const completeMembers = [
  "res://project.godot",
  "res://translations.csv",
  "res://translations.csv.import",
  "res://.godot/imported/translations.en.translation",
  "res://.godot/imported/translations.zh.translation",
  "res://main.gdc",
  "res://main.gd.remap",
] as const;

const translationImport: ExportImportMetadata = {
  path: "res://.godot/imported/translations.en.translation",
  importMdPath: "res://translations.csv.import",
  sourceFile: "res://translations.csv",
  importer: "csv_translation",
  type: "Translation",
  destFiles: [
    "res://.godot/imported/translations.en.translation",
    "res://.godot/imported/translations.zh.translation",
  ],
};

const scriptImport: ExportImportMetadata = {
  path: "res://main.gdc",
  importMdPath: "res://main.gd.remap",
  sourceFile: "res://main.gd",
  importer: "script_bytecode",
  type: "GDScript",
  destFiles: ["res://main.gdc"],
};

const benignInspector: ListingDirectoryInspector = {
  async inspect(directories) {
    return new Map(
      directories.map((directory) => [
        directory,
        { caseSensitive: false, reparsePoint: false },
      ]),
    );
  },
};

const selection = (value: ExportResourcesInput["selection"]) =>
  value;

const recoveryInput = (value: Partial<ExportResourcesInput> = {}): ExportResourcesInput => ({
  inputs: [{ kind: "path", path: "D:/fixtures/pack.pck" }],
  output,
  selection: selection({ kind: "members", include: ["res://main.gdc"] }),
  ...value,
});

const tempFixture = async (): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly input: string;
  readonly hint: string;
  readonly preparation: ListingPreparation;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-export-planning-"));
  const workspace = path.join(root, "workspace");
  const input = path.join(root, "fixtures", "pack.pck");
  const hint = path.join(root, "fixtures", "hints.csv");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(input), { recursive: true });
  await writeFile(input, "pack", "utf8");
  await writeFile(hint, "key,en\nHELLO,Hello\n", "utf8");
  const preparation = await prepareListingInputs(
    workspace,
    { inputs: [{ kind: "path", path: input }] },
    undefined,
    undefined,
    { directoryInspector: benignInspector },
  );
  return { root, workspace, input, hint, preparation };
};

test("member selection uses native include/exclude semantics in caller order", () => {
  const outcome = selectExportMembers(
    { kind: "members", include: ["res://.godot/imported/*.translation"], exclude: ["res://.godot/imported/*zh*"] },
    completeMembers,
    "package",
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.classification, "selected");
  assert.deepEqual(outcome.members, ["res://.godot/imported/translations.en.translation"]);
  assert.deepEqual(outcome.provenance, {
    kind: "members",
    include: ["res://.godot/imported/*.translation"],
    exclude: ["res://.godot/imported/*zh*"],
    group: null,
  });
});

test("native groups select only their class and an empty group is an explicit no-match", () => {
  const scripts = selectExportMembers({ kind: "group", group: "scripts" }, completeMembers, "package");
  assert.equal(scripts.ok, true, JSON.stringify(scripts));
  if (!scripts.ok) return;
  assert.deepEqual(scripts.members, ["res://main.gdc"]);
  assert.equal(scripts.provenance.group, "scripts");

  const empty = selectExportMembers(
    { kind: "group", group: "translations" },
    ["res://project.godot", "res://main.gdc"],
    "package",
  );
  assert.equal(empty.ok, true, JSON.stringify(empty));
  if (!empty.ok) return;
  assert.deepEqual(empty.members, []);
  assert.equal(empty.classification, "no_match");
});

test("directory sources admit only verified bare-star filters", () => {
  const bare = selectExportMembers(
    { kind: "members", include: ["*.translation"] },
    completeMembers,
    "directory",
  );
  assert.equal(bare.ok, true, JSON.stringify(bare));
  if (!bare.ok) return;
  assert.deepEqual(bare.members, [
    "res://.godot/imported/translations.en.translation",
    "res://.godot/imported/translations.zh.translation",
  ]);

  const rejected = selectExportMembers(
    { kind: "members", include: ["res://.godot/imported/*.translation"] },
    completeMembers,
    "directory",
  );
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  if (rejected.ok) return;
  assert.equal(rejected.reason, "directory_filter_unsupported");
  assert.deepEqual(rejected.patterns, ["res://.godot/imported/*.translation"]);
});

test("source kind follows the prepared primary input", async () => {
  const fixture = await tempFixture();
  try {
    assert.equal(sourceKindFromPreparation(fixture.preparation), "package");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovery plan supplies explicit output, native selection, hints, string controls, and report setting", () => {
  const input = recoveryInput({
    selection: {
      kind: "members",
      include: ["res://.godot/imported/*.translation", "res://main.gdc"],
      exclude: ["res://.godot/imported/zh*"],
    },
    session: [{ kind: "multithreading", disabled: false }],
    translationHints: ["D:/fixtures/hints.csv"],
    collectResourceStrings: false,
    dumpResourceStrings: true,
  });
  const plan = buildExportRecoveryPlan({
    input,
    resolvedInputs: ["D:/fixtures/pack.pck"],
    hintPaths: ["D:/fixtures/hints.csv"],
    effectiveOutput: output,
    session: input.session ?? [],
    operationDirectory: operation,
  });
  assert.deepEqual(plan.argv, [
    ...EXPORT_ARGV_PREFIX,
    "--disable-multithreading=false",
    "--recover=D:/fixtures/pack.pck",
    "--output=D:/fixtures/out",
    "--include=res://.godot/imported/*.translation",
    "--include=res://main.gdc",
    "--exclude=res://.godot/imported/zh*",
    "--translation-hint=D:/fixtures/hints.csv",
    "--skip-loading-resource-strings",
    "--dump-resource-strings",
    "--setting=write_json_report=true",
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, undefined);
  assert.equal(
    plan.argv.some((token) => token.startsWith("--key") || token.includes("checksum")),
    false,
  );
});

test("recovery plan uses the native group flag without include/exclude", () => {
  const input = recoveryInput({ selection: { kind: "group", group: "translations" } });
  const plan = buildExportRecoveryPlan({
    input,
    resolvedInputs: ["D:/fixtures/pack.pck"],
    hintPaths: [],
    effectiveOutput: output,
    session: [],
    operationDirectory: operation,
  });
  assert.ok(plan.argv.includes("--translation-only"));
  assert.equal(plan.argv.some((token) => token.startsWith("--include=") || token.startsWith("--exclude=")), false);
  assert.equal(plan.argv.some((token) => token.startsWith("--skip-loading-resource-strings")), false);
  assert.equal(plan.argv.some((token) => token.startsWith("--dump-resource-strings")), false);
});

test("preflight plan launches only the fixed inspector with adapter-owned inputs and evidence path", () => {
  const plan = buildExportPreflightPlan({
    preflightScriptPath: "D:/fixtures/native/gdre-export-preflight.gd",
    operationDirectory: operation,
    resolvedInputs: ["D:/fixtures/pack.pck", "D:/fixtures/extra.pck"],
    timeoutMs: 1_234,
  });
  const evidencePath = exportPreflightEvidencePath(operation);
  assert.deepEqual(plan.argv, [
    "--headless",
    "--script",
    "D:/fixtures/native/gdre-export-preflight.gd",
    "--",
    evidencePath,
    "D:/fixtures/pack.pck",
    "D:/fixtures/extra.pck",
  ]);
  assert.equal(plan.cwd, operation);
  assert.equal(plan.timeoutMs, 1_234);
  assert.deepEqual(plan.effects.writes, [evidencePath]);
});

test("hint preparation fingerprints regular files and revalidation detects changes", async () => {
  const fixture = await tempFixture();
  try {
    assert.equal(await prepareExportHints(fixture.workspace, undefined, undefined, undefined, {
      directoryInspector: benignInspector,
    }), undefined);

    const hints = await prepareExportHints(
      fixture.workspace,
      [fixture.hint],
      undefined,
      undefined,
      { directoryInspector: benignInspector },
    );
    assert.ok(hints !== undefined);
    assert.equal(hints!.resolvedInputs.length, 1);
    assert.equal(pathIdentity(hints!.resolvedInputs[0]!), pathIdentity(fixture.hint));
    assert.equal(hints!.fingerprints.every((entry) => entry.kind === "file"), true);

    const combined = combineInputFingerprints(fixture.preparation, hints);
    assert.equal(combined.fingerprints.length, hints!.fingerprints.length + fixture.preparation.fingerprints.length);
    assert.deepEqual(combined.expectedLoads, fixture.preparation.expectedLoads);

    await assert.rejects(
      prepareExportHints(fixture.workspace, [fixture.workspace], undefined, undefined, {
        directoryInspector: benignInspector,
      }),
      ExportPathError,
    );

    await writeFile(fixture.hint, "key,en\nCHANGED,Changed\n", "utf8");
    await assert.rejects(
      revalidateExportHints(hints!, undefined, undefined, { directoryInspector: benignInspector }),
      /changed before launch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("expectations map selected members to reportable imports and explicit unmapped members", () => {
  const expectations = buildExportExpectations({
    effectiveOutput: output,
    completeMembers,
    selectedMembers: [
      "res://.godot/imported/translations.en.translation",
      "res://.godot/imported/translations.zh.translation",
      "res://main.gdc",
      "res://translations.csv.import",
    ],
    imports: [translationImport, scriptImport],
    dumpResourceStrings: false,
  });
  assert.equal(expectations.reportableImports.length, 2);
  assert.equal(expectations.selectedReportableImports.length, 2);
  assert.deepEqual(expectations.selectedReportableImports[0]!.selectedMembers, [
    "res://.godot/imported/translations.en.translation",
    "res://.godot/imported/translations.zh.translation",
  ]);
  assert.deepEqual(expectations.unmappedMembers, ["res://translations.csv.import"]);
  assert.equal(expectations.memberPaths.get("res://main.gdc"), joinPath(output, "main.gdc"));
  assert.deepEqual(exportAdministrativePaths(output, false), {
    log: joinPath(output, "gdre_export.log"),
    report: joinPath(output, "gdre_export.json"),
    resourceStrings: null,
  });
});

test("NO_IMPORTER destinations are unmapped rather than invented exporter failures", () => {
  const noImporter: ExportImportMetadata = {
    path: "res://.godot/imported/raw.bin",
    importMdPath: "res://raw.bin.import",
    sourceFile: "res://raw.bin",
    importer: "<NONE>",
    type: "",
    destFiles: ["res://.godot/imported/raw.bin"],
  };
  const expectations = buildExportExpectations({
    effectiveOutput: output,
    completeMembers: ["res://.godot/imported/raw.bin", "res://main.gdc"],
    selectedMembers: ["res://.godot/imported/raw.bin", "res://main.gdc"],
    imports: [noImporter, scriptImport],
    dumpResourceStrings: false,
  });
  assert.equal(expectations.reportableImports.length, 1);
  assert.deepEqual(expectations.selectedReportableImports[0]!.selectedMembers, ["res://main.gdc"]);
  assert.deepEqual(expectations.unmappedMembers, ["res://.godot/imported/raw.bin"]);
});

test("expectations reject traversal, non-logical destinations, and administrative collisions", () => {
  const unsafe: ExportImportMetadata = {
    ...scriptImport,
    destFiles: ["res://../escape.gdc"],
  };
  assert.throws(
    () => buildExportExpectations({
      effectiveOutput: output,
      completeMembers,
      selectedMembers: ["res://main.gdc"],
      imports: [unsafe],
      dumpResourceStrings: false,
    }),
    ExportPathError,
  );
  assert.throws(
    () => buildExportExpectations({
      effectiveOutput: output,
      completeMembers,
      selectedMembers: ["res://main.gdc"],
      imports: [{ ...scriptImport, destFiles: ["user://main.gdc"] }],
      dumpResourceStrings: false,
    }),
    ExportPathError,
  );
  for (const member of [
    "res://gdre_export.json",
    "res://gdre_export.log",
    "res://.assets/resource_strings.stringdump",
  ]) {
    assert.throws(
      () => buildExportExpectations({
        effectiveOutput: output,
        completeMembers: [...completeMembers, member],
        selectedMembers: [member],
        imports: [scriptImport],
        dumpResourceStrings: member.includes("resource_strings"),
      }),
      ExportPathError,
      member,
    );
  }
});

test("selected import generated targets cannot collide with administrative output", () => {
  assert.throws(
    () => buildExportExpectations({
      effectiveOutput: output,
      completeMembers,
      selectedMembers: [...translationImport.destFiles],
      imports: [{ ...translationImport, sourceFile: "res://gdre_export.json" }],
      dumpResourceStrings: false,
    }),
    ExportPathError,
  );
  assert.throws(
    () => buildExportExpectations({
      effectiveOutput: output,
      completeMembers,
      selectedMembers: ["res://main.gdc"],
      imports: [{ ...scriptImport, importMdPath: "res://gdre_export.log" }],
      dumpResourceStrings: false,
    }),
    ExportPathError,
  );
  assert.throws(
    () => buildExportExpectations({
      effectiveOutput: output,
      completeMembers,
      selectedMembers: [...translationImport.destFiles],
      imports: [{ ...translationImport, sourceFile: "res://.assets" }],
      dumpResourceStrings: true,
    }),
    ExportPathError,
  );
});

test("export path normalization maps display paths onto the validated real root only", () => {
  const display = "D:/fixtures/alias-out";
  const realPath = "D:/fixtures/real-out";
  assert.equal(
    normalizeExportOutputPath(joinPath(display, "nested", "a.csv"), { display, realPath }),
    joinPath(realPath, "nested", "a.csv"),
  );
  assert.equal(
    normalizeExportOutputPath(joinPath(realPath, "nested", "a.csv"), { display, realPath }),
    joinPath(realPath, "nested", "a.csv"),
  );
  assert.equal(
    normalizeExportOutputPath("D:/fixtures/other-out/a.csv", { display, realPath }),
    null,
  );
  assert.equal(
    normalizeExportOutputPath(joinPath(display, "..", "escape.csv"), { display, realPath }),
    null,
  );
});
