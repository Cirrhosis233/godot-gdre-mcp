import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Executes the repository-local hook (`.githooks/pre-commit`) through real `git commit`
// calls in disposable repositories. Every invocation runs with an isolated Git
// environment (empty global config, system config disabled, inherited `GIT_*` variables
// dropped) and an isolated npm environment (inherited `npm_config_*` dropped, disposable
// user/global config and cache). Node and npm stay on PATH, and nothing is installed.
const hooksDir = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".githooks")
  .replaceAll("\\", "/");

// Printed by the fixture typecheck script so tests can prove whether it ran.
const MARKER = "HOOK_TYPECHECK_FIXTURE_RAN_6f1d";
const FIXTURE_ENTRY = "hook-typecheck-fixture.mjs";
const FIXTURE_SOURCE = [
  'import { readFileSync } from "node:fs";',
  "",
  `console.log(${JSON.stringify(MARKER)});`,
  'let input = "";',
  "try {",
  '  input = readFileSync(new URL("./typecheck-input.txt", import.meta.url), "utf8");',
  "} catch {",
  '  input = "";',
  "}",
  'if (input.includes("TYPECHECK_FAIL")) {',
  '  console.error("fixture-typecheck: controlled failure input detected");',
  "  process.exit(1);",
  "}",
  "",
].join("\n");

interface GitResult {
  readonly status: number | null;
  readonly output: string;
}

interface RepoOptions {
  /** The fixture `typecheck` script command; `null` omits the script entirely. */
  readonly typecheckScript?: string | null;
  /** Whether to create the default fixture entry point. */
  readonly writeFixture?: boolean;
}

interface DisposableRepo {
  readonly root: string;
  git(...args: readonly string[]): Promise<GitResult>;
  gitWithEnv(overrides: NodeJS.ProcessEnv, ...args: readonly string[]): Promise<GitResult>;
  dispose(): Promise<void>;
}

// Bounds every spawned command so a hung hook or Git process fails the test
// instead of stalling the whole `npm test` run.
const COMMAND_TIMEOUT_MS = 30_000;

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`timed out after ${COMMAND_TIMEOUT_MS}ms: ${command} ${args.join(" ")}\n${output}`));
        return;
      }
      resolve({ status, output });
    });
  });
}

function isolatedToolEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("GIT_") || upper.startsWith("NPM_CONFIG_")) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, "xdg");
  env.GIT_CONFIG_GLOBAL = path.join(home, "global.gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.npm_config_userconfig = path.join(home, "npmrc");
  env.npm_config_globalconfig = path.join(home, "global-npmrc");
  env.npm_config_cache = path.join(home, "npm-cache");
  env.npm_config_update_notifier = "false";
  env.LC_ALL = "C";
  env.LANG = "C";
  return env;
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function createDisposableRepo(options: RepoOptions = {}): Promise<DisposableRepo> {
  const base = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-whitespace-hook-"));
  const root = path.join(base, "repo");
  const home = path.join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = isolatedToolEnv(home);
  await writeFile(env.GIT_CONFIG_GLOBAL ?? path.join(home, "global.gitconfig"), "");
  await writeFile(env.npm_config_userconfig ?? path.join(home, "npmrc"), "");
  await writeFile(env.npm_config_globalconfig ?? path.join(home, "global-npmrc"), "");

  const typecheckScript =
    options.typecheckScript === undefined ? `node ${FIXTURE_ENTRY}` : options.typecheckScript;
  const scripts: Record<string, string> = {};
  if (typecheckScript !== null) scripts.typecheck = typecheckScript;
  const manifest = { name: "hook-fixture", version: "0.0.0", private: true, scripts };
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.writeFixture ?? true) {
    await writeFile(path.join(root, FIXTURE_ENTRY), FIXTURE_SOURCE);
  }

  const gitOverrides = [
    "-c",
    `core.hooksPath=${hooksDir}`,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "gc.auto=0",
  ];
  const runGit = (gitEnv: NodeJS.ProcessEnv, ...args: readonly string[]): Promise<GitResult> =>
    runProcess("git", [...gitOverrides, ...args], root, gitEnv);
  const git = (...args: readonly string[]): Promise<GitResult> => runGit(env, ...args);

  await git("init", "-q", "--initial-branch=main");
  await git("config", "user.name", "Whitespace Hook Test");
  await git("config", "user.email", "whitespace-hook@example.invalid");

  return {
    root,
    git,
    gitWithEnv(envOverrides: NodeJS.ProcessEnv, ...args: readonly string[]): Promise<GitResult> {
      return runGit({ ...env, ...envOverrides }, ...args);
    },
    async dispose(): Promise<void> {
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("pre-commit hook blocks staged trailing whitespace with diagnostics", async () => {
  const repo = await createDisposableRepo();
  try {
    await writeFile(path.join(repo.root, "baseline.txt"), "baseline\n");
    await repo.git("add", "baseline.txt");
    const baseline = await repo.git("commit", "-m", "baseline");
    assert.equal(baseline.status, 0, baseline.output);

    await writeFile(path.join(repo.root, "note.txt"), "value   \n");
    await repo.git("add", "note.txt");
    const blocked = await repo.git("commit", "-m", "add note");

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /note\.txt/);
    assert.match(blocked.output, /trailing whitespace/);
    assert.equal(countOccurrences(blocked.output, MARKER), 0, "whitespace gate must reject before typecheck");
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook blocks staged blank lines at end of file with diagnostics", async () => {
  const repo = await createDisposableRepo();
  try {
    await writeFile(path.join(repo.root, "baseline.txt"), "baseline\n");
    await repo.git("add", "baseline.txt");
    const baseline = await repo.git("commit", "-m", "baseline");
    assert.equal(baseline.status, 0, baseline.output);

    await writeFile(path.join(repo.root, "trailer.txt"), "content\n\n\n");
    await repo.git("add", "trailer.txt");
    const blocked = await repo.git("commit", "-m", "add trailer");

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /trailer\.txt/);
    assert.match(blocked.output, /blank line at EOF/);
    assert.equal(countOccurrences(blocked.output, MARKER), 0, "whitespace gate must reject before typecheck");
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook allows clean staged content to commit and runs typecheck once", async () => {
  const repo = await createDisposableRepo();
  try {
    await writeFile(path.join(repo.root, "readme.txt"), "first line\nsecond line\n");
    await repo.git("add", "readme.txt");
    const committed = await repo.git("commit", "-m", "clean content");

    assert.equal(committed.status, 0, committed.output);
    assert.equal(countOccurrences(committed.output, MARKER), 1, "typecheck fixture must run exactly once");
    const tree = await repo.git("show", "--pretty=format:", "--name-only", "HEAD");
    assert.match(tree.output, /readme\.txt/);
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook ignores whitespace that exists only in the working tree", async () => {
  const repo = await createDisposableRepo();
  try {
    const memo = path.join(repo.root, "memo.txt");
    await writeFile(memo, "clean staged line\n");
    await repo.git("add", "memo.txt");

    // Add trailing whitespace to the working tree without staging it.
    await writeFile(memo, "clean staged line   \n");
    const committed = await repo.git("commit", "-m", "stage clean content");

    assert.equal(committed.status, 0, committed.output);
    assert.equal(countOccurrences(committed.output, MARKER), 1, "typecheck fixture must run exactly once");
    const stagedBlob = await repo.git("show", "HEAD:memo.txt");
    assert.equal(normalizeNewlines(stagedBlob.output), "clean staged line\n");

    // Confirm the unstaged whitespace really is present, so the pass above is not vacuous.
    const unstagedCheck = await repo.git("diff", "--check");
    assert.notEqual(unstagedCheck.status, 0);
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook rejects a failing typecheck and preserves HEAD and the index", async () => {
  const repo = await createDisposableRepo();
  try {
    await writeFile(path.join(repo.root, "baseline.txt"), "baseline\n");
    await repo.git("add", "baseline.txt");
    const baseline = await repo.git("commit", "-m", "baseline");
    assert.equal(baseline.status, 0, baseline.output);
    const headBefore = normalizeNewlines((await repo.git("rev-parse", "HEAD")).output).trim();

    await writeFile(path.join(repo.root, "clean.txt"), "clean\n");
    await repo.git("add", "clean.txt");
    await writeFile(path.join(repo.root, "typecheck-input.txt"), "TYPECHECK_FAIL\n");

    const blocked = await repo.git("commit", "-m", "add clean content");

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /fixture-typecheck: controlled failure input detected/);
    assert.equal(countOccurrences(blocked.output, MARKER), 1, "typecheck fixture must run exactly once");
    const headAfter = normalizeNewlines((await repo.git("rev-parse", "HEAD")).output).trim();
    assert.equal(headAfter, headBefore);
    const staged = await repo.git("diff", "--cached", "--name-only");
    assert.deepEqual(normalizeNewlines(staged.output).trim().split("\n"), ["clean.txt"]);
    const stagedBlob = await repo.git("show", ":clean.txt");
    assert.equal(stagedBlob.status, 0, stagedBlob.output);
    assert.equal(normalizeNewlines(stagedBlob.output), "clean\n");
    const committedFile = await repo.git("show", "HEAD:clean.txt");
    assert.notEqual(committedFile.status, 0);
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook rejects working-tree-only typecheck errors while preserving both versions", async () => {
  const repo = await createDisposableRepo();
  try {
    await writeFile(path.join(repo.root, "baseline.txt"), "baseline\n");
    await repo.git("add", "baseline.txt");
    const baseline = await repo.git("commit", "-m", "baseline");
    assert.equal(baseline.status, 0, baseline.output);
    const headBefore = normalizeNewlines((await repo.git("rev-parse", "HEAD")).output).trim();

    const input = path.join(repo.root, "typecheck-input.txt");
    await writeFile(input, "clean staged input\n");
    await repo.git("add", "typecheck-input.txt");
    // Typecheck reads the working tree, so an unstaged error must reject the commit.
    await writeFile(input, "TYPECHECK_FAIL only in the working tree\n");

    const blocked = await repo.git("commit", "-m", "commit clean staged input");

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /fixture-typecheck: controlled failure input detected/);
    const headAfter = normalizeNewlines((await repo.git("rev-parse", "HEAD")).output).trim();
    assert.equal(headAfter, headBefore);
    const stagedBlob = await repo.git("show", ":typecheck-input.txt");
    assert.equal(stagedBlob.status, 0, stagedBlob.output);
    assert.equal(normalizeNewlines(stagedBlob.output), "clean staged input\n");
    assert.equal(await readFile(input, "utf8"), "TYPECHECK_FAIL only in the working tree\n");
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook rejects a missing typecheck script even with inherited if-present", async () => {
  const repo = await createDisposableRepo({ typecheckScript: null });
  try {
    await writeFile(path.join(repo.root, "file.txt"), "content\n");
    await repo.git("add", "file.txt");

    const blocked = await repo.gitWithEnv(
      { npm_config_if_present: "true" },
      "commit",
      "-m",
      "commit without a typecheck script",
    );

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /Missing script/i);
    assert.equal(countOccurrences(blocked.output, MARKER), 0);
    const head = await repo.git("rev-parse", "--verify", "HEAD");
    assert.notEqual(head.status, 0);
    const staged = await repo.git("diff", "--cached", "--name-only");
    assert.match(normalizeNewlines(staged.output), /file\.txt/);
    const stagedBlob = await repo.git("show", ":file.txt");
    assert.equal(stagedBlob.status, 0, stagedBlob.output);
    assert.equal(normalizeNewlines(stagedBlob.output), "content\n");
  } finally {
    await repo.dispose();
  }
});

test("pre-commit hook rejects an unavailable typecheck fixture entry point", async () => {
  const repo = await createDisposableRepo({
    typecheckScript: "node missing-typecheck-fixture.mjs",
    writeFixture: false,
  });
  try {
    await writeFile(path.join(repo.root, "file.txt"), "content\n");
    await repo.git("add", "file.txt");

    const blocked = await repo.git("commit", "-m", "commit with missing fixture");

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /Cannot find module|MODULE_NOT_FOUND/);
    assert.equal(countOccurrences(blocked.output, MARKER), 0);
    const head = await repo.git("rev-parse", "--verify", "HEAD");
    assert.notEqual(head.status, 0);
    const staged = await repo.git("diff", "--cached", "--name-only");
    assert.match(normalizeNewlines(staged.output), /file\.txt/);
    const stagedBlob = await repo.git("show", ":file.txt");
    assert.equal(stagedBlob.status, 0, stagedBlob.output);
    assert.equal(normalizeNewlines(stagedBlob.output), "content\n");
  } finally {
    await repo.dispose();
  }
});
