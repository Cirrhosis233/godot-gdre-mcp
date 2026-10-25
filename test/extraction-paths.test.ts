import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ListingDirectoryInspector } from "../src/listing-paths.js";
import { prepareListingInputs } from "../src/listing-paths.js";
import { joinPath, pathIdentity } from "../src/paths.js";
import {
  admittedPrimaryInputs,
  type OutputPlacementKind,
} from "../src/output-placement.js";
import {
  mapExtractionMembers,
  prepareExtractionDestination,
  revalidateExtractionDestination,
  ExtractionPathError,
} from "../src/extraction-paths.js";

const benignInspector: ListingDirectoryInspector = {
  async inspect(directories) {
    return new Map(directories.map((directory) => [directory, { caseSensitive: false, reparsePoint: false }]));
  },
};

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly operation: string;
  readonly input: string;
  readonly preparedInputs: Awaited<ReturnType<typeof prepareListingInputs>>;
}

const fixture = async (label: string): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `gdre-mcp-extract-paths-${label}-`));
  const workspace = path.join(root, "workspace");
  const operation = path.join(workspace, ".gdre", "operations", "op");
  const input = path.join(root, "fixtures", "pack.pck");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(input), { recursive: true });
  await mkdir(operation, { recursive: true });
  await writeFile(input, "pack", "utf8");
  const preparedInputs = await prepareListingInputs(
    workspace,
    { inputs: [{ kind: "path", path: input }] },
    undefined,
    undefined,
    { directoryInspector: benignInspector },
  );
  return { root, workspace, operation, input, preparedInputs };
};

const cleanup = async (value: Fixture): Promise<void> => {
  await rm(value.root, { recursive: true, force: true });
};

const placement = (
  preparedInputs: Fixture["preparedInputs"],
  kind: Exclude<OutputPlacementKind, "patched"> = "extracted",
) => ({
  kind,
  primaryInputs: admittedPrimaryInputs(preparedInputs),
});

test("member mapping returns expected absolute paths without touching the filesystem", () => {
  const effectiveOutput = joinPath(os.tmpdir(), "gdre-mcp-extract-map", "out 空间");
  const mapping = mapExtractionMembers({
    effectiveOutput,
    members: ["res://hello 空间/文件.txt", "res://project.godot"],
  });
  assert.deepEqual(mapping.members, [
    {
      member: "res://hello 空间/文件.txt",
      relative: "hello 空间/文件.txt",
      path: joinPath(effectiveOutput, "hello 空间", "文件.txt"),
    },
    {
      member: "res://project.godot",
      relative: "project.godot",
      path: joinPath(effectiveOutput, "project.godot"),
    },
  ]);
  assert.deepEqual(mapping.expectedPaths, mapping.members.map((entry) => entry.path));
});

test("member mapping rejects unsafe or ambiguous Windows names before writing", () => {
  const effectiveOutput = joinPath(os.tmpdir(), "gdre-mcp-extract-map", "out");
  for (const member of [
    "res://",
    "user://file.txt",
    "res:///absolute",
    "res://../escape",
    "res://a/../b",
    "res://a/./b",
    "res://a//b",
    "res://a\\b",
    "res://C:/x",
    "res://C:relative",
    "res://a:b",
    "res://CON",
    "res://folder/CON.txt",
    "res://folder/aux",
    "res://COM¹",
    "res://folder/com².txt",
    "res://folder/LPT³/data.bin",
    "res://trailing./x",
    "res://trailing /x",
    "res://a?b",
    "res://a*b",
    "res://a<b",
    "res://a>b",
    "res://a|b",
    'res://a"b',
    "res://a\tb",
  ]) {
    assert.throws(
      () => mapExtractionMembers({ effectiveOutput, members: [member] }),
      ExtractionPathError,
      member,
    );
  }
});

test("member mapping rejects case-insensitive and file-versus-directory collisions", () => {
  const effectiveOutput = joinPath(os.tmpdir(), "gdre-mcp-extract-map", "out");
  for (const members of [
    ["res://Foo.txt", "res://foo.TXT"],
    ["res://Dir/One.txt", "res://dir/one.txt"],
    ["res://file", "res://file/child"],
    ["res://Dir", "res://dir/Child"],
    ["res://same.txt", "res://same.txt"],
  ]) {
    assert.throws(
      () => mapExtractionMembers({ effectiveOutput, members }),
      ExtractionPathError,
      members.join(", "),
    );
  }
});

test("member mapping rejects the runtime root log and its parent directory", () => {
  const effectiveOutput = joinPath(os.tmpdir(), "gdre-mcp-extract-map", "out");
  for (const member of [
    "res://gdre_export.log",
    "res://GDRE_EXPORT.LOG",
    "res://gdre_export.log/nested.txt",
  ]) {
    assert.throws(
      () => mapExtractionMembers({ effectiveOutput, members: [member] }),
      /gdre_export\.log/u,
      member,
    );
  }
  const accepted = mapExtractionMembers({
    effectiveOutput,
    members: ["res://gdre_export.log.txt", "res://gdre_export", "res://project.godot"],
  });
  assert.equal(accepted.expectedPaths.length, 3);
});

test("member mapping checks cancellation and deadline during its loops", () => {
  const effectiveOutput = joinPath(os.tmpdir(), "gdre-mcp-extract-map", "out");
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => mapExtractionMembers({
      effectiveOutput,
      members: ["res://project.godot"],
      signal: controller.signal,
    }),
    /cancelled/u,
  );
  assert.throws(
    () => mapExtractionMembers({
      effectiveOutput,
      members: ["res://project.godot"],
      deadlineMono: -1,
    }),
    /deadline/u,
  );
});

test("ancestor classification failures reject the destination through the injected inspector boundary", async () => {
  const value = await fixture("inspector");
  try {
    const makeInspector = (
      classification: (directory: string) => { readonly caseSensitive: boolean; readonly reparsePoint: boolean },
      omit = false,
    ): ListingDirectoryInspector => ({
      async inspect(directories) {
        if (omit) return new Map();
        return new Map(directories.map((directory) => [directory, classification(directory)]));
      },
    });
    const base = {
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: joinPath(value.root, "target"),
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
    } as const;

    await assert.rejects(
      prepareExtractionDestination({
        ...base,
        directoryInspector: makeInspector(() => ({ caseSensitive: true, reparsePoint: false })),
      }),
      /case-sensitive/u,
    );
    await assert.rejects(
      prepareExtractionDestination({
        ...base,
        directoryInspector: makeInspector(() => ({ caseSensitive: false, reparsePoint: true })),
      }),
      /reparse/u,
    );
    await assert.rejects(
      prepareExtractionDestination({
        ...base,
        directoryInspector: makeInspector(() => ({ caseSensitive: false, reparsePoint: false }), true),
      }),
      /omitted/u,
    );
    await assert.rejects(
      prepareExtractionDestination({
        ...base,
        directoryInspector: {
          async inspect() {
            throw new Error("attribute boundary failed");
          },
        },
      }),
      (error: unknown) => error instanceof ExtractionPathError,
    );
  } finally {
    await cleanup(value);
  }
});

test("preparation and revalidation reject replaced aliases, ancestors, files, and nonempty targets", async () => {
  const value = await fixture("revalidate");
  try {
    const first = joinPath(value.root, "first-empty");
    const second = joinPath(value.root, "second-empty");
    const alias = joinPath(value.root, "alias");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await symlink(first, alias, "junction");

    const aliasPreparation = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: alias,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(aliasPreparation.effectiveOutput, alias);
    assert.equal(aliasPreparation.effectiveIdentity, pathIdentity(first));
    assert.equal(aliasPreparation.targetState, "empty");
    assert.equal(aliasPreparation.ancestors.length > 0, true);

    await revalidateExtractionDestination(aliasPreparation, { directoryInspector: benignInspector });
    await rm(alias, { recursive: true, force: true });
    await symlink(second, alias, "junction");
    await assert.rejects(
      revalidateExtractionDestination(aliasPreparation, { directoryInspector: benignInspector }),
      /identity changed/u,
    );

    const removedParent = joinPath(value.root, "removed", "parent");
    await mkdir(removedParent, { recursive: true });
    const removedPreparation = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: joinPath(removedParent, "out"),
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    await rm(removedParent, { recursive: true, force: true });
    await assert.rejects(
      revalidateExtractionDestination(removedPreparation, { directoryInspector: benignInspector }),
      /no longer exists/u,
    );

    const replacedRoot = joinPath(value.root, "replaced");
    const replacedParent = joinPath(replacedRoot, "parent");
    const replacedOld = joinPath(replacedRoot, "parent-old");
    await mkdir(replacedParent, { recursive: true });
    const replacedPreparation = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: joinPath(replacedParent, "out"),
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    await rename(replacedParent, replacedOld);
    await mkdir(replacedParent, { recursive: true });
    await assert.rejects(
      revalidateExtractionDestination(replacedPreparation, { directoryInspector: benignInspector }),
      /object identity changed/u,
    );

    const segmentBase = joinPath(value.root, "segments", "base");
    await mkdir(segmentBase, { recursive: true });
    const segmentPreparation = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: joinPath(segmentBase, "new", "out"),
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    await mkdir(joinPath(segmentBase, "new", "out"), { recursive: true });
    const segmentRevalidated = await revalidateExtractionDestination(
      segmentPreparation,
      { directoryInspector: benignInspector },
    );
    assert.equal(segmentRevalidated.targetState, "empty");

    const chain = joinPath(value.root, "chain");
    const parent = joinPath(chain, "parent");
    const target = joinPath(parent, "out");
    const moved = joinPath(chain, "parent-moved");
    const other = joinPath(chain, "other");
    await mkdir(parent, { recursive: true });
    await mkdir(other, { recursive: true });
    const absentPreparation = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: target,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(absentPreparation.targetState, "absent");
    const redirect = joinPath(value.root, "redirect-empty");
    await mkdir(redirect, { recursive: true });
    await symlink(redirect, target, "junction");
    await assert.rejects(
      revalidateExtractionDestination(absentPreparation, { directoryInspector: benignInspector }),
      /identity changed/u,
    );
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const created = await revalidateExtractionDestination(absentPreparation, { directoryInspector: benignInspector });
    assert.equal(created.targetState, "empty");
    await writeFile(joinPath(target, "occupied.txt"), "x", "utf8");
    await assert.rejects(
      revalidateExtractionDestination(created, { directoryInspector: benignInspector }),
      /not empty/u,
    );
    await rm(target, { recursive: true, force: true });
    await writeFile(target, "file", "utf8");
    await assert.rejects(
      revalidateExtractionDestination(created, { directoryInspector: benignInspector }),
      /not a directory/u,
    );
    await rm(target, { force: true });
    await rename(parent, moved);
    await symlink(other, parent, "junction");
    await assert.rejects(
      revalidateExtractionDestination(absentPreparation, { directoryInspector: benignInspector }),
      /identity changed/u,
    );
  } finally {
    await cleanup(value);
  }
});

test("revalidation repeats ancestor classification before launch", async () => {
  const value = await fixture("revalidate-inspector");
  try {
    let reparse = false;
    const inspector: ListingDirectoryInspector = {
      async inspect(directories) {
        return new Map(directories.map((directory) => [
          directory,
          { caseSensitive: false, reparsePoint: reparse && directory === value.root },
        ]));
      },
    };
    const prepared = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: joinPath(value.root, "target"),
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: inspector,
    });
    reparse = true;
    await assert.rejects(
      revalidateExtractionDestination(prepared, { directoryInspector: inspector }),
      /reparse/u,
    );
  } finally {
    await cleanup(value);
  }
});

test("destination rejects operation administrative metadata except the exact owned output", async () => {
  const value = await fixture("metadata");
  try {
    const metadata = joinPath(value.workspace, ".gdre");
    for (const output of [
      metadata,
      joinPath(metadata, "operations"),
      joinPath(metadata, "operations", "other", "output"),
    ]) {
      await assert.rejects(
        prepareExtractionDestination({
          workspace: value.workspace,
          operationDirectory: value.operation,
          requestedOutput: output,
          preparedInputs: value.preparedInputs,
          defaultPlacement: placement(value.preparedInputs),
          directoryInspector: benignInspector,
        }),
        /metadata/u,
      );
    }

    const owned = joinPath(value.operation, "output");
    const explicitOwned = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: owned,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(explicitOwned.effectiveIdentity, explicitOwned.ownedIdentity);

    const relativeOwned = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: ".gdre/operations/op/output",
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(relativeOwned.effectiveIdentity, relativeOwned.ownedIdentity);
  } finally {
    await cleanup(value);
  }
});

test("destination rejects input, dependency, directory, and canonical alias overlap", async () => {
  const value = await fixture("overlap");
  try {
    const prepareFor = async (input: string): Promise<Awaited<ReturnType<typeof prepareListingInputs>>> =>
      prepareListingInputs(
        value.workspace,
        { inputs: [{ kind: "path", path: input }] },
        undefined,
        undefined,
        { directoryInspector: benignInspector },
      );

    for (const [label, output] of [
      ["input file", value.input],
      ["input parent", path.dirname(value.input)],
    ] as const) {
      await assert.rejects(
        prepareExtractionDestination({
          workspace: value.workspace,
          operationDirectory: value.operation,
          requestedOutput: output,
          preparedInputs: value.preparedInputs,
          defaultPlacement: placement(value.preparedInputs),
          directoryInspector: benignInspector,
        }),
        ExtractionPathError,
        label,
      );
    }

    const source = path.join(value.root, "source");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "inside.pck"), "inside", "utf8");
    const directoryInputs = await prepareFor(source);
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: path.join(source, "nested", "out"),
        preparedInputs: directoryInputs,
        defaultPlacement: placement(directoryInputs),
        directoryInspector: benignInspector,
      }),
      /overlaps an extraction input/u,
    );
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: path.dirname(source),
        preparedInputs: directoryInputs,
        defaultPlacement: placement(directoryInputs),
        directoryInspector: benignInspector,
      }),
      /overlaps an extraction input/u,
    );

    const alias = path.join(value.root, "source-alias");
    await symlink(source, alias, "junction");
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: path.join(alias, "nested", "out"),
        preparedInputs: directoryInputs,
        defaultPlacement: placement(directoryInputs),
        directoryInspector: benignInspector,
      }),
      /overlaps an extraction input/u,
    );

    const executable = path.join(value.root, "fixtures", "game.exe");
    await writeFile(executable, "exe", "utf8");
    await writeFile(joinPath(path.dirname(executable), "game.pck"), "pck", "utf8");
    const dependencyInputs = await prepareFor(executable);
    assert.equal(dependencyInputs.fingerprints.some((fingerprint) => fingerprint.role === "dependency"), true);
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: joinPath(path.dirname(executable), "game.pck"),
        preparedInputs: dependencyInputs,
        defaultPlacement: placement(dependencyInputs),
        directoryInspector: benignInspector,
      }),
      /overlaps an extraction input/u,
    );
  } finally {
    await cleanup(value);
  }
});

test("existing destinations must be empty directories", async () => {
  const value = await fixture("target-state");
  try {
    const empty = joinPath(value.root, "empty-target");
    await mkdir(empty, { recursive: true });
    const prepared = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: empty,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(prepared.targetState, "empty");
    assert.equal(prepared.effectiveIdentity, pathIdentity(empty));

    const file = joinPath(value.root, "target-file");
    await writeFile(file, "not a directory", "utf8");
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: file,
        preparedInputs: value.preparedInputs,
        defaultPlacement: placement(value.preparedInputs),
        directoryInspector: benignInspector,
      }),
      (error: unknown) => error instanceof ExtractionPathError && error.code === "path_unsupported",
    );

    const nonempty = joinPath(value.root, "nonempty-target");
    await mkdir(nonempty, { recursive: true });
    await writeFile(joinPath(nonempty, "existing.txt"), "x", "utf8");
    await assert.rejects(
      prepareExtractionDestination({
        workspace: value.workspace,
        operationDirectory: value.operation,
        requestedOutput: nonempty,
        preparedInputs: value.preparedInputs,
        defaultPlacement: placement(value.preparedInputs),
        directoryInspector: benignInspector,
      }),
      /not empty/u,
    );
  } finally {
    await cleanup(value);
  }
});

test("explicit relative and absolute destinations keep owned and effective paths distinct", async () => {
  const value = await fixture("explicit");
  try {
    const relative = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: "exports/out 空间",
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(relative.effectiveOutput, joinPath(value.workspace, "exports", "out 空间"));
    assert.equal(relative.ownedOutput, joinPath(value.operation, "output"));
    assert.notEqual(relative.effectiveIdentity, relative.ownedIdentity);
    assert.equal(relative.targetState, "absent");

    const absolutePath = joinPath(value.root, "absolute", "out 空间");
    const absolute = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: absolutePath,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(absolute.effectiveOutput, absolutePath);
    assert.equal(absolute.effectiveIdentity, pathIdentity(absolutePath));
    assert.equal(absolute.ownedOutput, joinPath(value.operation, "output"));

    const customOwned = joinPath(value.root, "custom-owned");
    const custom = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      ownedOutput: customOwned,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(custom.ownedOutput, customOwned);
    assert.equal(
      custom.effectiveOutput,
      joinPath(
        path.dirname(value.input),
        `pack-extracted-${path.basename(value.operation)}`,
      ),
      "an owned-output override never becomes the omitted-output product",
    );
    assert.notEqual(custom.effectiveIdentity, custom.ownedIdentity);

    await assert.rejects(stat(relative.effectiveOutput), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(stat(absolute.effectiveOutput), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    const forwardAbsolute = `${value.root.replaceAll("\\", "/")}/forward/out`;
    const forward = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: forwardAbsolute,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });
    assert.equal(forward.effectiveIdentity, pathIdentity(forwardAbsolute));

    for (const invalid of [
      "/target",
      "\\target",
      "//target",
      "C:target",
      "\\\\server\\share\\out",
      "\\\\.\\pipe\\x",
    ]) {
      await assert.rejects(
        prepareExtractionDestination({
          workspace: value.workspace,
          operationDirectory: value.operation,
          requestedOutput: invalid,
          preparedInputs: value.preparedInputs,
          defaultPlacement: placement(value.preparedInputs),
          directoryInspector: benignInspector,
        }),
        ExtractionPathError,
        invalid,
      );
    }
  } finally {
    await cleanup(value);
  }
});

test("omitted output never falls back to the internal owned output", async () => {
  const value = await fixture("owned-absent");
  try {
    const owned = joinPath(value.operation, "output");
    const prepared = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      preparedInputs: value.preparedInputs,
      defaultPlacement: placement(value.preparedInputs),
      directoryInspector: benignInspector,
    });

    assert.equal(prepared.ownedOutput, owned);
    assert.equal(
      prepared.effectiveOutput,
      joinPath(
        path.dirname(value.input),
        `pack-extracted-${path.basename(value.operation)}`,
      ),
    );
    assert.notEqual(prepared.effectiveIdentity, prepared.ownedIdentity);
    assert.equal(prepared.targetState, "absent");
    await assert.rejects(stat(owned), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await cleanup(value);
  }
});

test("omitted output proposes a distinct sibling product from admitted primaries", async () => {
  const value = await fixture("sibling-default");
  try {
    const primary = value.preparedInputs.fingerprints[0]!;
    const prepared = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      preparedInputs: value.preparedInputs,
      defaultPlacement: {
        kind: "extracted",
        primaryInputs: [{ realPath: primary.realPath, kind: primary.kind }],
      },
      directoryInspector: benignInspector,
    });
    const expected = joinPath(
      path.dirname(primary.realPath),
      `pack-extracted-${path.basename(value.operation)}`,
    );

    assert.equal(prepared.effectiveOutput, expected);
    assert.equal(prepared.effectiveIdentity, pathIdentity(expected));
    assert.notEqual(prepared.effectiveIdentity, prepared.ownedIdentity);
    assert.equal(prepared.ownedOutput, joinPath(value.operation, "output"));
    assert.equal(prepared.targetState, "absent");
    await assert.rejects(stat(expected), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await cleanup(value);
  }
});

test("a directory primary default is a sibling and never inside the input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-extract-paths-dir-"));
  const workspace = path.join(root, "workspace");
  const operation = path.join(workspace, ".gdre", "operations", "dir-op");
  const input = path.join(root, "project.bundle");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(operation, { recursive: true });
    await mkdir(input, { recursive: true });
    await writeFile(path.join(input, "project.godot"), "config", "utf8");
    const preparedInputs = await prepareListingInputs(
      workspace,
      { inputs: [{ kind: "path", path: input }] },
      undefined,
      undefined,
      { directoryInspector: benignInspector },
    );
    const primary = preparedInputs.fingerprints[0]!;
    const prepared = await prepareExtractionDestination({
      workspace,
      operationDirectory: operation,
      preparedInputs,
      defaultPlacement: {
        kind: "extracted",
        primaryInputs: [{ realPath: primary.realPath, kind: primary.kind }],
      },
      directoryInspector: benignInspector,
    });
    assert.equal(
      prepared.effectiveOutput,
      joinPath(root, "project.bundle-extracted-dir-op"),
    );
    assert.notEqual(path.dirname(prepared.effectiveOutput), input);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit output stays exact when placement facts are also supplied", async () => {
  const value = await fixture("sibling-explicit");
  try {
    const primary = value.preparedInputs.fingerprints[0]!;
    const explicit = joinPath(value.root, "explicit 空间", "out");
    const prepared = await prepareExtractionDestination({
      workspace: value.workspace,
      operationDirectory: value.operation,
      requestedOutput: explicit,
      preparedInputs: value.preparedInputs,
      defaultPlacement: {
        kind: "exported",
        primaryInputs: [{ realPath: primary.realPath, kind: primary.kind }],
      },
      directoryInspector: benignInspector,
    });
    assert.equal(prepared.effectiveOutput, explicit);
    assert.equal(prepared.effectiveIdentity, pathIdentity(explicit));
    assert.notEqual(prepared.effectiveIdentity, prepared.ownedIdentity);
  } finally {
    await cleanup(value);
  }
});

test("mixed primary parents map to a path rejection before any target exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-extract-paths-mixed-"));
  const workspace = path.join(root, "workspace");
  const operation = path.join(workspace, ".gdre", "operations", "mixed-op");
  const first = path.join(root, "first", "a.pck");
  const second = path.join(root, "second", "b.pck");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(operation, { recursive: true });
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, "a", "utf8");
    await writeFile(second, "b", "utf8");
    const preparedInputs = await prepareListingInputs(
      workspace,
      { inputs: [
        { kind: "path", path: first },
        { kind: "path", path: second },
      ] },
      undefined,
      undefined,
      { directoryInspector: benignInspector },
    );
    await assert.rejects(
      prepareExtractionDestination({
        workspace,
        operationDirectory: operation,
        preparedInputs,
        defaultPlacement: {
          kind: "extracted",
          primaryInputs: preparedInputs.fingerprints.map((fingerprint) => ({
            realPath: fingerprint.realPath,
            kind: fingerprint.kind,
          })),
        },
        directoryInspector: benignInspector,
      }),
      (error: unknown) =>
        error instanceof ExtractionPathError &&
        error.code === "path_unsupported" &&
        /explicit output/u.test(error.message),
    );
    await assert.rejects(stat(path.join(root, "first", "gdre-extracted-mixed-op")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
