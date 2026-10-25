import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSelectedMembers,
  type ExtractionSelectionRequest,
  type ExtractionSourceKind,
} from "../src/extraction-selection.js";

// Independently authored complete member list (res:// logical names). Expected
// selected sets below are written as explicit literals, never derived from the
// implementation or from any runtime output.
const members = [
  "res://project.godot",
  "res://main.gd",
  "res://scripts/player.gdc",
  "res://scripts/enemy.gde",
  "res://scripts/nested/deep.gd",
  "res://addons/plugin/plugin.gd",
  "res://data/nested.bin",
  "res://data/deep/thing.txt",
  "res://textures/icon.png",
  "res://locales/en.translation",
  "res://locales/zh_CN.xl",
  "res://.hidden/secret.gd",
  "res://.dotfile.gd",
  "res://case/Case.GDC",
  "res://case/Case.XL",
] as const;

const request = (
  mode: ExtractionSelectionRequest["mode"],
  include: readonly string[] = [],
  exclude: readonly string[] = [],
): ExtractionSelectionRequest => ({ mode, include, exclude });

const selected = (
  mode: ExtractionSelectionRequest["mode"],
  include: readonly string[] = [],
  exclude: readonly string[] = [],
  sourceKind: ExtractionSourceKind = "package",
) => {
  const outcome = deriveSelectedMembers(request(mode, include, exclude), members, sourceKind);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) throw new Error("unreachable");
  return outcome;
};

test("mode all without filters selects every member in order", () => {
  const outcome = selected("all");
  assert.equal(outcome.classification, "selected");
  assert.deepEqual(outcome.expectedMembers, [...members]);
});

test("mode scripts selects gd/gdc/gde case-insensitively", () => {
  assert.deepEqual(selected("scripts").expectedMembers, [
    "res://main.gd",
    "res://scripts/player.gdc",
    "res://scripts/enemy.gde",
    "res://scripts/nested/deep.gd",
    "res://addons/plugin/plugin.gd",
    "res://.hidden/secret.gd",
    "res://.dotfile.gd",
    "res://case/Case.GDC",
  ]);
});

test("mode translations selects translation/xl case-insensitively", () => {
  assert.deepEqual(selected("translations").expectedMembers, [
    "res://locales/en.translation",
    "res://locales/zh_CN.xl",
    "res://case/Case.XL",
  ]);
});

test("a mode that matches no member yields an explicit empty no-match set", () => {
  const outcome = deriveSelectedMembers(request("scripts"), ["res://only.txt"], "package");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.expectedMembers, []);
  assert.equal(outcome.classification, "no_match");
});

test("include exact rooted path selects one member", () => {
  assert.deepEqual(selected("all", ["res://scripts/player.gdc"]).expectedMembers, [
    "res://scripts/player.gdc",
  ]);
});

test("bare *.ext include matches root and nested members (filesystem **/ zero dirs)", () => {
  assert.deepEqual(selected("all", ["*.gd"]).expectedMembers, [
    "res://main.gd",
    "res://scripts/nested/deep.gd",
    "res://addons/plugin/plugin.gd",
    "res://.hidden/secret.gd",
    "res://.dotfile.gd",
  ]);
});

test("rooted res://*.gd include matches only root members", () => {
  assert.deepEqual(selected("all", ["res://*.gd"]).expectedMembers, [
    "res://main.gd",
    "res://.dotfile.gd",
  ]);
});

test("res://**/*.gd include matches root and nested members", () => {
  assert.deepEqual(selected("all", ["res://**/*.gd"]).expectedMembers, [
    "res://main.gd",
    "res://scripts/nested/deep.gd",
    "res://addons/plugin/plugin.gd",
    "res://.hidden/secret.gd",
    "res://.dotfile.gd",
  ]);
});

test("include ? matches exactly one character within a segment", () => {
  assert.deepEqual(selected("all", ["res://scripts/?layer.gdc"]).expectedMembers, [
    "res://scripts/player.gdc",
  ]);
});

test("relative, backslash, and leading-slash includes normalize to res://", () => {
  for (const pattern of ["scripts/player.gdc", "\\scripts\\player.gdc", "/scripts/player.gdc"]) {
    assert.deepEqual(selected("all", [pattern]).expectedMembers, ["res://scripts/player.gdc"], pattern);
  }
});

test("overlapping includes dedupe while preserving member order", () => {
  const outcome = selected("all", ["res://**/*.gd", "res://scripts/nested/*.gd"]);
  assert.deepEqual(outcome.expectedMembers, [
    "res://main.gd",
    "res://scripts/nested/deep.gd",
    "res://addons/plugin/plugin.gd",
    "res://.hidden/secret.gd",
    "res://.dotfile.gd",
  ]);
});

test("an include with zero matches yields an explicit empty no-match set", () => {
  const outcome = selected("all", ["res://**/*.nope"]);
  assert.deepEqual(outcome.expectedMembers, []);
  assert.equal(outcome.classification, "no_match");
});

test("bare *.gd exclude removes nested members but leaves root members (asymmetry)", () => {
  const outcome = selected("all", [], ["*.gd"]);
  assert.equal(outcome.classification, "selected");
  assert.deepEqual(outcome.expectedMembers, [
    "res://project.godot",
    "res://main.gd",
    "res://scripts/player.gdc",
    "res://scripts/enemy.gde",
    "res://data/nested.bin",
    "res://data/deep/thing.txt",
    "res://textures/icon.png",
    "res://locales/en.translation",
    "res://locales/zh_CN.xl",
    "res://.dotfile.gd",
    "res://case/Case.GDC",
    "res://case/Case.XL",
  ]);
});

test("rooted res://*.gd exclude crosses slashes and removes root and nested members", () => {
  const outcome = selected("all", [], ["res://*.gd"]);
  assert.deepEqual(outcome.expectedMembers, [
    "res://project.godot",
    "res://scripts/player.gdc",
    "res://scripts/enemy.gde",
    "res://data/nested.bin",
    "res://data/deep/thing.txt",
    "res://textures/icon.png",
    "res://locales/en.translation",
    "res://locales/zh_CN.xl",
    "res://case/Case.GDC",
    "res://case/Case.XL",
  ]);
});

test("res://**/*.gd exclude removes nested members but leaves root members", () => {
  const outcome = selected("all", [], ["res://**/*.gd"]);
  assert.equal(outcome.expectedMembers.includes("res://main.gd"), true);
  assert.equal(outcome.expectedMembers.includes("res://.dotfile.gd"), true);
  assert.equal(outcome.expectedMembers.includes("res://scripts/nested/deep.gd"), false);
  assert.equal(outcome.expectedMembers.includes("res://addons/plugin/plugin.gd"), false);
  assert.equal(outcome.expectedMembers.includes("res://.hidden/secret.gd"), false);
  assert.equal(outcome.expectedMembers.length, 12);
});

test("exclude ? matches exactly one character", () => {
  const outcome = selected("all", [], ["res://scripts/?layer.gdc"]);
  assert.equal(outcome.expectedMembers.includes("res://scripts/player.gdc"), false);
  assert.equal(outcome.expectedMembers.length, 14);
});

test("an exclude that removes everything yields an explicit empty no-match set", () => {
  const outcome = selected("all", [], ["res://**"]);
  assert.deepEqual(outcome.expectedMembers, []);
  assert.equal(outcome.classification, "no_match");
});

test("include then exclude applies the exclude to the include result", () => {
  const outcome = selected("all", ["res://**/*.gd"], ["res://addons/*"]);
  assert.deepEqual(outcome.expectedMembers, [
    "res://main.gd",
    "res://scripts/nested/deep.gd",
    "res://.hidden/secret.gd",
    "res://.dotfile.gd",
  ]);
});

test("directory sources admit only bare-star filter patterns", () => {
  const bare = deriveSelectedMembers(request("all", ["*.gdc"]), members, "directory");
  assert.equal(bare.ok, true);
  if (bare.ok) {
    assert.deepEqual(bare.expectedMembers, ["res://scripts/player.gdc"]);
  }

  for (const pattern of ["res://scripts/player.gdc", "scripts/player.gdc", "res://**/*.gd", "res://*.gd", "scripts/*.gdc"]) {
    const outcome = deriveSelectedMembers(request("all", [pattern]), members, "directory");
    assert.equal(outcome.ok, false, pattern);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "directory_filter_unsupported");
      assert.deepEqual(outcome.patterns, [pattern]);
    }
  }
});

test("directory sources still accept modes and an unfiltered all selection", () => {
  const all = deriveSelectedMembers(request("all"), members, "directory");
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.expectedMembers.length, members.length);

  const scripts = deriveSelectedMembers(request("scripts"), members, "directory");
  assert.equal(scripts.ok, true);
  if (scripts.ok) assert.equal(scripts.expectedMembers.length, 8);
});

test("a non-all mode combined with filters is rejected", () => {
  assert.throws(
    () => deriveSelectedMembers(request("scripts", ["res://main.gd"]), members, "package"),
    /cannot be combined|filter/u,
  );
});

test("derivation honors an aborted signal", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      deriveSelectedMembers(request("all", ["res://**/*.gd"]), members, "package", {
        signal: controller.signal,
      }),
    /aborted/u,
  );
});

test("derivation honors a monotonic deadline", () => {
  assert.throws(
    () => deriveSelectedMembers(request("all"), members, "package", { deadlineMono: performance.now() - 1 }),
    /deadline/u,
  );
});

test("repeated-star patterns terminate without catastrophic backtracking", () => {
  const long = `res://data/${"a".repeat(4_000)}.txt`;
  const pattern = `res://**/${"a*".repeat(40)}b`;
  const excluded = deriveSelectedMembers(request("all", [], [pattern]), [long], "package");
  assert.equal(excluded.ok, true);
  if (excluded.ok) assert.deepEqual(excluded.expectedMembers, [long]);

  const included = deriveSelectedMembers(request("all", [pattern]), [long], "package");
  assert.equal(included.ok, true);
  if (included.ok) {
    assert.deepEqual(included.expectedMembers, []);
    assert.equal(included.classification, "no_match");
  }
});

test("deep recursive ** patterns terminate and do not match", () => {
  const deep = ["res://a/b/c/d/e/f/g/h/i/j/k.txt"];
  const pattern = `res://${"**/".repeat(24)}nope.txt`;
  const outcome = deriveSelectedMembers(request("all", [pattern]), deep, "package");
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.expectedMembers, []);
    assert.equal(outcome.classification, "no_match");
  }
});

test("? matches exactly one Unicode code point like the runtime", () => {
  const member = ["res://emoji/😀.gd"];
  const one = deriveSelectedMembers(request("all", ["res://emoji/?.gd"]), member, "package");
  assert.equal(one.ok, true);
  if (one.ok) assert.deepEqual(one.expectedMembers, member);

  const two = deriveSelectedMembers(request("all", ["res://emoji/??.gd"]), member, "package");
  assert.equal(two.ok, true);
  if (two.ok) assert.equal(two.classification, "no_match");
});
