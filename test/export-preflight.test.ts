import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExportPreflightError,
  parseExportPreflightValue,
  readExportPreflightEvidence,
} from "../src/export-preflight.js";

const validPayload = {
  schemaVersion: 1,
  ok: true,
  file_count: 4,
  import_count: 2,
  files: [
    "res://project.godot",
    "res://mat.png",
    "res://.godot/imported/mat.png-abc.ctex",
    "res://main.gdc",
  ],
  imports: [
    {
      path: "res://.godot/imported/mat.png-abc.ctex",
      import_md_path: "res://mat.png.import",
      source_file: "res://mat.png",
      importer: "texture",
      type: "CompressedTexture2D",
      dest_files: ["res://.godot/imported/mat.png-abc.ctex"],
    },
    {
      path: "res://main.gdc",
      import_md_path: "res://main.gd.remap",
      source_file: "res://main.gd",
      importer: "script_bytecode",
      type: "GDScript",
      dest_files: ["res://main.gdc"],
    },
  ],
};

test("valid native inspector evidence maps files and all supported import getters", () => {
  const evidence = parseExportPreflightValue(validPayload);
  assert.deepEqual(evidence.files, validPayload.files);
  assert.deepEqual(evidence.imports, [
    {
      path: "res://.godot/imported/mat.png-abc.ctex",
      importMdPath: "res://mat.png.import",
      sourceFile: "res://mat.png",
      importer: "texture",
      type: "CompressedTexture2D",
      destFiles: ["res://.godot/imported/mat.png-abc.ctex"],
    },
    {
      path: "res://main.gdc",
      importMdPath: "res://main.gd.remap",
      sourceFile: "res://main.gd",
      importer: "script_bytecode",
      type: "GDScript",
      destFiles: ["res://main.gdc"],
    },
  ]);
});

test("extra future fields are tolerated but malformed shapes are rejected", () => {
  const withExtra = parseExportPreflightValue({
    ...validPayload,
    future_flag: true,
    imports: validPayload.imports.map((entry) => ({ ...entry, future_field: 1 })),
  });
  assert.equal(withExtra.files.length, 4);

  const invalidPayloads: unknown[] = [
    { ...validPayload, schemaVersion: 2 },
    { ...validPayload, ok: false },
    { ...validPayload, file_count: 3 },
    { ...validPayload, import_count: 1 },
    { ...validPayload, files: [...validPayload.files, "res://project.godot"] },
    { ...validPayload, files: ["user://project.godot", ...validPayload.files.slice(1)] },
    { ...validPayload, imports: [{ ...validPayload.imports[0], dest_files: "res://x" }] },
    { ...validPayload, imports: [{ ...validPayload.imports[0], importer: 5 }] },
  ];
  for (const value of invalidPayloads) {
    assert.throws(
      () => parseExportPreflightValue(value),
      ExportPreflightError,
      JSON.stringify(value),
    );
  }
});

test("inspector-reported load failure is a semantic failure with its message", () => {
  assert.throws(
    () => parseExportPreflightValue({
      schemaVersion: 1,
      ok: false,
      error: "could not load project",
    }),
    (error: unknown) =>
      error instanceof ExportPreflightError &&
      error.code === "semantic_failed" &&
      error.message.includes("could not load project"),
  );
});

test("reading preflight evidence distinguishes missing or invalid JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-export-preflight-"));
  try {
    const file = path.join(root, "native-preflight.json");
    await writeFile(file, JSON.stringify(validPayload), "utf8");
    const evidence = await readExportPreflightEvidence(file);
    assert.equal(evidence.path, file);
    assert.equal(evidence.files.length, 4);

    const bad = path.join(root, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    await assert.rejects(readExportPreflightEvidence(bad), (error: unknown) =>
      error instanceof ExportPreflightError && error.code === "semantic_unknown",
    );
    await assert.rejects(
      readExportPreflightEvidence(path.join(root, "missing.json")),
      (error: unknown) => error instanceof ExportPreflightError && error.code === "semantic_unknown",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
