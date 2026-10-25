import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NodeProcessRunner, boundedPreview } from "../src/process.js";
import type { OwnedLaunchRequest, OwnershipCompletion, OwnershipFactory, OwnershipHandle } from "../src/process-tree.js";
import { boundedUtf8 } from "../src/text.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativeHelperPath = path.join(repositoryRoot, "native", "gdre-job-object.ps1");

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A controlled stand-in helper that launches the requested root itself. */
const spawnRoot = (request: OwnedLaunchRequest) => {
  const startedMono = performance.now();
  const rootStartedAtUtc = new Date().toISOString();
  const child = spawn(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  const rootExit = new Promise<{ readonly observedAtUtc: string | null; readonly elapsedMilliseconds: number | null }>((resolve) => {
    child.once("exit", () => {
      resolve({ observedAtUtc: new Date().toISOString(), elapsedMilliseconds: performance.now() - startedMono });
    });
    child.once("error", () => {
      resolve({ observedAtUtc: new Date().toISOString(), elapsedMilliseconds: performance.now() - startedMono });
    });
  });
  return { child, closed, rootStartedAtUtc, rootExit };
};

const scriptedOwnership = (
  overrides: Partial<OwnershipCompletion> = {},
): OwnershipFactory => ({
  async launch(request: OwnedLaunchRequest): Promise<OwnershipHandle> {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    const completed: OwnershipCompletion = {
      helperExitCode: 0,
      helperSignal: null,
      launchStarted: rootPid !== null,
      rootPid,
      rootExitObserved: false,
      rootExitCode: null,
      rootExit: null,
      cleanupConfirmed: true,
      noDescendantsConfirmed: true,
      knownPids: rootPid === null ? [] : [rootPid],
      activePids: [],
      stopRequested: false,
      actions: [],
      error: null,
      status: null,
      ...overrides,
    };
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        return completed;
      },
      terminate: async () => {
        try { launched.child.kill(); } catch { /* already exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completed;
      },
    };
  },
});

test("omitting a process timeout does not terminate ordinary running work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-no-timeout-"));
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => process.stdout.write('completed'), 100)"],
      cwd: root,
      env: process.env,
      streamPaths: {
        stdoutBin: path.join(root, "stdout.bin"), stdoutText: path.join(root, "stdout.txt"),
        stderrBin: path.join(root, "stderr.bin"), stderrText: path.join(root, "stderr.txt"),
      },
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: scriptedOwnership(),
    });
    assert.equal(result.trigger, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.text, "completed");
    assert.equal(result.cleanup.state, "confirmed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timeout abort before launch retains the timeout classification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-timeout-abort-"));
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath, argv: [], cwd: root, env: process.env,
      streamPaths: {
        stdoutBin: path.join(root, "stdout.bin"), stdoutText: path.join(root, "stdout.txt"),
        stderrBin: path.join(root, "stderr.bin"), stderrText: path.join(root, "stderr.txt"),
      },
      statusPath: path.join(root, "ownership.json"),
      signal: AbortSignal.abort({ kind: "timeout" }),
    });
    assert.equal(result.trigger, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanup.trigger, "timeout");
    assert.equal(result.cleanup.state, "not_needed");
    assert.equal(result.pid, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a timeout abort stops owned work through the ordinary cancellation seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-owned-timeout-"));
  const controller = new AbortController();
  const delegate = scriptedOwnership();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath, argv: ["-e", "setTimeout(() => {}, 10000)"], cwd: root, env: process.env,
      streamPaths: {
        stdoutBin: path.join(root, "stdout.bin"), stdoutText: path.join(root, "stdout.txt"),
        stderrBin: path.join(root, "stderr.bin"), stderrText: path.join(root, "stderr.txt"),
      },
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory: {
        async launch(request, statusPath) {
          const handle = await delegate.launch(request, statusPath);
          controller.abort({ kind: "timeout" });
          return handle;
        },
      },
    });
    assert.equal(result.trigger, "timeout");
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanup.trigger, "timeout");
    assert.equal(result.cleanup.state, "confirmed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed ownership has a finite stream drain without an operation timeout", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-completed-drain-"));
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const completed: OwnershipCompletion = {
    helperExitCode: 0, helperSignal: null, launchStarted: true, rootPid: 1234,
    rootExitObserved: true, rootExitCode: 0,
    rootExit: { observedAtUtc: new Date().toISOString(), elapsedMilliseconds: 1 },
    cleanupConfirmed: true, noDescendantsConfirmed: true, knownPids: [1234], activePids: [],
    stopRequested: false, actions: [], error: null, status: null,
  };
  try {
    const started = performance.now();
    const result = await new NodeProcessRunner().run({
      executable: process.execPath, argv: [], cwd: root, env: process.env,
      streamPaths: {
        stdoutBin: path.join(root, "stdout.bin"), stdoutText: path.join(root, "stdout.txt"),
        stderrBin: path.join(root, "stderr.bin"), stderrText: path.join(root, "stderr.txt"),
      },
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: {
        async launch() {
          return {
            stdout, stderr,
            ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid: 1234, rootStartedAtUtc: new Date().toISOString() }),
            rootExit: Promise.resolve(completed.rootExit!),
            waitForCompletion: async () => completed,
            terminate: async () => completed,
          };
        },
      },
    });
    assert.ok(performance.now() - started >= 1_900);
    assert.equal(result.trigger, null);
    assert.equal(result.stdout.complete, false);
    assert.equal(result.stderr.complete, false);
    assert.match(result.captureError ?? "", /capture drain deadline expired/u);
    assert.equal(stdout.destroyed, true);
    assert.equal(stderr.destroyed, true);
  } finally {
    stdout.destroy();
    stderr.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("stream previews reserve the truncation marker within the UTF-8 byte budget", () => {
  const preview = boundedPreview("头部".repeat(5000), 8192);
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text, "utf8") <= 8192);
  assert.ok(preview.text.includes("\n...[truncated]...\n"));
});

test("short stream previews preserve content without a marker", () => {
  const value = "GDRE version\r\n";
  const preview = boundedPreview(value);
  assert.deepEqual(preview, { text: value, truncated: false });
});

test("bounded preview preserves independently derived ASCII head, marker, and tail", () => {
  const maxBytes = 8_192;
  const marker = "\n...[truncated]...\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const payloadBudget = maxBytes - markerBytes;
  const headBudget = Math.floor(payloadBudget / 2);
  const tailBudget = payloadBudget - headBudget;
  const value = `HEAD:${"middle-".repeat(4_000)}:TAIL`;
  const expected = `${value.slice(0, headBudget)}${marker}${value.slice(-tailBudget)}`;
  const preview = boundedPreview(value, maxBytes);

  assert.equal(preview.truncated, true);
  assert.equal(preview.text, expected);
  assert.equal(Buffer.byteLength(preview.text, "utf8"), maxBytes);
  assert.ok(preview.text.startsWith(value.slice(0, 5)));
  assert.ok(preview.text.endsWith(value.slice(-5)));
});

test("bounded preview never splits a multibyte code point at a chunk boundary", () => {
  const preview = boundedPreview("界🙂".repeat(10_000));
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text, "utf8") <= 8_192);
  for (let index = 0; index < preview.text.length; index += 1) {
    const code = preview.text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.ok(index + 1 < preview.text.length);
      const next = preview.text.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      assert.ok(index > 0);
      const previous = preview.text.charCodeAt(index - 1);
      assert.ok(previous >= 0xd800 && previous <= 0xdbff);
    }
  }
});

test("diagnostic text is bounded by UTF-8 bytes, not UTF-16 code units", () => {
  const value = "界".repeat(2_000);
  const bounded = boundedUtf8(value, "fallback", 2_048);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= 2_048);
  assert.ok(bounded.endsWith("..."));
  assert.ok(!bounded.includes("�"));
});

test("process preview redaction handles split secrets before head/tail truncation while raw evidence stays exact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-redaction-"));
  const key = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  const stdoutScript = [
    `process.stdout.write(${JSON.stringify("A".repeat(8_100))});`,
    `process.stdout.write(${JSON.stringify(key.slice(0, 23))});`,
    `process.stdout.write(${JSON.stringify(key.slice(23))});`,
    `process.stdout.write(${JSON.stringify("Z".repeat(2_000))});`,
  ].join("");
  const paths = {
    stdoutBin: path.join(root, "stdout.bin"),
    stdoutText: path.join(root, "stdout.txt"),
    stderrBin: path.join(root, "stderr.bin"),
    stderrText: path.join(root, "stderr.txt"),
  };
  const ownership = scriptedOwnership();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", stdoutScript],
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      streamPaths: paths,
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: ownership,
      redactSecrets: [key],
    });
    assert.equal(result.captureError, null);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stdout.text.includes(key), false);
    assert.equal(result.stdout.text.includes(key.slice(0, 8)), false);
    assert.equal((await readFile(paths.stdoutBin, "utf8")), "A".repeat(8_100) + key + "Z".repeat(2_000));
    assert.equal((await readFile(paths.stdoutText, "utf8")), "A".repeat(8_100) + key + "Z".repeat(2_000));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process preview matcher handles cut-adjacent offsets, short writes, stderr, and truncation", async () => {
  const key = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  const offsets = [0, 1, 31, 32, 63, 64, 95, 96, 97, 127, 128, 129];
  const run = async (
    kind: "stdout" | "stderr",
    chunks: readonly string[],
    secrets: readonly string[] = [key],
  ): Promise<{ readonly preview: string; readonly raw: string; readonly text: string }> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-matcher-"));
    const paths = {
      stdoutBin: path.join(root, "stdout.bin"),
      stdoutText: path.join(root, "stdout.txt"),
      stderrBin: path.join(root, "stderr.bin"),
      stderrText: path.join(root, "stderr.txt"),
    };
    const ownership = scriptedOwnership();
    const script = chunks.map((chunk) => `process.${kind}.write(${JSON.stringify(chunk)});`).join("");
    try {
      const result = await new NodeProcessRunner().run({
        executable: process.execPath,
        argv: ["-e", script],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
        streamPaths: paths,
        statusPath: path.join(root, "ownership.json"),
        ownershipFactory: ownership,
        redactSecrets: secrets,
      });
      const rawPath = kind === "stdout" ? paths.stdoutBin : paths.stderrBin;
      const textPath = kind === "stdout" ? paths.stdoutText : paths.stderrText;
      return {
        preview: kind === "stdout" ? result.stdout.text : result.stderr.text,
        raw: await readFile(rawPath, "utf8"),
        text: await readFile(textPath, "utf8"),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  const mixedKey = "aBcDeF0123456789aBcDeF0123456789aBcDeF0123456789aBcDeF0123456789";
  const unicodePayload = `İ${mixedKey}Ω🙂`;
  const unicodeShortWrite = await run("stdout", [unicodePayload], [mixedKey]);
  assert.equal(unicodeShortWrite.preview, "İ<redacted>Ω🙂");
  assert.equal(unicodeShortWrite.raw, unicodePayload);
  assert.equal(unicodeShortWrite.text, unicodePayload);
  const unicodeSplit = await run("stdout", [unicodePayload.slice(0, 1 + 31), unicodePayload.slice(1 + 31)], [mixedKey]);
  assert.equal(unicodeSplit.preview, "İ<redacted>Ω🙂");
  assert.equal(unicodeSplit.raw, unicodePayload);
  assert.equal(unicodeSplit.text, unicodePayload);

  const dottedWithDots = `İ${mixedKey}...`;
  const dottedResult = await run("stdout", [dottedWithDots], [mixedKey]);
  assert.equal(dottedResult.preview, "İ<redacted>...");
  assert.equal(dottedResult.raw, dottedWithDots);
  assert.equal(dottedResult.text, dottedWithDots);

  for (const offset of offsets) {
    const payload = `${"A".repeat(offset)}${key}${"Z".repeat(256 - offset)}`;
    const split = Math.floor(payload.length / 2);
    const result = await run("stdout", [payload.slice(0, split), payload.slice(split)]);
    assert.equal(result.raw, payload);
    assert.equal(result.preview.includes(key), false);
    assert.equal(result.preview.includes(key.slice(0, 8)), false);
  }
  const oneWrite = await run("stdout", [`${"A".repeat(96)}${key}${"Z".repeat(96)}`]);
  assert.equal(oneWrite.raw, `${"A".repeat(96)}${key}${"Z".repeat(96)}`);
  assert.equal(oneWrite.preview.includes(key), false);
  assert.equal(oneWrite.preview.includes(key.slice(0, 8)), false);

  const short = await run("stdout", [key]);
  assert.equal(short.raw, key);
  assert.equal(short.preview.includes(key), false);
  const stderr = await run("stderr", ["prefix", key.slice(0, 20), key.slice(20), "suffix"]);
  assert.equal(stderr.raw, `prefix${key}suffix`);
  assert.equal(stderr.preview.includes(key), false);
  const truncated = await run("stdout", ["A".repeat(9_000), key, "Z".repeat(9_000)]);
  assert.equal(truncated.raw, "A".repeat(9_000) + key + "Z".repeat(9_000));
  assert.equal(truncated.preview.includes(key), false);
  assert.equal(truncated.preview.includes(key.slice(0, 8)), false);
});

test("native owned launch preserves exact argv, cwd, explicit env, streams, and natural exit", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-native-fidelity-"));
  const scriptPath = path.join(root, "fidelity.cjs");
  const previousParentOnly = process.env.GDRE_TEST_PARENT_ONLY;
  await writeFile(scriptPath, [
    "const fs = require('node:fs');",
    "const values = {",
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  stdin: fs.readFileSync(0).toString(),",
    "  explicit: process.env.GDRE_TEST_EXPLICIT ?? null,",
    "  unicode: process.env.GDRE_TEST_UNICODE ?? null,",
    "  parentOnly: process.env.GDRE_TEST_PARENT_ONLY ?? null,",
    "};",
    "process.stdout.write(JSON.stringify(values));",
    "process.stderr.write('STDERR-FIDELITY-界');",
    "process.exitCode = 1;",
  ].join("\n"), "utf8");
  // Empty strings, spaces, quotes, trailing/embedded backslashes, and Unicode
  // must survive the native command-line quoting exactly.
  const argv = ["", "plain", "with space", 'quote"inside', "trailing\\", "back\slash", "unicode-界🙂", ""];
  process.env.GDRE_TEST_PARENT_ONLY = "helper-inherited";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GDRE_TEST_EXPLICIT: "explicit-值",
    GDRE_TEST_UNICODE: "🙂",
  };
  delete env.GDRE_TEST_PARENT_ONLY;
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: [scriptPath, ...argv],
      cwd: root,
      env,
      timeoutMs: 30_000,
      streamPaths: streamPathsFor(root),
      statusPath: path.join(root, "ownership.json"),
      helperScriptPath: nativeHelperPath,
    });
    assert.equal(typeof result.pid, "number");
    assert.equal(result.exitCode, 1);
    assert.equal(result.trigger, null);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, null);
    // Native creation/exit timing maps to one monotonic interval.
    assert.notEqual(result.spawnedAt, null);
    assert.notEqual(result.exitedAt, null);
    assert.ok(Date.parse(result.exitedAt!) >= Date.parse(result.spawnedAt!));
    assert.notEqual(result.spawnedAtMono, null);
    assert.notEqual(result.exitedAtMono, null);
    assert.ok(result.exitedAtMono! - result.spawnedAtMono! > 0);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stderr.complete, true);
    const observed = JSON.parse(result.stdoutText) as {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly stdin: string;
      readonly explicit: string | null;
      readonly unicode: string | null;
      readonly parentOnly: string | null;
    };
    assert.deepEqual(observed.argv, argv);
    assert.equal(observed.cwd.toLowerCase(), root.toLowerCase());
    // Root stdin is the NUL device, never the helper's control pipe.
    assert.equal(observed.stdin, "");
    assert.equal(observed.explicit, "explicit-值");
    assert.equal(observed.unicode, "🙂");
    // The helper process inherits this variable, but the explicit request env
    // does not contain it; the root must not see it.
    assert.equal(observed.parentOnly, null);
    assert.equal(result.stderrText, "STDERR-FIDELITY-界");
  } finally {
    if (previousParentOnly === undefined) delete process.env.GDRE_TEST_PARENT_ONLY;
    else process.env.GDRE_TEST_PARENT_ONLY = previousParentOnly;
    await rm(root, { recursive: true, force: true });
  }
});

const streamPathsFor = (root: string) => ({
  stdoutBin: path.join(root, "stdout.bin"),
  stdoutText: path.join(root, "stdout.txt"),
  stderrBin: path.join(root, "stderr.bin"),
  stderrText: path.join(root, "stderr.txt"),
});
