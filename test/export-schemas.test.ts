import assert from "node:assert/strict";
import test from "node:test";
import {
  exportResourcesInputSchema,
  exportSemanticDataSchema,
} from "../src/schemas.js";

const inputs = [{ kind: "path", path: "D:/fixtures/pack.pck" }] as const;

const parse = (value: unknown) => exportResourcesInputSchema.safeParse(value);

test("members selection admits nonempty ordered include and optional exclude", () => {
  const parsed = parse({
    inputs,
    output: "D:/fixtures/out",
    selection: {
      kind: "members",
      include: ["res://.godot/imported/*.translation", "res://main.gdc"],
      exclude: ["res://.godot/imported/zh*"],
    },
    session: [{ kind: "multithreading", disabled: true }],
    translationHints: ["D:/fixtures/hints.csv"],
    collectResourceStrings: false,
    dumpResourceStrings: true,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed));
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.selection, {
    kind: "members",
    include: ["res://.godot/imported/*.translation", "res://main.gdc"],
    exclude: ["res://.godot/imported/zh*"],
  });
  assert.deepEqual(parsed.data.session, [{ kind: "multithreading", disabled: true }]);
  assert.deepEqual(parsed.data.translationHints, ["D:/fixtures/hints.csv"]);
  assert.equal(parsed.data.collectResourceStrings, false);
  assert.equal(parsed.data.dumpResourceStrings, true);
});

test("omitted selection is rejected instead of defaulting to all resources", () => {
  assert.equal(parse({ inputs }).success, false);
});

test("members selection rejects an empty include list", () => {
  assert.equal(parse({ inputs, selection: { kind: "members", include: [] } }).success, false);
});

test("excludes-only member selection is rejected", () => {
  assert.equal(
    parse({ inputs, selection: { kind: "members", exclude: ["res://*.gdc"] } }).success,
    false,
  );
});

test("native group selection admits scripts and translations", () => {
  for (const group of ["scripts", "translations"] as const) {
    const parsed = parse({ inputs, selection: { kind: "group", group } });
    assert.equal(parsed.success, true, JSON.stringify(parsed));
    if (!parsed.success) continue;
    assert.deepEqual(parsed.data.selection, { kind: "group", group });
  }
});

test("group selection rejects include, exclude, or an unknown group", () => {
  assert.equal(
    parse({
      inputs,
      selection: { kind: "group", group: "scripts", include: ["res://*.gd"] },
    }).success,
    false,
  );
  assert.equal(
    parse({ inputs, selection: { kind: "group", group: "all" } }).success,
    false,
  );
});

test("retired all/default selection shape is rejected", () => {
  assert.equal(parse({ inputs, selection: "all" }).success, false);
  assert.equal(parse({ inputs, selection: { kind: "all" } }).success, false);
});

test("key and checksum overrides are rejected rather than accepted and ignored", () => {
  const selection = { kind: "members", include: ["res://main.gdc"] } as const;
  assert.equal(
    parse({ inputs, selection, key: "a".repeat(64) }).success,
    false,
  );
  assert.equal(
    parse({ inputs, selection, checksum: "ignore" }).success,
    false,
  );
});

test("output and hint values must be literal paths without wildcards", () => {
  const selection = { kind: "members", include: ["res://main.gdc"] } as const;
  assert.equal(parse({ inputs, selection, output: "D:/fixtures/out*" }).success, false);
  assert.equal(
    parse({ inputs, selection, translationHints: ["D:/fixtures/*.csv"] }).success,
    false,
  );
});

test("export semantic data is a bounded summary with explicit completeness and report paths", () => {
  const parsed = exportSemanticDataSchema.safeParse({
    completeness: "partial",
    outputPath: "D:/fixtures/out",
    selection: { kind: "members", group: null },
    counts: {
      completeMembers: 6,
      selectedMembers: 3,
      nativeImports: 2,
      exportSuccess: 2,
      exportFailed: 0,
      exportUnsupported: 0,
      unverifiedSuccess: 0,
      unaccountedImports: 0,
      unmappedMembers: 1,
      missingKeys: 0,
      totalKeys: 4,
    },
    artifactRoles: {
      editableExports: 2,
      unverifiedExports: 0,
      rawOrUnmappedMembers: 1,
      accompanying: 1,
      administrative: 2,
    },
    reports: {
      native: "D:/fixtures/out/gdre_export.json",
      nativeLog: "D:/fixtures/out/gdre_export.log",
      adapter: "D:/fixtures/.gdre/operations/op/export-detail/report.json",
    },
    sideEffects: ["Selected members without an exporter entry may remain raw output."],
    diagnostics: ["Missing 2 of 4 translation keys."],
    previews: {
      editableExports: ["D:/fixtures/out/translations.csv"],
      failed: [],
      unsupported: [],
    },
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed));
  assert.equal(exportSemanticDataSchema.safeParse({ completeness: "complete" }).success, false);
});
