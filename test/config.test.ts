import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

test("configuration resolves relative paths from their documented roots and rejects unsafe budgets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-"));
  const installationRoot = path.join(root, "package");
  const configDirectory = path.join(root, "config");
  const configPath = path.join(configDirectory, "selected.json");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDirectory, { recursive: true }));
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceRoot: "workspace",
        runtimeDirectory: "vendor/runtime",
        targetVersion: "2.8.0-beta.2",
        timeouts: { maxMs: 3000 },
        defaults: {},
        settings: {},
      }),
      "utf8",
    );
    const config = await loadConfig(installationRoot, { GDRE_MCP_CONFIG: configPath });
    assert.equal(config.workspaceRoot, path.join(configDirectory, "workspace"));
    assert.equal(config.runtimeDirectory, path.join(installationRoot, "vendor", "runtime"));
    assert.deepEqual(config.timeouts, { maxMs: 3000 });

    await writeFile(configPath, JSON.stringify({ workspaceRoot: "workspace", timeouts: { maxMs: 0 } }), "utf8");
    await assert.rejects(
      loadConfig(installationRoot, { GDRE_MCP_CONFIG: configPath }),
      (error: unknown) => error instanceof ConfigError && error.message.includes("positive integer"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired implicit timeout fields require an actionable migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-retired-timeouts-"));
  const configPath = path.join(root, "config.json");
  try {
    for (const field of ["defaultMs", "queueMs"]) {
      await writeFile(configPath, JSON.stringify({ workspaceRoot: root, timeouts: { [field]: 1000 } }), "utf8");
      await assert.rejects(
        loadConfig(root, { GDRE_MCP_CONFIG: configPath }),
        (error: unknown) => error instanceof ConfigError && error.message.includes(`timeouts.${field}`) && error.message.includes("defaults.<command>.timeoutMs"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration rejects unknown fields with or without an explicit workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-invalid-"));
  const configPath = path.join(root, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ unknown: true }), "utf8");
    await assert.rejects(loadConfig(root, { GDRE_MCP_CONFIG: configPath }), ConfigError);
    await writeFile(configPath, JSON.stringify({ workspaceRoot: root, unknown: true }), "utf8");
    await assert.rejects(loadConfig(root, { GDRE_MCP_CONFIG: configPath }), ConfigError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction defaults accept only timeoutMs and ordered multithreading session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-config-extract-"));
  const configPath = path.join(root, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceRoot: root,
        defaults: {
          extract: {
            timeoutMs: 45_000,
            session: [{ kind: "multithreading", disabled: true }],
          },
        },
      }),
      "utf8",
    );
    const config = await loadConfig(root, { GDRE_MCP_CONFIG: configPath });
    assert.deepEqual(config.defaults.extract, {
      timeoutMs: 45_000,
      session: [{ kind: "multithreading", disabled: true }],
    });

    for (const invalidDefaults of [
      { extract: { inputs: [{ kind: "path", path: "pack.pck" }] } },
      { extract: { output: "exports/out" } },
      { extract: { include: ["res://*"] } },
      { extract: { exclude: ["res://*.tmp"] } },
      { extract: { selection: "scripts" } },
      { extract: { key: "a".repeat(64) } },
      { extract: { checksum: "skip" } },
      { extract: { session: [{ kind: "setting", key: "x", value: true }] } },
    ]) {
      await writeFile(
        configPath,
        JSON.stringify({ workspaceRoot: root, defaults: invalidDefaults }),
        "utf8",
      );
      await assert.rejects(
        loadConfig(root, { GDRE_MCP_CONFIG: configPath }),
        ConfigError,
        JSON.stringify(invalidDefaults),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
