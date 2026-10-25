import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  admittedPrimaryInputs,
  defaultSiblingOutput,
  OutputPlacementError,
  type PlacementPrimaryInput,
} from "../src/output-placement.js";
import { joinPath } from "../src/paths.js";

const operationId = "11111111-2222-3333-4444-555555555555";
const operationDirectory = joinPath(
  os.tmpdir(),
  "GodotGdreMcp",
  ".gdre",
  "operations",
  operationId,
);
const inputs = joinPath(os.tmpdir(), "gdre-output-placement-fixtures", "inputs");

const primary = (
  realPath: string,
  kind: PlacementPrimaryInput["kind"] = "file",
): PlacementPrimaryInput => ({ realPath, kind });

test("a file input strips only its final extension and places the product beside it", () => {
  const input = joinPath(inputs, "game.v1.pck");
  const output = defaultSiblingOutput({
    operationDirectory,
    kind: "extracted",
    primaryInputs: [primary(input)],
  });
  assert.equal(output, joinPath(inputs, `game.v1-extracted-${operationId}`));
  assert.equal(path.dirname(output), path.dirname(input));
});

test("a directory input keeps its dotted name and never writes inside itself", () => {
  const input = joinPath(inputs, "project.bundle");
  const output = defaultSiblingOutput({
    operationDirectory,
    kind: "exported",
    primaryInputs: [primary(input, "directory")],
  });
  assert.equal(output, joinPath(inputs, `project.bundle-exported-${operationId}`));
  assert.notEqual(path.dirname(output), input);
});

test("multiple primaries sharing one parent use the gdre operation-kind name", () => {
  for (const kind of ["extracted", "exported", "translations"] as const) {
    const output = defaultSiblingOutput({
      operationDirectory,
      kind,
      primaryInputs: [
        primary(joinPath(inputs, "first.pck")),
        primary(joinPath(inputs, "second.pck")),
      ],
    });
    assert.equal(output, joinPath(inputs, `gdre-${kind}-${operationId}`));
  }
});

test("different primary parents require explicit output", () => {
  assert.throws(
    () =>
      defaultSiblingOutput({
        operationDirectory,
        kind: "extracted",
        primaryInputs: [
          primary(joinPath(inputs, "first.pck")),
          primary(joinPath(inputs, "elsewhere", "second.pck")),
        ],
      }),
    (error: unknown) =>
      error instanceof OutputPlacementError &&
      /explicit output/u.test(error.message) &&
      /different parent/u.test(error.message),
  );
});

test("missing primaries require explicit output", () => {
  assert.throws(
    () =>
      defaultSiblingOutput({
        operationDirectory,
        kind: "translations",
        primaryInputs: [],
      }),
    (error: unknown) =>
      error instanceof OutputPlacementError && /explicit output/u.test(error.message),
  );
});

test("a directory that is itself a filesystem root requires explicit output", () => {
  const root = path.parse(process.cwd()).root;
  assert.throws(
    () =>
      defaultSiblingOutput({
        operationDirectory,
        kind: "extracted",
        primaryInputs: [primary(root, "directory")],
      }),
    (error: unknown) =>
      error instanceof OutputPlacementError && /explicit output/u.test(error.message),
  );
});

test("a file directly inside a filesystem root still gets a sibling product", () => {
  const root = path.parse(process.cwd()).root;
  const output = defaultSiblingOutput({
    operationDirectory,
    kind: "extracted",
    primaryInputs: [primary(joinPath(root, "game.pck"))],
  });
  assert.equal(output, joinPath(root, `game-extracted-${operationId}`));
});

test("patched placement yields one .pck file beside the single source", () => {
  const input = joinPath(inputs, "game.pck");
  const output = defaultSiblingOutput({
    operationDirectory,
    kind: "patched",
    primaryInputs: [primary(input)],
  });
  assert.equal(output, joinPath(inputs, `game-patched-${operationId}.pck`));
  assert.equal(path.extname(output), ".pck");
});

test("patched placement rejects multiple sources before proposing any path", () => {
  assert.throws(
    () =>
      defaultSiblingOutput({
        operationDirectory,
        kind: "patched",
        primaryInputs: [
          primary(joinPath(inputs, "first.pck")),
          primary(joinPath(inputs, "second.pck")),
        ],
      }),
    (error: unknown) =>
      error instanceof OutputPlacementError && /explicit output/u.test(error.message),
  );
});

test("the operation identifier is the existing final operation-directory segment", () => {
  const first = defaultSiblingOutput({
    operationDirectory,
    kind: "extracted",
    primaryInputs: [primary(joinPath(inputs, "game.pck"))],
  });
  const repeated = defaultSiblingOutput({
    operationDirectory,
    kind: "extracted",
    primaryInputs: [primary(joinPath(inputs, "game.pck"))],
  });
  const other = defaultSiblingOutput({
    operationDirectory: joinPath(
      os.tmpdir(),
      "GodotGdreMcp",
      ".gdre",
      "operations",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ),
    kind: "extracted",
    primaryInputs: [primary(joinPath(inputs, "game.pck"))],
  });
  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.match(first, new RegExp(operationId, "u"));
});

test("placement is a pure proposal that creates nothing", async () => {
  const input = joinPath(inputs, "never-written.pck");
  const output = defaultSiblingOutput({
    operationDirectory,
    kind: "exported",
    primaryInputs: [primary(input)],
  });
  await assert.rejects(stat(output), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(input), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("admitted primaries come from resolved inputs, not auxiliary input fingerprints", () => {
  const pack = joinPath(inputs, "game.pck");
  const hint = joinPath(inputs, "elsewhere", "hints.txt");
  const selection = admittedPrimaryInputs({
    resolvedInputs: [pack],
    fingerprints: [
      { path: pack, realPath: pack, kind: "file" },
      { path: hint, realPath: hint, kind: "file" },
    ],
  });
  assert.deepEqual(selection, [{ realPath: pack, kind: "file" }]);
});
