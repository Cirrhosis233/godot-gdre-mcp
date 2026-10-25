import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSupportedAbsolutePath, resolveWorkspacePath } from "../src/paths.js";

test("workspace identity resolves junction aliases to the same identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-paths-"));
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  await mkdir(real, { recursive: true });
  await symlink(real, alias, "junction");
  try {
    const resolvedReal = await resolveWorkspacePath(real);
    const resolvedAlias = await resolveWorkspacePath(alias);
    assert.equal(resolvedAlias.identity, resolvedReal.identity);
    assert.notEqual(resolvedAlias.display, resolvedReal.display);
  } finally {
    await rm(alias, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows superscript COM and LPT device names are rejected without excluding ordinary Unicode names", () => {
  for (const prefix of ["COM", "LPT"]) {
    for (const digit of ["¹", "²", "³"]) {
      assert.equal(isSupportedAbsolutePath(`D:/folder/${prefix}${digit}`), false);
      assert.equal(isSupportedAbsolutePath(`D:/folder/${prefix.toLowerCase()}${digit}.txt`), false);
    }
  }
  assert.equal(isSupportedAbsolutePath("D:/folder/COM²Example.txt"), true);
  assert.equal(isSupportedAbsolutePath("D:/folder/文本¹.txt"), true);
});

test("UNC shares and reserved console device names are rejected", () => {
  assert.equal(isSupportedAbsolutePath("\\\\server\\share"), false);
  assert.equal(isSupportedAbsolutePath("D:/CONIN$"), false);
  assert.equal(isSupportedAbsolutePath("D:/CONOUT$"), false);
  assert.equal(isSupportedAbsolutePath("D:/folder/CONIN$.txt"), false);
  assert.equal(isSupportedAbsolutePath("D:/folder/NUL.txt"), false);
});
