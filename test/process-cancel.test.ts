import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import test from "node:test";
import { NodeProcessRunner, boundedPreview, type StreamSink } from "../src/process.js";
import {
  NativeOwnershipFactory,
  ScriptedOwnershipFactory,
  type OwnedLaunchRequest,
  type OwnershipCompletion,
  type OwnershipHandle,
} from "../src/process-tree.js";

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const streamPaths = (root: string) => ({
  stdoutBin: path.join(root, "stdout.bin"),
  stdoutText: path.join(root, "stdout.txt"),
  stderrBin: path.join(root, "stderr.bin"),
  stderrText: path.join(root, "stderr.txt"),
});

const markerScript = (marker: string): string =>
  `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`;

const completion = (
  rootPid: number | null,
  overrides: Partial<OwnershipCompletion> = {},
): OwnershipCompletion => ({
  helperExitCode: 0,
  helperSignal: null,
  launchStarted: rootPid !== null,
  rootPid,
  rootExitObserved: false,
  rootExitCode: null,
  rootExit: null,
  cleanupConfirmed: rootPid !== null,
  noDescendantsConfirmed: rootPid !== null,
  knownPids: rootPid === null ? [] : [rootPid],
  activePids: rootPid === null ? null : [],
  stopRequested: false,
  actions: [],
  error: null,
  status: null,
  ...overrides,
});

interface SpawnedRoot {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly rootStartedAtUtc: string;
  readonly rootExit: Promise<{ readonly observedAtUtc: string | null; readonly elapsedMilliseconds: number | null }>;
}

/** A controlled stand-in helper that launches the requested root itself. */
const spawnRoot = (request: OwnedLaunchRequest): SpawnedRoot => {
  // Same-clock fixture timing: spawn request and observed exit.
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
  const rootExit = new Promise<{ observedAtUtc: string; elapsedMilliseconds: number }>((resolve) => {
    child.once("exit", () => {
      resolve({
        observedAtUtc: new Date().toISOString(),
        elapsedMilliseconds: performance.now() - startedMono,
      });
    });
    child.once("error", () => {
      resolve({
        observedAtUtc: new Date().toISOString(),
        elapsedMilliseconds: performance.now() - startedMono,
      });
    });
  });
  return { child, closed, rootStartedAtUtc, rootExit };
};

test("process runner aborts a running operation through the ownership seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-"));
  const controller = new AbortController();
  let rootPid: number | null = null;
  let terminated = false;
  const ownershipFactory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    rootPid = launched.child.pid ?? null;
    const handle: OwnershipHandle = {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        return completion(rootPid, { rootExitObserved: true, rootExitCode: launched.child.exitCode });
      },
      terminate: async () => {
        terminated = true;
        try { launched.child.kill(); } catch { /* the process may already have exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completion(rootPid, {
          rootExitObserved: true,
          rootExitCode: launched.child.exitCode,
          actions: ["requested a cooperative stop through the test helper"],
        });
      },
    };
    return handle;
  });
  const runner = new NodeProcessRunner();
  const abortTimer = setTimeout(() => controller.abort(), 75);
  try {
    const result = await runner.run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory,
    });
    assert.equal(terminated, true);
    assert.equal(result.trigger, "cancel");
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.cleanup.trigger, "cancel");
    assert.notEqual(rootPid, null);
    assert.equal(result.pid, rootPid);
  } finally {
    clearTimeout(abortTimer);
    await rm(root, { recursive: true, force: true });
  }
});

test("an already-aborted signal never spawns a child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-preabort-"));
  const marker = path.join(root, "spawned.marker");
  try {
    const started = Date.now();
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", markerScript(marker)],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: AbortSignal.abort(),
    });
    assert.equal(result.pid, null);
    assert.equal(result.trigger, "cancel");
    assert.equal(result.exitObserved, false);
    assert.equal(result.cleanup.state, "not_needed");
    assert.ok(Date.now() - started < 2_000);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation observed while the helper is starting prevents a late launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-prepare-abort-"));
  const marker = path.join(root, "spawned.marker");
  const controller = new AbortController();
  let cancelled = false;
  const factory: ScriptedOwnershipFactory = new ScriptedOwnershipFactory(async () => ({
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    ready: new Promise((resolve) => setTimeout(() => resolve({ success: true, error: null, helperPid: null, rootPid: 4242, rootStartedAtUtc: null }), 150)),
    rootExit: new Promise<never>(() => undefined),
    async waitForCompletion(): Promise<OwnershipCompletion> {
      throw new Error("waitForCompletion must not be used");
    },
    async terminate(): Promise<OwnershipCompletion> {
      cancelled = true;
      return completion(null, {
        status: {
          state: "cancelled",
          launch: { started: false, rootPid: 0, cancelledBeforeLaunch: true },
          cleanup: { state: "not-started", confirmed: false, activeJobPids: null },
        },
        actions: ["requested a cooperative stop before the root was created"],
      });
    },
  }));
  setTimeout(() => controller.abort(), 30);
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", markerScript(marker)],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory: factory,
    });
    assert.equal(result.pid, null);
    assert.equal(result.trigger, "cancel");
    assert.equal(result.cleanup.state, "not_needed");
    assert.equal(cancelled, true);
    assert.ok(result.cleanup.actions.includes("requested a cooperative stop before the root was created"));
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abort during readiness stops promptly instead of waiting for the readiness deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-ready-abort-"));
  const controller = new AbortController();
  let terminated = false;
  const factory = new ScriptedOwnershipFactory(async () => ({
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    // A delayed fixture that never resolves readiness in time.
    ready: new Promise((resolve) => setTimeout(() => resolve({ success: true, error: null, helperPid: null, rootPid: 99, rootStartedAtUtc: null }), 10_000)),
    rootExit: new Promise<never>(() => undefined),
    async waitForCompletion(): Promise<OwnershipCompletion> {
      throw new Error("waitForCompletion must not be used");
    },
    async terminate(): Promise<OwnershipCompletion> {
      terminated = true;
      return completion(null, { actions: ["requested a cooperative stop during readiness"] });
    },
  }));
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 30_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory: factory,
    });
    assert.equal(terminated, true);
    assert.equal(result.trigger, "cancel");
    assert.equal(result.pid, null);
    assert.ok(Date.now() - started < 3_000, "abort must not wait for the readiness deadline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process capture keeps complete disk evidence while bounding observation text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-streams-"));
  const expectedText = `HEAD-${"界".repeat(5_000)}-TAIL🙂`;
  const expectedRaw = Buffer.from(expectedText, "utf8");
  const ownershipFactory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        return completion(rootPid, {
          rootExitObserved: true,
          rootExitCode: launched.child.exitCode,
        });
      },
      terminate: async () => {
        try { launched.child.kill(); } catch { /* already exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completion(rootPid, { rootExitObserved: true, rootExitCode: launched.child.exitCode });
      },
    };
  });
  const script = [
    "process.stdout.write('HEAD-');",
    "process.stdout.write(Buffer.from([0xe7]));",
    "process.stdout.write(Buffer.from([0x95, 0x8c]));",
    "for (let i = 0; i < 4999; i += 1) process.stdout.write('界');",
    "process.stdout.write('-TAIL🙂');",
  ].join("");
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", script],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory,
    });
    const paths = streamPaths(root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.trigger, null);
    assert.equal(result.stdout.complete, true);
    assert.equal(result.stdout.utf8Valid, true);
    assert.equal(result.stdout.bytes, expectedRaw.byteLength);
    assert.deepEqual(await readFile(paths.stdoutBin), expectedRaw);
    assert.equal((await readFile(paths.stdoutText)).toString("utf8"), expectedText);
    assert.equal(result.stdout.text, boundedPreview(expectedText).text);
    assert.equal(result.stdoutText, result.stdout.text);
    assert.equal(result.stdout.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout.text, "utf8") <= 8_192);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing stdout sink requests storage termination without waiting for stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-process-storage-"));
  let terminated = false;
  const sink: StreamSink = {
    append: async (kind) => {
      if (kind === "stdout") throw new Error("injected stdout sink failure");
    },
    close: async () => undefined,
  };
  const ownershipFactory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        return completion(rootPid);
      },
      terminate: async () => {
        terminated = true;
        try { launched.child.kill(); } catch { /* already exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completion(rootPid);
      },
    };
  });
  const started = Date.now();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('fail'); process.stderr.write('held'); setInterval(() => {}, 1000);"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory,
      sink,
    });
    assert.equal(result.trigger, "storage");
    assert.notEqual(result.storageError, null);
    assert.equal(terminated, true);
    assert.ok(Date.now() - started < 1_800);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abort observed after the natural root exit does not overwrite the natural outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-late-abort-"));
  const controller = new AbortController();
  let terminated = false;
  const ownershipFactory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await Promise.race([launched.closed, sleep(100)]);
        await sleep(800);
        return completion(rootPid, {
          rootExitObserved: true,
          rootExitCode: 1,
        });
      },
      terminate: async () => {
        terminated = true;
        return completion(rootPid, { rootExitObserved: true, rootExitCode: 1 });
      },
    };
  });
  const lateAbort = setTimeout(() => controller.abort(), 500);
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "process.exit(1)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory,
    });
    assert.equal(result.exitObserved, true);
    assert.equal(result.trigger, null);
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(terminated, false);
  } finally {
    clearTimeout(lateAbort);
    await rm(root, { recursive: true, force: true });
  }
});

test("a launch failure reports no launched work and never claims confirmed cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-launch-failure-"));
  const factory = new ScriptedOwnershipFactory(async () => ({
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    ready: Promise.resolve({
      success: false,
      error: "root creation failed with Win32 5",
      helperPid: 777,
      rootPid: null,
      rootStartedAtUtc: null,
    }),
    rootExit: new Promise<never>(() => undefined),
    async waitForCompletion(): Promise<OwnershipCompletion> {
      throw new Error("waitForCompletion must not be used");
    },
    async terminate(): Promise<OwnershipCompletion> {
      return completion(null, {
        error: "root creation failed with Win32 5",
        status: {
          state: "failed",
          launch: { started: false, rootPid: 0, cancelledBeforeLaunch: false },
          cleanup: { state: "not-started", confirmed: false, activeJobPids: null },
        },
        actions: [],
      });
    },
  }));
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: factory,
    });
    assert.equal(result.pid, null);
    assert.equal(result.cleanup.state, "not_needed");
    assert.match(result.error ?? "", /root creation failed/u);
    assert.equal(result.spawnError?.code, "ownership_unavailable");
    assert.equal(result.cleanup.actions.some((action) => action.includes("confirmed")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed termination reports only the actions that were performed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-unconfirmed-"));
  const controller = new AbortController();
  const factory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        return completion(rootPid);
      },
      terminate: async () => {
        try { launched.child.kill(); } catch { /* already exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completion(rootPid, {
          cleanupConfirmed: false,
          noDescendantsConfirmed: false,
          activePids: null,
          error: "native helper did not confirm the owned Job is empty",
          actions: ["requested a cooperative stop through the test helper"],
        });
      },
    };
  });
  const abortTimer = setTimeout(() => controller.abort(), 75);
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      signal: controller.signal,
      ownershipFactory: factory,
    });
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.cleanup.actions.includes("requested a cooperative stop through the test helper"), true);
    assert.equal(result.cleanup.actions.some((action) => action.includes("confirmed the owned Job")), false);
    assert.match(result.cleanup.error ?? "", /did not confirm/u);
  } finally {
    clearTimeout(abortTimer);
    await rm(root, { recursive: true, force: true });
  }
});

test("the cleanup allowance arms only after observed root exit and its expiry is an explicit ownership error", {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-natural-bound-"));
  const statusPath = path.join(root, "ownership.json");
  let terminateCalls = 0;
  // The root exits naturally; the stand-in helper then stalls cleanup.
  const rootScript = "setTimeout(() => {}, 100)";
  const factory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid, rootStartedAtUtc: launched.rootStartedAtUtc }),
      rootExit: launched.rootExit,
      // The helper is stalled after the root's observed exit.
      waitForCompletion: async () => new Promise<OwnershipCompletion>(() => undefined),
      terminate: async () => {
        terminateCalls += 1;
        try { launched.child.kill(); } catch { /* already exited */ }
        await Promise.race([launched.closed, sleep(5_000)]);
        return completion(rootPid, {
          rootExitObserved: true,
          rootExitCode: 0,
          cleanupConfirmed: true,
          noDescendantsConfirmed: true,
          actions: ["requested a cooperative stop through the test helper"],
        });
      },
    };
  });
  const started = Date.now();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", rootScript],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 60_000,
      streamPaths: streamPaths(root),
      statusPath,
      ownershipFactory: factory,
    });
    const elapsed = Date.now() - started;
    assert.equal(terminateCalls, 1);
    // The allowance is armed after root exit, not at readiness.
    assert.ok(elapsed >= 14_000 && elapsed < 30_000, `elapsed=${String(elapsed)} ms`);
    assert.equal(result.trigger, null);
    assert.equal(result.exitObserved, true);
    assert.equal(result.exitCode, 0);
    // Cleanup did complete, but the operation still fails explicitly.
    assert.equal(result.cleanup.state, "confirmed");
    assert.match(result.cleanup.error ?? "", /helper completion did not finish/u);
    assert.match(result.error ?? "", /helper completion did not finish/u);
    assert.equal(result.spawnError?.code, "ownership_completion_timeout");
    assert.equal(
      result.cleanup.actions.some((action) => action.includes("natural completion bound")),
      true,
    );
    // The bound's actual effect is a requested stop, reported by the handle.
    assert.equal(
      result.cleanup.actions.includes("requested a cooperative stop through the test helper"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a natural operation longer than the cleanup allowance is not cut off", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-long-natural-"));
  let terminateCalls = 0;
  const factory = new ScriptedOwnershipFactory(async (request) => {
    const launched = spawnRoot(request);
    const rootPid = launched.child.pid ?? null;
    const completed: OwnershipCompletion = completion(rootPid, {
      rootExitObserved: true,
      rootExitCode: 0,
    });
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
        terminateCalls += 1;
        return completed;
      },
    };
  });
  const started = Date.now();
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 17000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 60_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: factory,
    });
    assert.equal(terminateCalls, 0);
    assert.equal(result.trigger, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanup.state, "confirmed");
    assert.equal(result.error, null);
    assert.equal(result.spawnError, null);
    assert.ok(Date.now() - started >= 16_000, "the 17 s runtime must complete naturally");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a large launch request to a non-reading helper does not delay cancellation", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-slow-helper-"));
  const helperScript = path.join(root, "non-reading-helper.ps1");
  await writeFile(helperScript, [
    "param([string]$StatusPath, [int]$PollMilliseconds = 100)",
    "Start-Sleep -Seconds 30",
  ].join("\n"), "utf8");
  const controller = new AbortController();
  const started = Date.now();
  try {
    const factory = new NativeOwnershipFactory({
      helperScriptPath: helperScript,
      helperReadyTimeoutMs: 30_000,
    });
    const abortTimer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await new NodeProcessRunner().run({
        executable: process.execPath,
        argv: ["-e", "setInterval(() => {}, 1000)", "x".repeat(200_000)],
        cwd: root,
        env: { ...process.env },
        timeoutMs: 30_000,
        streamPaths: streamPaths(root),
        statusPath: path.join(root, "ownership.json"),
        signal: controller.signal,
        ownershipFactory: factory,
      });
      assert.equal(result.trigger, "cancel");
      assert.equal(result.pid, null);
      // The helper never published a status; unknown is not confirmed.
      assert.equal(result.cleanup.state, "unconfirmed");
      assert.equal(
        result.cleanup.actions.some((action) => action.includes("terminated the held helper process")),
        true,
        JSON.stringify(result.cleanup.actions),
      );
      assert.ok(Date.now() - started < 12_000, "cancellation must not wait for the pipe write");
    } finally {
      clearTimeout(abortTimer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root timing follows native creation and observation even when readiness is delayed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-timing-"));
  let spawned: ReturnType<typeof spawnRoot> | undefined;
  const exitObservations: Array<{ readonly observedAtUtc: string | null; readonly elapsedMilliseconds: number | null }> = [];
  const factory = new ScriptedOwnershipFactory(async (request) => {
    spawned = spawnRoot(request);
    const launched = spawned;
    const rootPid = launched.child.pid ?? null;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      // Readiness is observed well after the root has already exited.
      ready: new Promise((resolve) => setTimeout(() => resolve({
        success: true,
        error: null,
        helperPid: null,
        rootPid,
        rootStartedAtUtc: launched.rootStartedAtUtc,
      }), 600)),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        const observation = await launched.rootExit;
        exitObservations.push(observation);
        return completion(rootPid, {
          rootExitObserved: true,
          rootExitCode: 0,
          rootExit: observation,
        });
      },
      terminate: async () => completion(rootPid, { rootExitObserved: true, rootExitCode: 0 }),
    };
  });
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 150)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 10_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: factory,
    });
    assert.ok(spawned !== undefined);
    const exitObservation = exitObservations[0];
    assert.ok(exitObservation !== undefined);
    assert.equal(result.spawnedAt, spawned.rootStartedAtUtc);
    assert.equal(result.exitedAt, exitObservation.observedAtUtc);
    assert.ok(result.spawnedAtMono !== null && result.exitedAtMono !== null);
    const interval = result.exitedAtMono! - result.spawnedAtMono!;
    assert.ok(interval > 0, `expected a positive process interval, got ${String(interval)}`);
    assert.ok(
      Math.abs(interval - exitObservation.elapsedMilliseconds!) < 1,
      `monotonic interval ${String(interval)} must equal native elapsed ${String(exitObservation.elapsedMilliseconds)}`,
    );
    assert.ok(Date.parse(result.exitedAt!) >= Date.parse(result.spawnedAt!), "exit must not precede creation");
    assert.equal(result.exitObserved, true);
    assert.equal(result.trigger, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a readiness failure remains a process error when cleanup later learns the root PID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-ready-failure-pid-"));
  let spawned: ReturnType<typeof spawnRoot> | undefined;
  const factory = new ScriptedOwnershipFactory(async (request) => {
    spawned = spawnRoot(request);
    const launched = spawned;
    return {
      stdout: launched.child.stdout,
      stderr: launched.child.stderr,
      // The helper never confirmed readiness, but completion still observes
      // the root and confirms cleanup.
      ready: Promise.resolve({
        success: false,
        error: "ownership helper did not confirm the owned launch",
        helperPid: 500,
        rootPid: null,
        rootStartedAtUtc: null,
      }),
      rootExit: launched.rootExit,
      waitForCompletion: async () => {
        await launched.closed;
        const observation = await launched.rootExit;
        return completion(launched.child.pid ?? null, {
          rootExitObserved: true,
          rootExitCode: launched.child.exitCode,
          rootExit: observation,
          cleanupConfirmed: true,
          noDescendantsConfirmed: true,
        });
      },
      terminate: async () => {
        await launched.closed;
        const observation = await launched.rootExit;
        return completion(launched.child.pid ?? null, {
          rootExitObserved: true,
          rootExitCode: launched.child.exitCode,
          rootExit: observation,
          cleanupConfirmed: true,
          noDescendantsConfirmed: true,
          actions: ["requested a cooperative stop through the test helper"],
        });
      },
    };
  });
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "process.exitCode = 1"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 10_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: factory,
    });
    assert.ok(spawned !== undefined);
    assert.equal(result.pid, spawned.child.pid);
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanup.state, "confirmed");
    assert.match(result.error ?? "", /did not confirm the owned launch/u);
    assert.equal(result.spawnError?.code, "ownership_unavailable");
    assert.match(result.spawnError?.message ?? "", /did not confirm the owned launch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown launch outcome stays unconfirmed rather than a known no-launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdre-mcp-unknown-launch-"));
  const factory = new ScriptedOwnershipFactory(async () => ({
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    ready: Promise.resolve({
      success: false,
      error: "ownership helper exited without publishing status evidence",
      helperPid: 812,
      rootPid: null,
      rootStartedAtUtc: null,
    }),
    rootExit: new Promise<never>(() => undefined),
    async waitForCompletion(): Promise<OwnershipCompletion> {
      throw new Error("waitForCompletion must not be used");
    },
    async terminate(): Promise<OwnershipCompletion> {
      return completion(null, {
        launchStarted: null,
        cleanupConfirmed: false,
        noDescendantsConfirmed: false,
        activePids: null,
        error: "ownership helper exited without publishing status evidence",
        actions: ["observed the helper exit without readable status evidence"],
      });
    },
  }));
  try {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      argv: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      streamPaths: streamPaths(root),
      statusPath: path.join(root, "ownership.json"),
      ownershipFactory: factory,
    });
    assert.equal(result.pid, null);
    // Unknown is not the same as proven no-launch.
    assert.equal(result.cleanup.state, "unconfirmed");
    assert.equal(result.ownership?.launchStarted, null);
    assert.match(result.cleanup.error ?? "", /without publishing status evidence/u);
    assert.equal(result.spawnError?.code, "ownership_unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
