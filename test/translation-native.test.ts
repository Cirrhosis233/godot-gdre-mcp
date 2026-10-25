import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createStandaloneTranslationFixture,
  readTranslationOutputs,
  runPatchTransaction,
  sha256Bytes,
  sha256File,
  translationFixtureImportText,
  translationFixtureMember,
  translationFixtureSourceFile,
  translationFixtureValues,
  type PatchTransactionResult,
  type StandaloneTranslationFixture,
} from "./support/translation-fixtures.js";

const knownSyntheticDiagnostic = "OS_Windows::get_system_dir";

// Two case variants of the same 64-hex key; the native report must redact both.
const redactionKey = "a1A1".repeat(16);
const redactionKeyVariant = "A1a1".repeat(16);

const normalizePath = (value: string): string =>
  path.resolve(value).replaceAll("\\", "/").toLowerCase();

const assertPathWithin = (child: string, parent: string, label: string): void => {
  const normalizedChild = normalizePath(child);
  const normalizedParent = normalizePath(parent).replace(/\/+$/u, "");
  assert.ok(
    normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`),
    `${label} is outside the operation profile: ${child} not within ${parent}`,
  );
};

const assertNoUnexpectedNativeErrors = (stderrText: string): void => {
  const lines = stderrText.split(/\r?\n/u);
  const unexpected: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.includes("ERROR")) continue;
    // The synthetic-profile Windows diagnostic spans two lines and is the only
    // known expected native error.
    if (lines[index + 1]?.includes(knownSyntheticDiagnostic) === true) continue;
    if (line.includes(knownSyntheticDiagnostic)) continue;
    unexpected.push(line);
  }
  assert.deepEqual(unexpected, [], `unexpected native stderr:\n${stderrText}`);
};

async function listFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)).map((item) => `${entry.name}/${item}`));
    } else {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function snapshotTree(directory: string): Promise<string> {
  const lines: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
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

async function assertNoTemporaryTranslationDirectory(profileRoot: string): Promise<void> {
  const entries = await readdir(profileRoot, { recursive: true });
  assert.ok(
    !entries.some((entry) => String(entry).includes(".tmp_translations")),
    "native profile retained a .tmp_translations directory",
  );
}

const reportFileMap = (report: Record<string, any>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(report.fileMap as Record<string, unknown>).map(([key, value]) => [
      normalizePath(key),
      String(value),
    ]),
  );

const assertStructuredSuccess = (
  transaction: PatchTransactionResult,
  fixture: StandaloneTranslationFixture,
  expectedLocales: readonly string[],
  expectedMembers: readonly string[],
): void => {
  const { report } = transaction;
  assert.equal(report.version, 1);
  assert.equal(report.ok, true, `native patch failed: ${String(report.error)}`);
  assert.equal(report.stage, "complete");
  assert.equal(report.nativeCode, 0);
  assert.equal(report.error, null);
  assert.equal(normalizePath(report.output), normalizePath(transaction.output));
  assertPathWithin(report.userData, transaction.profileRoot, "native user data");
  assertPathWithin(report.temp, transaction.profileRoot, "native temporary directory");

  assert.equal(Array.isArray(report.mappings), true);
  assert.equal(report.mappings.length, 1);
  assert.equal(report.mappings[0].resource, fixture.importSource);
  assert.equal(report.mappings[0].csv, transaction.preparedCsvPath);
  assert.equal(report.mappings[0].defaultLocale, fixture.defaultLocale);
  assert.deepEqual(report.mappings[0].locales, [...expectedLocales]);

  const fileMap = reportFileMap(report);
  const projectRelative = fixture.projectConfigMember.slice("res://".length);
  const projectPath = normalizePath(path.join(transaction.output, projectRelative));
  for (const member of expectedMembers) {
    const expectedPath = normalizePath(
      path.join(transaction.output, member.slice("res://".length)),
    );
    assert.equal(fileMap[expectedPath], member, `fileMap member for ${member}`);
  }
  assert.equal(fileMap[projectPath], fixture.projectConfigMember);

  assert.equal(Array.isArray(report.outputs), true);
  assert.equal(report.outputs.length, expectedMembers.length);
  for (const [index, member] of expectedMembers.entries()) {
    const output = report.outputs[index] as Record<string, any>;
    const expectedPath = path.join(transaction.output, member.slice("res://".length));
    assert.equal(output.resource, fixture.importSource);
    assert.equal(output.member, member);
    assert.equal(normalizePath(output.path), normalizePath(expectedPath));
    assert.equal(output.locale, expectedLocales[index]);
    assert.equal(output.class, "OptimizedTranslation");
    assert.ok(output.bytes > 0, `output bytes for ${member}`);
    assert.match(output.sha256 as string, /^[0-9a-f]{64}$/u);
    assert.equal(output.verifiedTexts, 1);
    assert.equal(output.retainedContentVerified, true);
  }

  assert.notEqual(report.projectConfig, null);
  assert.equal(report.projectConfig.member, fixture.projectConfigMember);
  assert.equal(
    normalizePath(report.projectConfig.path),
    normalizePath(path.join(transaction.output, projectRelative)),
  );
  assert.match(report.projectConfig.sha256 as string, /^[0-9a-f]{64}$/u);
};

test("fixed native translation transaction patches, retains and rejects before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-translation-native-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = await createStandaloneTranslationFixture({
    root: path.join(root, "fixture"),
  });

  const originalGuard = (
    guardedFixture: StandaloneTranslationFixture,
    sourceSnapshot: string,
  ) => async (
    transaction: PatchTransactionResult,
    expectedCsvText: string,
  ): Promise<void> => {
    assert.equal(await sha256File(guardedFixture.packagePath), guardedFixture.packageSha256);
    assert.equal(
      await sha256File(transaction.preparedCsvPath),
      sha256Bytes(Buffer.from(expectedCsvText, "utf8")),
      "prepared CSV input must remain unchanged",
    );
    assert.equal(await snapshotTree(guardedFixture.sourceDirectory), sourceSnapshot);
  };

  const assertOriginalsUnchanged = originalGuard(
    fixture,
    await snapshotTree(fixture.sourceDirectory),
  );

  await t.test("explicit zh applies Unicode/comma/newline text from a CRLF quoted CSV and retains B", async () => {
    const csvText =
      "en,zh,key\r\n" +
      'New English,"您好, 世界\r\n第二行",A\r\n';
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "explicit"),
      name: "explicit",
      preparedCsvName: "explicit.csv",
      preparedCsvText: csvText,
      locales: ["zh"],
      session: [{ kind: "multithreading", disabled: true }],
      mappings: [
        {
          resource: fixture.importSource,
          columns: ["en", "zh", "key"],
          rows: [["New English", "您好, 世界\n第二行", "A"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assertStructuredSuccess(transaction, fixture, ["zh"], [translationFixtureMember("zh")]);

    const zhPath = path.join(
      transaction.output,
      translationFixtureMember("zh").slice("res://".length),
    );
    assert.deepEqual(await listFiles(transaction.output), [
      ".godot/imported/translations.zh.translation",
      "project.godot",
    ]);
    assert.equal(
      (await stat(zhPath)).size,
      (transaction.report.outputs[0] as Record<string, any>).bytes,
    );
    assert.equal(
      await sha256File(zhPath),
      (transaction.report.outputs[0] as Record<string, any>).sha256,
    );
    assert.equal(
      await sha256File(path.join(transaction.output, "project.godot")),
      transaction.report.projectConfig.sha256,
    );

    const read = await readTranslationOutputs({
      fixture,
      workspace: path.join(root, "reader-operations", "explicit"),
      outputs: [zhPath],
    });
    const output = read.outputs[0]!;
    assert.equal(output.class, "OptimizedTranslation");
    assert.equal(output.locale, "zh");
    assert.equal(output.A, "您好, 世界\n第二行");
    assert.equal(output.B, "保留");
    assert.deepEqual([...(output.messages.zh as string[])].sort(), [
      "您好, 世界\n第二行",
      "保留",
    ].sort());

    await assertNoTemporaryTranslationDirectory(transaction.profileRoot);
    await assertOriginalsUnchanged(transaction, csvText);
  });

  await t.test("omitted locales emit only the new fr column while retaining the default B", async () => {
    const csvText = "key,en,zh,fr\r\nA,New English,旧值,Bonjour\r\n";
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "omitted"),
      name: "omitted",
      preparedCsvName: "omitted.csv",
      preparedCsvText: csvText,
      locales: [],
      mappings: [
        {
          resource: fixture.importSource,
          columns: ["key", "en", "zh", "fr"],
          rows: [["A", "New English", "旧值", "Bonjour"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assertStructuredSuccess(transaction, fixture, ["fr"], [translationFixtureMember("fr")]);

    const frPath = path.join(
      transaction.output,
      translationFixtureMember("fr").slice("res://".length),
    );
    assert.deepEqual(await listFiles(transaction.output), [
      ".godot/imported/translations.fr.translation",
      "project.godot",
    ]);
    const read = await readTranslationOutputs({
      fixture,
      workspace: path.join(root, "reader-operations", "omitted"),
      outputs: [frPath],
    });
    const output = read.outputs[0]!;
    assert.equal(output.locale, "fr");
    assert.equal(output.A, "Bonjour");
    assert.equal(output.B, translationFixtureValues.en.B);
    assert.deepEqual([...(output.messages.fr as string[])].sort(), ["Bonjour", "keep"].sort());

    await assertNoTemporaryTranslationDirectory(transaction.profileRoot);
    await assertOriginalsUnchanged(transaction, csvText);
  });

  await t.test("empty replacement text is retained for a confirmed source key and B is untouched", async () => {
    const csvText = "key,en,zh\r\nA,New English,\r\n";
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "empty"),
      name: "empty",
      preparedCsvName: "empty.csv",
      preparedCsvText: csvText,
      locales: ["zh"],
      mappings: [
        {
          resource: fixture.importSource,
          columns: ["key", "en", "zh"],
          rows: [["A", "New English", ""]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assertStructuredSuccess(transaction, fixture, ["zh"], [translationFixtureMember("zh")]);

    const zhPath = path.join(
      transaction.output,
      translationFixtureMember("zh").slice("res://".length),
    );
    const read = await readTranslationOutputs({
      fixture,
      workspace: path.join(root, "reader-operations", "empty"),
      outputs: [zhPath],
    });
    const output = read.outputs[0]!;
    assert.equal(output.locale, "zh");
    assert.equal(output.A, "");
    assert.equal(output.B, "保留");
    assert.deepEqual([...(output.messages.zh as string[])].sort(), ["", "保留"].sort());
    await assertOriginalsUnchanged(transaction, csvText);
  });

  await t.test("unknown and unsafe mappings are rejected before any native patch writes", async () => {
    for (const [index, resource] of [
      "res://missing.csv",
      "res://../escape.csv",
    ].entries()) {
      const preparedCsvText = "key,en,zh\r\nA,New English,您\r\n";
      const transaction = await runPatchTransaction({
        fixture,
        workspace: path.join(root, "operations", "invalid", String(index)),
        name: "invalid",
        preparedCsvName: "invalid.csv",
        preparedCsvText,
        locales: ["zh"],
        mappings: [
          {
            resource,
            columns: ["key", "en", "zh"],
            rows: [["A", "New English", "您"]],
          },
        ],
      });
      assertNoUnexpectedNativeErrors(transaction.result.stderrText);
      assert.equal(transaction.report.version, 1);
      assert.equal(transaction.report.ok, false);
      assert.equal(typeof transaction.report.error, "string");
      assert.ok((transaction.report.error as string).length > 0);
      assert.equal(transaction.report.stage, resource.includes("..") ? "request" : "validate");
      assert.deepEqual(transaction.report.outputs, []);
      assert.deepEqual(transaction.report.fileMap, {});
      assert.deepEqual(await listFiles(transaction.output), []);
      await assertOriginalsUnchanged(transaction, preparedCsvText);
    }
  });

  await t.test("new-locale output follows the native default resource path, not dest order", async () => {
    const variant = await createStandaloneTranslationFixture({
      root: path.join(root, "fixtures", "default-not-first"),
      destinations: { zh: "res://localized/zh-strings.zh.translation" },
      destinationOrder: ["zh", "en"],
    });
    const guard = originalGuard(variant, await snapshotTree(variant.sourceDirectory));
    const csvText = "key,en,zh,fr\r\nA,New English,旧值,Bonjour\r\n";
    const transaction = await runPatchTransaction({
      fixture: variant,
      workspace: path.join(root, "operations", "default-not-first"),
      name: "default-not-first",
      preparedCsvName: "edited.csv",
      preparedCsvText: csvText,
      locales: [],
      mappings: [
        {
          resource: variant.importSource,
          columns: ["key", "en", "zh", "fr"],
          rows: [["A", "New English", "旧值", "Bonjour"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assert.equal(transaction.report.mappings[0].defaultLocale, "en");
    assertStructuredSuccess(transaction, variant, ["fr"], [translationFixtureMember("fr")]);
    const frPath = path.join(
      transaction.output,
      translationFixtureMember("fr").slice("res://".length),
    );
    assert.deepEqual(await listFiles(transaction.output), [
      ".godot/imported/translations.fr.translation",
      "project.godot",
    ]);
    const read = await readTranslationOutputs({
      fixture: variant,
      workspace: path.join(root, "reader-operations", "default-not-first"),
      outputs: [frPath],
    });
    assert.equal(read.outputs[0]!.A, "Bonjour");
    assert.equal(read.outputs[0]!.B, "keep");
    await guard(transaction, csvText);
  });

  await t.test("existing non-.translation destinations are verified as translation outputs", async () => {
    const variant = await createStandaloneTranslationFixture({
      root: path.join(root, "fixtures", "alternate-extension"),
      destinations: { zh: "res://localized/zh-strings.res" },
    });
    const guard = originalGuard(variant, await snapshotTree(variant.sourceDirectory));
    const csvText = "key,en,zh\r\nA,New English,您好\r\n";
    const transaction = await runPatchTransaction({
      fixture: variant,
      workspace: path.join(root, "operations", "alternate-extension"),
      name: "alternate-extension",
      preparedCsvName: "edited.csv",
      preparedCsvText: csvText,
      locales: ["zh"],
      mappings: [
        {
          resource: variant.importSource,
          columns: ["key", "en", "zh"],
          rows: [["A", "New English", "您好"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assertStructuredSuccess(transaction, variant, ["zh"], [variant.translationMembers.zh]);
    const zhPath = path.join(
      transaction.output,
      variant.translationMembers.zh.slice("res://".length),
    );
    assert.deepEqual(await listFiles(transaction.output), ["localized/zh-strings.res", "project.godot"]);
    assert.equal((transaction.report.outputs[0] as Record<string, any>).member, variant.translationMembers.zh);
    const read = await readTranslationOutputs({
      fixture: variant,
      workspace: path.join(root, "reader-operations", "alternate-extension"),
      outputs: [zhPath],
    });
    assert.equal(read.outputs[0]!.locale, "zh");
    assert.equal(read.outputs[0]!.A, "您好");
    assert.equal(read.outputs[0]!.B, "保留");
    await guard(transaction, csvText);
  });

  await t.test("binary project configuration is prevalidated and reported at its native path", async () => {
    const variant = await createStandaloneTranslationFixture({
      root: path.join(root, "fixtures", "binary-config"),
      projectConfig: "binary",
    });
    assert.equal(variant.projectConfigMember, "res://project.binary");
    const guard = originalGuard(variant, await snapshotTree(variant.sourceDirectory));
    const csvText = "key,en,zh\r\nA,New English,您好\r\n";
    const transaction = await runPatchTransaction({
      fixture: variant,
      workspace: path.join(root, "operations", "binary-config"),
      name: "binary-config",
      preparedCsvName: "edited.csv",
      preparedCsvText: csvText,
      locales: ["zh"],
      mappings: [
        {
          resource: variant.importSource,
          columns: ["key", "en", "zh"],
          rows: [["A", "New English", "您好"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assertStructuredSuccess(transaction, variant, ["zh"], [translationFixtureMember("zh")]);
    assert.equal(transaction.report.projectConfig.member, "res://project.binary");
    assert.deepEqual(await listFiles(transaction.output), [
      ".godot/imported/translations.zh.translation",
      "project.binary",
    ]);
    assert.equal(
      await sha256File(path.join(transaction.output, "project.binary")),
      transaction.report.projectConfig.sha256,
    );
    await guard(transaction, csvText);
  });

  await t.test("a locale spelling canonicalized by native translation state is rejected before writes", async () => {
    const csvText = "key,en,zh,pt-BR\r\nA,New English,旧值,Olá\r\n";
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "locale-canonical"),
      name: "locale-canonical",
      preparedCsvName: "edited.csv",
      preparedCsvText: csvText,
      locales: [],
      mappings: [
        {
          resource: fixture.importSource,
          columns: ["key", "en", "zh", "pt-BR"],
          rows: [["A", "New English", "旧值", "Olá"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assert.equal(transaction.report.ok, false);
    assert.equal(transaction.report.stage, "validate");
    assert.match(String(transaction.report.error), /canonical/iu);
    assert.deepEqual(transaction.report.outputs, []);
    assert.deepEqual(transaction.report.fileMap, {});
    assert.deepEqual(await listFiles(transaction.output), []);
    await assertOriginalsUnchanged(transaction, csvText);
  });

  await t.test("unsafe Windows destination metadata is rejected before any output write", async () => {
    const unsafeDestinations = [
      // Reserved device name, including an extension form.
      "res://.godot/imported/CON.translation",
      // Forbidden Windows filename characters.
      "res://.godot/imported/bad<name>/strings.translation",
      // Colon is invalid in a Windows member segment.
      "res://.godot/imported/bad:name/strings.translation",
      // Trailing space and trailing dot segments.
      "res://.godot/imported/trailing /trailing./strings.translation",
      // DEL in a member segment.
      "res://.godot/imported/bad\u007fname/strings.translation",
    ];
    for (const [index, unsafeDestination] of unsafeDestinations.entries()) {
      const variant = await createStandaloneTranslationFixture({
        root: path.join(root, "fixtures", `unsafe-destination-${String(index)}`),
        destinations: { zh: unsafeDestination },
      });
      const guard = originalGuard(variant, await snapshotTree(variant.sourceDirectory));
      const csvText = "key,en,zh\r\nA,New English,您好\r\n";
      const transaction = await runPatchTransaction({
        fixture: variant,
        workspace: path.join(root, "operations", `unsafe-destination-${String(index)}`),
        name: "unsafe-destination",
        preparedCsvName: "edited.csv",
        preparedCsvText: csvText,
        locales: ["zh"],
        mappings: [
          {
            resource: variant.importSource,
            columns: ["key", "en", "zh"],
            rows: [["A", "New English", "您好"]],
          },
        ],
      });
      assertNoUnexpectedNativeErrors(transaction.result.stderrText);
      assert.equal(transaction.report.ok, false, `unsafe destination rejected: ${unsafeDestination}`);
      assert.equal(transaction.report.stage, "validate");
      assert.match(String(transaction.report.error), /safe logical path/iu);
      assert.deepEqual(transaction.report.outputs, []);
      assert.deepEqual(transaction.report.fileMap, {});
      assert.deepEqual(await listFiles(transaction.output), []);
      await guard(transaction, csvText);
    }
  });

  await t.test("a mixed-case key spelling in a diagnostic string is redacted", async () => {
    const csvText = "key,en,zh\r\nA,New English,您\r\n";
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "redact-string"),
      name: "redact-string",
      preparedCsvName: "redact-string.csv",
      preparedCsvText: csvText,
      key: redactionKey,
      locales: ["zh"],
      mappings: [
        {
          resource: `res://${redactionKeyVariant}.csv`,
          columns: ["key", "en", "zh"],
          rows: [["A", "New English", "您"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assert.equal(transaction.report.ok, false);
    assert.equal(transaction.report.stage, "validate");
    assert.match(String(transaction.report.error), /no unique native import metadata/u);
    assert.doesNotMatch(
      JSON.stringify(transaction.report),
      new RegExp(redactionKey, "iu"),
      "report retained a mixed-case spelling of the supplied key",
    );
    assert.match(String(transaction.report.error), /\[redacted\]/u);
  });

  await t.test("a mixed-case key spelling in report dictionary keys is redacted", async () => {
    const csvText = "key,en,zh\r\nA,New English,您好\r\n";
    const transaction = await runPatchTransaction({
      fixture,
      workspace: path.join(root, "operations", "redact-keys"),
      name: "redact-keys",
      preparedCsvName: "redact-keys.csv",
      preparedCsvText: csvText,
      key: redactionKey,
      output: path.join(root, "redacted-output", redactionKeyVariant),
      locales: ["zh"],
      mappings: [
        {
          resource: fixture.importSource,
          columns: ["key", "en", "zh"],
          rows: [["A", "New English", "您好"]],
        },
      ],
    });
    assertNoUnexpectedNativeErrors(transaction.result.stderrText);
    assert.equal(
      transaction.report.ok,
      true,
      `native patch failed: ${String(transaction.report.error)}`,
    );
    assert.equal(transaction.report.stage, "complete");
    assert.doesNotMatch(
      JSON.stringify(transaction.report),
      new RegExp(redactionKey, "iu"),
      "report retained a mixed-case spelling of the supplied key",
    );
    const fileMapKeys = Object.keys(transaction.report.fileMap as Record<string, unknown>);
    assert.ok(
      fileMapKeys.some((key) => String(key).includes("[redacted]")),
      `no report.fileMap key was redacted: ${JSON.stringify(fileMapKeys)}`,
    );
  });

  // The import metadata text itself is a fixed fixture literal; assert it is
  // what the fixture expects without deriving anything from native output.
  assert.match(translationFixtureImportText, /importer="csv_translation"/u);
  assert.match(translationFixtureImportText, /source_file="res:\/\/translations\.csv"/u);
  assert.equal(fixture.importSource, translationFixtureSourceFile);
});
