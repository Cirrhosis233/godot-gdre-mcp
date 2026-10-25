import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createStandaloneTranslationFixture,
  defaultTranslationRuntimeExecutable,
  readTranslationOutputs,
  sha256Bytes,
  sha256File,
  type CreateStandaloneTranslationFixtureOptions,
  type StandaloneTranslationFixture,
} from "./support/translation-fixtures.js";
import { createFixtureProfile } from "./support/extraction-input-fixtures.js";
import { createPckFixture } from "./support/listing-fixtures.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const serverPath = path.join(repositoryRoot, "dist", "src", "index.js");
const runtimeDirectory = path.join(repositoryRoot, "vendor", "GDRE_tools");

/** Finite client watchdog for these controlled fixture workloads. */
const clientRequestOptions = { timeout: 240_000, maxTotalTimeout: 240_000 };

type AnyRecord = Record<string, any>;

interface StartedPatchClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly workspace: string;
  readonly root: string;
}

const childEnvironment = (configFile: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  GDRE_MCP_CONFIG: configFile,
});

async function startClient(): Promise<StartedPatchClient> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-patch-stdio-"));
  const workspace = path.join(root, "workspace");
  const callerCwd = path.join(root, "caller cwd");
  await mkdir(callerCwd, { recursive: true });
  const configFile = path.join(root, "gdre-mcp.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      workspaceRoot: workspace,
      runtimeDirectory,
      targetVersion: "2.8.0-beta.2",
      timeouts: { maxMs: 3_600_000 },
      defaults: {},
      settings: {},
    }),
    "utf8",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: callerCwd,
    env: childEnvironment(configFile),
    stderr: "pipe",
  });
  const client = new Client({
    name: "ticket-08-patch-translations-stdio",
    version: "0.1.0",
  });
  await client.connect(transport);
  return { client, transport, workspace, root };
}

async function closeClient(started: StartedPatchClient): Promise<void> {
  await started.client.close().catch(() => undefined);
  await started.transport.close().catch(() => undefined);
  await rm(started.root, { recursive: true, force: true });
}

const callPatch = async (
  started: StartedPatchClient,
  arguments_: AnyRecord,
): Promise<{ readonly wire: AnyRecord; readonly result: AnyRecord }> => {
  const wire = (await started.client.callTool(
    { name: "gdre_patch_translations", arguments: arguments_ },
    clientRequestOptions,
  )) as AnyRecord;
  return { wire, result: wire.structuredContent as AnyRecord };
};

const readJson = async (file: string): Promise<AnyRecord> =>
  JSON.parse(await readFile(file, "utf8")) as AnyRecord;

const normalizePath = (value: string): string =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

const assertPathWithin = (
  child: string,
  parent: string,
  label: string,
): void => {
  const normalizedChild = normalizePath(child);
  const normalizedParent = normalizePath(parent).replace(/\/+$/u, "");
  assert.ok(
    normalizedChild === normalizedParent ||
      normalizedChild.startsWith(`${normalizedParent}/`),
    `${label} is outside the operation profile: ${child} not within ${parent}`,
  );
};

const knownSyntheticDiagnostic = "OS_Windows::get_system_dir";

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

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(full)).map((item) => `${entry.name}/${item}`),
      );
    } else {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function listFilesIfExists(directory: string): Promise<string[]> {
  try {
    return await listFiles(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const fixtureCsvPath = (
  started: StartedPatchClient,
  name: string,
): string => path.join(started.workspace, "fixtures", `${name}.csv`);

const writeFixtureCsv = async (
  started: StartedPatchClient,
  name: string,
  text: string | Uint8Array,
): Promise<string> => {
  const file = fixtureCsvPath(started, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
};

async function snapshotTree(directory: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${relative}`);
        await visit(full, relative);
      } else {
        lines.push(`f ${relative} ${await sha256File(full)}`);
      }
    }
  };
  await visit(directory, "");
  return sha256Bytes(Buffer.from(lines.join("\n"), "utf8"));
}

async function assertNoTemporaryTranslationDirectory(
  profileRoot: string,
): Promise<void> {
  const entries = await readdir(profileRoot, { recursive: true });
  assert.ok(
    !entries.some((entry) => String(entry).includes(".tmp_translations")),
    "native profile retained a .tmp_translations directory",
  );
}

const fixtureAt = (
  started: StartedPatchClient,
  name: string,
  options: Omit<CreateStandaloneTranslationFixtureOptions, "root"> = {},
): Promise<StandaloneTranslationFixture> =>
  createStandaloneTranslationFixture({
    root: path.join(started.workspace, "fixtures", name),
    ...options,
  });

const packageInput = (name: string): readonly AnyRecord[] => [
  { kind: "path", path: `fixtures/${name}/fixture.pck` },
];

test("real stdio discovers and patches standalone translations", async (t) => {
  const started = await startClient();
  try {
    const fixture = await fixtureAt(started, "main");
    const pckBefore = await sha256File(fixture.packagePath);
    const sourceBefore = await snapshotTree(fixture.sourceDirectory);

    await t.test("discovers gdre_patch_translations", async () => {
      const listed = await started.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.ok(names.includes("gdre_patch_translations"));
      for (const name of [
        "gdre_version",
        "gdre_list_files",
        "gdre_extract",
        "gdre_export_resources",
      ]) {
        assert.ok(names.includes(name), name);
      }
    });

    await t.test(
      "omitted output places the product beside the package, not the CSV",
      async () => {
        const defaultCsv = await writeFixtureCsv(
          started,
          "default",
          "en,zh,key\nDefault English,默认值,A\n",
        );
        const pckBefore = await sha256File(fixture.packagePath);
        const sourceBefore = await snapshotTree(fixture.sourceDirectory);

        const { wire, result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [
            { csv: defaultCsv, resource: fixture.importSource },
          ],
          locales: ["zh"],
        });
        assert.equal(
          result.success,
          true,
          JSON.stringify({ error: result.error, semantic: result.semantic }),
        );
        assert.equal(wire.isError, false);
        const effective = path.join(
          fixture.root,
          `fixture-translations-${path.basename(result.paths.operation!)}`,
        );
        assert.equal(result.paths.effectiveDestination, effective);
        assert.equal(
          result.paths.output,
          path.join(result.paths.operation!, "output"),
          "internal output stays operation-owned",
        );
        assert.notEqual(result.paths.effectiveDestination, result.paths.output);
        assert.deepEqual(
          await listFilesIfExists(result.paths.output!),
          [],
          "no product is written into internal state",
        );

        const data = result.semantic.data as AnyRecord;
        assert.equal(data.completeness, "complete");
        const report = await readJson(data.reports.native);
        assert.equal(report.ok, true);
        assert.equal(normalizePath(report.output), normalizePath(effective));
        const output = (report.outputs as AnyRecord[])[0]!;
        assert.equal(output.member, fixture.translationMembers.zh);
        assert.equal(
          normalizePath(output.path),
          normalizePath(
            path.join(effective, fixture.translationMembers.zh.slice("res://".length)),
          ),
        );
        assert.equal(await sha256File(output.path), output.sha256);

        const read = await readTranslationOutputs({
          fixture,
          workspace: path.join(started.root, "reader-operations", "default"),
          outputs: [output.path],
        });
        assert.equal(read.outputs[0]!.locale, "zh");
        assert.equal(read.outputs[0]!.A, "默认值");
        assert.equal(read.outputs[0]!.B, fixture.values.zh.B);

        assert.equal(await sha256File(fixture.packagePath), pckBefore, "package input unchanged");
        assert.equal(await snapshotTree(fixture.sourceDirectory), sourceBefore, "fixture source unchanged");

        // The CSV participates as a protected input but must not choose the parent.
        const manifest = await readJson(result.paths.manifest!);
        assert.ok(manifest.effects.reads.includes(defaultCsv));
        assert.ok(manifest.effects.writes.includes(effective));
        assert.ok(
          manifest.invocation.inputPaths.some(
            (entry: AnyRecord) =>
              entry.role === "translation-csv" && entry.path === defaultCsv,
          ),
        );
      },
    );

    await t.test(
      "explicit zh applies BOM/CRLF key-last CSV text and retains B",
      async () => {
        const originalCsv = path.join(
          started.workspace,
          ".gdre",
          "operations",
          "prior-export",
          "output",
          "edited.csv",
        );
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const csvBytes = Buffer.concat([
          bom,
          Buffer.from(
            'en,zh,key\r\nNew English,"您好, 世界\r\n第二行",A\r\n',
            "utf8",
          ),
        ]);
        await mkdir(path.dirname(originalCsv), { recursive: true });
        await writeFile(originalCsv, csvBytes);
        const csvBefore = await sha256File(originalCsv);
        const effective = path.join(started.workspace, "patch", "explicit");

        const { wire, result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [
            { csv: originalCsv, resource: fixture.importSource },
          ],
          output: "patch/explicit",
          locales: ["zh"],
        });
        assert.equal(
          result.success,
          true,
          JSON.stringify({ error: result.error, semantic: result.semantic }),
        );
        assert.equal(wire.isError, false);
        assert.equal(result.status, "succeeded");
        assert.equal(result.error, null);
        assert.equal(result.paths.effectiveDestination, effective);
        const data = result.semantic.data as AnyRecord;
        assert.ok(data !== null, "semantic data");
        assert.equal(data.completeness, "complete");
        assert.deepEqual(data.localeSelection, {
          mode: "explicit",
          locales: ["zh"],
        });
        assert.equal(data.counts.mappings, 1);
        assert.equal(data.counts.outputs, 1);
        assert.equal(data.counts.verifiedResources, 1);
        assert.equal(data.counts.verifiedTexts, 1);
        assert.equal(data.counts.preparedCsvs, 1);

        const request = await readJson(data.reports.request);
        assert.equal("key" in request, false);
        assert.deepEqual(request.inputs, [fixture.packagePath]);
        assert.equal(normalizePath(request.output), normalizePath(effective));
        assert.deepEqual(request.locales, ["zh"]);
        assert.equal(request.translations.length, 1);
        const requestTranslation = request.translations[0] as AnyRecord;
        assert.equal(requestTranslation.resource, fixture.importSource);
        assert.deepEqual(requestTranslation.columns, ["en", "zh", "key"]);
        assert.deepEqual(requestTranslation.rows, [
          ["New English", "您好, 世界\n第二行", "A"],
        ]);
        const preparedPath = String(requestTranslation.csv);
        const preparedBytes = await readFile(preparedPath);
        assert.deepEqual(preparedBytes, csvBytes.subarray(3));

        const report = await readJson(data.reports.native);
        assert.equal(report.version, 1);
        assert.equal(report.ok, true);
        assert.equal(report.stage, "complete");
        assert.equal(report.nativeCode, 0);
        assert.equal(report.error, null);
        assert.equal(normalizePath(report.output), normalizePath(effective));
        assertPathWithin(
          report.userData,
          path.join(result.paths.operation!, "profile"),
          "native user data",
        );
        assertPathWithin(
          report.temp,
          path.join(result.paths.operation!, "profile"),
          "native temporary directory",
        );
        assert.equal(report.mappings.length, 1);
        assert.equal(report.mappings[0].resource, fixture.importSource);
        assert.equal(report.mappings[0].csv, preparedPath);
        assert.equal(report.mappings[0].defaultLocale, fixture.defaultLocale);
        assert.deepEqual(report.mappings[0].locales, ["zh"]);
        assert.equal((report.outputs as AnyRecord[]).length, 1);
        const output = (report.outputs as AnyRecord[])[0]!;
        assert.equal(output.resource, fixture.importSource);
        assert.equal(output.member, fixture.translationMembers.zh);
        assert.equal(
          normalizePath(output.path),
          normalizePath(
            path.join(
              effective,
              fixture.translationMembers.zh.slice("res://".length),
            ),
          ),
        );
        assert.equal(output.locale, "zh");
        assert.equal(output.class, "OptimizedTranslation");
        assert.equal(output.verifiedTexts, 1);
        assert.equal(output.retainedContentVerified, true);
        assert.match(output.sha256, /^[0-9a-f]{64}$/u);
        assert.ok(output.bytes > 0);
        const fileMap = Object.fromEntries(
          Object.entries(report.fileMap as Record<string, string>).map(
            ([key, value]) => [normalizePath(key), value],
          ),
        );
        assert.equal(
          fileMap[normalizePath(path.join(effective, "project.godot"))],
          fixture.projectConfigMember,
        );
        assert.equal(fileMap[normalizePath(output.path)], output.member);
        assert.equal(report.projectConfig.member, fixture.projectConfigMember);
        assert.equal(
          normalizePath(report.projectConfig.path),
          normalizePath(path.join(effective, "project.godot")),
        );
        assert.equal(
          await sha256File(path.join(effective, "project.godot")),
          report.projectConfig.sha256,
        );
        assert.equal(await sha256File(output.path), output.sha256);

        const read = await readTranslationOutputs({
          fixture,
          workspace: path.join(started.root, "reader-operations", "explicit"),
          outputs: [output.path],
        });
        assert.equal(read.outputs.length, 1);
        assert.equal(read.outputs[0]!.class, "OptimizedTranslation");
        assert.equal(read.outputs[0]!.locale, "zh");
        assert.equal(read.outputs[0]!.A, "您好, 世界\n第二行");
        assert.equal(read.outputs[0]!.B, "保留");
        assert.deepEqual([...(read.outputs[0]!.messages.zh as string[])].sort(), [
          "您好, 世界\n第二行",
          "保留",
        ].sort());

        // Artifact inventory is complete and distinguishes translation output
        // from accompanying project configuration.
        assert.equal(result.artifacts.complete, true);
        const inventory = await readJson(result.paths.artifactInventory!);
        const roles = new Map(
          (inventory.entries as AnyRecord[]).map((entry) => [
            normalizePath(entry.path),
            entry.role,
          ]),
        );
        assert.equal(roles.get(normalizePath(output.path)), "translation-output");
        assert.equal(
          roles.get(normalizePath(path.join(effective, "project.godot"))),
          "accompanying",
        );

        // Effective provenance keeps the original CSV and exact mapping.
        const manifest = await readJson(result.paths.manifest!);
        assert.deepEqual(manifest.effectiveParameters.translations, [
          { csv: originalCsv, resource: fixture.importSource },
        ]);
        assert.equal(manifest.parameterSources.inputs, "call");
        assert.equal(manifest.parameterSources.translations, "call");
        assert.equal(manifest.parameterSources.locales, "call");
        assert.ok(manifest.effects.reads.includes(originalCsv));
        assert.ok(manifest.effects.writes.includes(preparedPath));
        assert.ok(
          manifest.invocation.inputPaths.some(
            (entry: AnyRecord) =>
              entry.role === "translation-csv" && entry.path === originalCsv,
          ),
        );

        await assertNoTemporaryTranslationDirectory(
          path.join(result.paths.operation!, "profile"),
        );
        assertNoUnexpectedNativeErrors(result.stderr.text);

        // Originals remain unchanged.
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(await sha256File(originalCsv), csvBefore);
        assert.equal(await snapshotTree(fixture.sourceDirectory), sourceBefore);

        // A second explicit write to the now-populated destination is rejected
        // before any native launch.
        const outputBefore = await sha256File(output.path);
        const second = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [
            { csv: originalCsv, resource: fixture.importSource },
          ],
          output: "patch/explicit",
          locales: ["zh"],
        });
        assert.equal(second.result.success, false);
        assert.equal(second.wire.isError, true);
        assert.equal(second.result.error?.code, "path_unsupported");
        assert.match(second.result.error?.message ?? "", /not empty/iu);
        assert.equal(second.result.process.pid, null);
        assert.equal(await sha256File(output.path), outputBefore);
      },
    );

    await t.test(
      "omitted locales emit only the new fr column and retain default B",
      async () => {
        const csv = await writeFixtureCsv(
          started,
          "omitted",
          "key,en,zh,fr\r\nA,New English,旧值,Bonjour\r\n",
        );
        const csvBefore = await sha256File(csv);
        const effective = path.join(started.workspace, "patch", "omitted");
        const { wire, result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [{ csv, resource: fixture.importSource }],
          output: "patch/omitted",
        });
        assert.equal(
          result.success,
          true,
          JSON.stringify({ error: result.error, semantic: result.semantic }),
        );
        assert.equal(wire.isError, false);
        const data = result.semantic.data as AnyRecord;
        assert.equal(data.completeness, "complete");
        assert.deepEqual(data.localeSelection, {
          mode: "new-locales-only",
          locales: ["fr"],
        });
        const report = await readJson(data.reports.native);
        assert.equal(report.ok, true);
        assert.deepEqual(report.mappings[0].locales, ["fr"]);
        assert.equal((report.outputs as AnyRecord[]).length, 1);
        const output = (report.outputs as AnyRecord[])[0]!;
        assert.equal(output.locale, "fr");
        assert.equal(
          output.member,
          "res://.godot/imported/translations.fr.translation",
        );
        assert.deepEqual(await listFiles(effective), [
          ".godot/imported/translations.fr.translation",
          "project.godot",
        ]);
        const read = await readTranslationOutputs({
          fixture,
          workspace: path.join(started.root, "reader-operations", "omitted"),
          outputs: [output.path],
        });
        assert.equal(read.outputs[0]!.locale, "fr");
        assert.equal(read.outputs[0]!.A, "Bonjour");
        assert.equal(read.outputs[0]!.B, fixture.values.en.B);
        assert.deepEqual(
          [...(read.outputs[0]!.messages.fr as string[])].sort(),
          ["Bonjour", fixture.values.en.B].sort(),
        );
        assert.equal(await sha256File(csv), csvBefore);
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(
          await snapshotTree(fixture.sourceDirectory),
          sourceBefore,
        );
        assertNoUnexpectedNativeErrors(result.stderr.text);
      },
    );

    await t.test(
      "omitted locales with no new target fail without expanding to all locales",
      async () => {
        const csv = await writeFixtureCsv(
          started,
          "no-new-locale",
          "key,en,zh\r\nA,New English,旧值\r\n",
        );
        const csvBefore = await sha256File(csv);
        const effective = path.join(started.workspace, "patch", "no-new");
        const { wire, result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [{ csv, resource: fixture.importSource }],
          output: "patch/no-new",
        });
        assert.equal(result.success, false);
        assert.equal(wire.isError, true);
        assert.equal(result.error?.code, "semantic_failed");
        const data = result.semantic.data as AnyRecord;
        assert.ok(data !== null);
        assert.equal(data.completeness, "failed");
        assert.equal(data.counts.outputs, 0);
        assert.equal(result.artifacts.count, 0);
        assert.equal(result.artifacts.complete, false);
        const report = await readJson(data.reports.native);
        assert.equal(report.ok, false);
        assert.equal(typeof report.error, "string");
        assert.ok(String(report.error).length > 0);
        assert.deepEqual(report.outputs, []);
        assert.deepEqual(report.fileMap, {});
        assert.deepEqual(await listFilesIfExists(effective), []);
        assert.equal(await sha256File(csv), csvBefore);
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(
          await snapshotTree(fixture.sourceDirectory),
          sourceBefore,
        );
        assertNoUnexpectedNativeErrors(result.stderr.text);
      },
    );

    await t.test(
      "empty replacement text is valid for a confirmed existing key",
      async () => {
        const csv = await writeFixtureCsv(
          started,
          "empty",
          "key,en,zh\r\nA,New English,\r\n",
        );
        const effective = path.join(started.workspace, "patch", "empty");
        const { result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [{ csv, resource: fixture.importSource }],
          output: "patch/empty",
          locales: ["zh"],
        });
        assert.equal(
          result.success,
          true,
          JSON.stringify({ error: result.error, semantic: result.semantic }),
        );
        const data = result.semantic.data as AnyRecord;
        const report = await readJson(data.reports.native);
        const output = (report.outputs as AnyRecord[])[0]!;
        assert.equal(
          normalizePath(output.path),
          normalizePath(
            path.join(
              effective,
              fixture.translationMembers.zh.slice("res://".length),
            ),
          ),
        );
        const read = await readTranslationOutputs({
          fixture,
          workspace: path.join(started.root, "reader-operations", "empty"),
          outputs: [output.path],
        });
        assert.equal(read.outputs[0]!.locale, "zh");
        assert.equal(read.outputs[0]!.A, "");
        assert.equal(read.outputs[0]!.B, "保留");
        assert.deepEqual([...(read.outputs[0]!.messages.zh as string[])].sort(), [
          "",
          "保留",
        ].sort());
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(await snapshotTree(fixture.sourceDirectory), sourceBefore);
      },
    );

    await t.test(
      "all mappings are validated before a second unknown source fails",
      async () => {
        const validCsv = await writeFixtureCsv(
          started,
          "multi-valid",
          "key,en,zh\r\nA,New English,您\r\n",
        );
        const invalidCsv = await writeFixtureCsv(
          started,
          "multi-invalid",
          "key,en,zh\r\nA,New English,您\r\n",
        );
        const validBefore = await sha256File(validCsv);
        const invalidBefore = await sha256File(invalidCsv);
        const effective = path.join(started.workspace, "patch", "all-maps");
        const { wire, result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [
            { csv: validCsv, resource: fixture.importSource },
            { csv: invalidCsv, resource: "res://missing.csv" },
          ],
          output: "patch/all-maps",
          locales: ["zh"],
        });
        assert.equal(result.success, false);
        assert.equal(wire.isError, true);
        assert.equal(result.error?.code, "semantic_failed");
        const data = result.semantic.data as AnyRecord;
        assert.equal(data.completeness, "failed");
        assert.equal(data.counts.outputs, 0);
        assert.equal(result.artifacts.count, 0);
        const report = await readJson(data.reports.native);
        assert.equal(report.ok, false);
        assert.equal(report.stage, "validate");
        assert.equal(typeof report.error, "string");
        assert.deepEqual(report.outputs, []);
        assert.deepEqual(report.fileMap, {});
        assert.deepEqual(await listFilesIfExists(effective), []);
        assert.equal(await sha256File(validCsv), validBefore);
        assert.equal(await sha256File(invalidCsv), invalidBefore);
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(await snapshotTree(fixture.sourceDirectory), sourceBefore);
        assertNoUnexpectedNativeErrors(result.stderr.text);
      },
    );

    await t.test(
      "alternate safe suffix and binary project config are identified from report outputs",
      async () => {
        const variant = await fixtureAt(started, "variant", {
          destinations: { zh: "res://.godot/imported/zh-strings.res" },
          projectConfig: "binary",
        });
        const variantPckBefore = await sha256File(variant.packagePath);
        const variantSourceBefore = await snapshotTree(variant.sourceDirectory);
        const csv = await writeFixtureCsv(
          started,
          "variant",
          "key,en,zh\r\nA,New English,您好\r\n",
        );
        const effective = path.join(started.workspace, "patch", "variant");
        const { result } = await callPatch(started, {
          inputs: packageInput("variant"),
          translations: [{ csv, resource: variant.importSource }],
          output: "patch/variant",
          locales: ["zh"],
        });
        assert.equal(
          result.success,
          true,
          JSON.stringify({ error: result.error, semantic: result.semantic }),
        );
        const data = result.semantic.data as AnyRecord;
        const report = await readJson(data.reports.native);
        const output = (report.outputs as AnyRecord[])[0]!;
        assert.equal(output.member, "res://.godot/imported/zh-strings.res");
        assert.equal(
          normalizePath(output.path),
          normalizePath(
            path.join(
              effective,
              variant.translationMembers.zh.slice("res://".length),
            ),
          ),
        );
        assert.equal(report.projectConfig.member, "res://project.binary");
        assert.equal(
          normalizePath(report.projectConfig.path),
          normalizePath(path.join(effective, "project.binary")),
        );
        assert.equal(
          await sha256File(report.projectConfig.path),
          report.projectConfig.sha256,
        );
        assert.deepEqual(await listFiles(effective), [
          ".godot/imported/zh-strings.res",
          "project.binary",
        ]);
        const inventory = await readJson(result.paths.artifactInventory!);
        const roles = new Map(
          (inventory.entries as AnyRecord[]).map((entry) => [
            normalizePath(entry.path),
            entry.role,
          ]),
        );
        assert.equal(
          roles.get(normalizePath(output.path)),
          "translation-output",
          "non-.translation safe suffix is still a translation output",
        );
        assert.equal(
          roles.get(normalizePath(path.join(effective, "project.binary"))),
          "accompanying",
        );
        const read = await readTranslationOutputs({
          fixture: variant,
          workspace: path.join(started.root, "reader-operations", "variant"),
          outputs: [output.path],
        });
        assert.equal(read.outputs[0]!.class, "OptimizedTranslation");
        assert.equal(read.outputs[0]!.locale, "zh");
        assert.equal(read.outputs[0]!.A, "您好");
        assert.equal(read.outputs[0]!.B, "保留");
        assert.equal(await sha256File(variant.packagePath), variantPckBefore);
        assert.equal(
          await snapshotTree(variant.sourceDirectory),
          variantSourceBefore,
        );
        assertNoUnexpectedNativeErrors(result.stderr.text);
      },
    );

    await t.test(
      "encrypted PCK uses the supplied key without leaking it",
      async () => {
        const testKey = "0123456789abcdef".repeat(4);
        const wrongKey = "fedcba9876543210".repeat(4);
        const plaintext = await fixtureAt(started, "key-source");
        const staged = path.join(plaintext.root, "encrypted-source");
        await mkdir(path.join(staged, ".godot", "imported"), {
          recursive: true,
        });
        await writeFile(
          path.join(staged, "project.godot"),
          plaintext.projectText,
          "utf8",
        );
        await writeFile(
          path.join(staged, "translations.csv.import"),
          plaintext.importText,
          "utf8",
        );
        for (const locale of ["en", "zh"] as const) {
          const member = plaintext.translationMembers[locale];
          const target = path.join(
            staged,
            ...member.slice("res://".length).split("/"),
          );
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(
            target,
            await readFile(
              path.join(plaintext.sourceDirectory, `${locale}.translation`),
            ),
          );
        }
        const profile = await createFixtureProfile(
          path.join(started.root, "fixture-profiles"),
          "encrypted",
        );
        const encryptedPck = path.join(
          started.workspace,
          "fixtures",
          "encrypted",
          "fixture.pck",
        );
        await mkdir(path.dirname(encryptedPck), { recursive: true });
        await createPckFixture({
          runtimeExecutable: defaultTranslationRuntimeExecutable,
          sourceDirectory: staged,
          output: encryptedPck,
          format: 2,
          engineVersion: "4.4.0",
          key: testKey,
          cwd: profile.cwd,
          env: profile.env,
        });
        const encryptedBefore = await sha256File(encryptedPck);
        const csv = await writeFixtureCsv(
          started,
          "encrypted",
          "key,en,zh\r\nA,New English,您好\r\n",
        );

        const correct = await callPatch(started, {
          inputs: [{ kind: "path", path: "fixtures/encrypted/fixture.pck" }],
          translations: [{ csv, resource: plaintext.importSource }],
          output: "patch/encrypted",
          locales: ["zh"],
          key: testKey,
        });
        assert.equal(
          correct.result.success,
          true,
          JSON.stringify({
            error: correct.result.error,
            semantic: correct.result.semantic,
          }),
        );
        const data = correct.result.semantic.data as AnyRecord;
        const report = await readJson(data.reports.native);
        const output = (report.outputs as AnyRecord[])[0]!;
        const read = await readTranslationOutputs({
          fixture: plaintext,
          workspace: path.join(started.root, "reader-operations", "encrypted"),
          outputs: [output.path],
        });
        assert.equal(read.outputs[0]!.A, "您好");
        assert.equal(read.outputs[0]!.B, "保留");
        assert.equal(await sha256File(encryptedPck), encryptedBefore);

        const keyFreeTexts = [
          JSON.stringify(correct.result),
          JSON.stringify(correct.wire),
          await readFile(data.reports.request, "utf8"),
          await readFile(data.reports.native, "utf8"),
          await readFile(correct.result.paths.manifest!, "utf8"),
          await readFile(
            path.join(
              correct.result.paths.operation!,
              "translation-patch",
              "preparation.json",
            ),
            "utf8",
          ),
          await readFile(
            path.join(
              correct.result.paths.operation!,
              "translation-patch",
              "evidence.json",
            ),
            "utf8",
          ),
        ];
        for (const [index, text] of keyFreeTexts.entries()) {
          assert.equal(
            text.includes(testKey),
            false,
            `correct-key evidence ${String(index)} leaked the key`,
          );
        }

        const wrong = await callPatch(started, {
          inputs: [{ kind: "path", path: "fixtures/encrypted/fixture.pck" }],
          translations: [{ csv, resource: plaintext.importSource }],
          output: "patch/wrong-key",
          locales: ["zh"],
          key: wrongKey,
        });
        assert.equal(wrong.result.success, false);
        assert.equal(wrong.wire.isError, true);
        assert.notEqual(wrong.result.status, "succeeded");
        assert.notEqual(wrong.result.process.pid, null);
        assert.match(
          wrong.result.stderr.text,
          /encrypt|key|load|password/iu,
          wrong.result.stderr.text,
        );
        assert.equal(
          JSON.stringify(wrong.result).includes(wrongKey),
          false,
          "wrong-key evidence leaked the supplied key",
        );
        assert.equal(await sha256File(encryptedPck), encryptedBefore);
        assert.deepEqual(
          await listFilesIfExists(path.join(started.workspace, "patch", "wrong-key")),
          [],
        );
      },
    );

    await t.test(
      "a short explicit timeout stops the owned process and retains evidence",
      async () => {
        const csv = await writeFixtureCsv(
          started,
          "timeout",
          "key,en,zh\r\nA,New English,您好\r\n",
        );
        const csvBefore = await sha256File(csv);
        const effective = path.join(started.workspace, "patch", "timeout");
        const { result } = await callPatch(started, {
          inputs: packageInput("main"),
          translations: [{ csv, resource: fixture.importSource }],
          output: "patch/timeout",
          locales: ["zh"],
          timeoutMs: 1,
        });
        assert.equal(result.success, false);
        assert.equal(result.status, "timed_out");
        assert.equal(result.error?.code, "execution_timeout");
        assert.equal(result.semantic.status, "not_evaluated");
        assert.equal(result.artifacts.complete, false);
        if (result.process.pid !== null) {
          assert.equal(result.cleanup.trigger, "timeout");
          assert.equal(result.cleanup.state, "confirmed");
        } else {
          // The deadline can win before the owned spawn; do not claim an
          // after-spawn cancellation in that case.
          assert.equal(result.process.pid, null);
        }
        const requestPath = path.join(
          result.paths.operation!,
          "translation-patch",
          "request.json",
        );
        const request = await readJson(requestPath);
        await stat(String((request.translations as AnyRecord[])[0]!.csv));
        assert.deepEqual(await listFilesIfExists(effective), []);
        assert.equal(await sha256File(csv), csvBefore);
        assert.equal(await sha256File(fixture.packagePath), pckBefore);
        assert.equal(await snapshotTree(fixture.sourceDirectory), sourceBefore);
      },
    );
  } finally {
    await closeClient(started);
  }
});
