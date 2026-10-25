import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { openExecution } from "../../src/execution.js";
import { serveStdioConnection } from "../../src/stdio.js";
import { NodeProcessRunner, type ProcessRunOptions, type ProcessRunResult, type ProcessRunner } from "../../src/process.js";
import {
  NativeOwnershipFactory,
  type OwnershipCompletion,
  type OwnershipFactory,
  type OwnershipHandle,
  type OwnedLaunchRequest,
} from "../../src/process-tree.js";
import type { StorageFaults } from "../../src/storage.js";

// A narrowly scoped internal fault seam for lifecycle and concurrency tests. It
// is a separate built entry point, not a production tool: the real version tool
// and schemas are unchanged, only the runtime executable and storage writer are
// faulted.

const installationRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Test roots report a version only after the native helper has attached. The
// surrounding ProcessRunner bounds ownership and execution; a second fixture
// deadline must not expire before a valid attach completes.
const versionScript = (
  statusPath: string,
  delayMs = 0,
  output = "Godot RE Tools v2.8.0-beta.2\r\n",
  exitCode = 1,
): string => [
  "const fs = require('node:fs');",
  `const statusPath = ${JSON.stringify(statusPath)};`,
  "function waitForOwnership() {",
  "  try {",
  "    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));",
  "    if (status.state === 'monitoring' && status.attach?.success === true) {",
  `      setTimeout(() => { process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode}); }, ${delayMs});`,
  "      return;",
  "    }",
  "  } catch {}",
  "  setTimeout(waitForOwnership, 10);",
  "}",
  "waitForOwnership();",
].join("\n");
const longScript = "setInterval(() => {}, 1000);";

const mode = process.env.GDRE_MCP_TEST_PROCESS_MODE ?? "natural";
const controlDirectory = process.env.GDRE_MCP_TEST_CONTROL_DIR;

// The controlled operation runtime records its launch in the control directory
// and then blocks until the test writes a release file there. It performs no
// GDRE work: after release it exits with code 3, so a caller can tell a natural
// controlled exit from a process terminated by cleanup. The retained record
// holds the child's actual working directory, the original GDRE arguments, and
// the profile environment; after native ownership is confirmed the runtime
// writes one unique marker per stream and an "owned" file, so each result,
// record, and log can be attributed to exactly one launch.
const controlledScript = (
  controlDir: string,
  argv: readonly string[],
  statusPath: string,
): string => [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  `const controlDir = ${JSON.stringify(controlDir)};`,
  `const statusPath = ${JSON.stringify(statusPath)};`,
  `const partialOutput = ${JSON.stringify(argv.find((token) => token.startsWith("--output="))?.slice("--output=".length) ?? null)};`,
  "const profileNames = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'GDRE_PLUGIN_CACHE_DIR'];",
  `const record = { pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), argv: ${JSON.stringify(argv)}, env: Object.fromEntries(profileNames.map((name) => [name, process.env[name] ?? null])) };`,
  "fs.mkdirSync(controlDir, { recursive: true });",
  "fs.writeFileSync(path.join(controlDir, `started-${process.pid}.json`), JSON.stringify(record));",
  "const releasePath = path.join(controlDir, 'release');",
  "const releaseDeadline = Date.now() + 120000;",
  "function waitForRelease() {",
  "  if (fs.existsSync(releasePath)) { process.stderr.write('controlled runtime released\\n'); process.exitCode = 3; return; }",
  "  if (Date.now() >= releaseDeadline) { process.stderr.write('controlled runtime was never released\\n'); process.exitCode = 4; return; }",
  "  setTimeout(waitForRelease, 10);",
  "}",
  "function waitForOwnership() {",
  "  try {",
  "    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));",
  "    if (status.state === 'monitoring' && status.attach?.success === true) {",
  "      if (partialOutput !== null) { fs.mkdirSync(partialOutput, { recursive: true }); fs.writeFileSync(path.join(partialOutput, 'partial.txt'), 'retained partial'); }",
  "      process.stdout.write(`GDRE_CONTROLLED_STDOUT_${process.pid}\\n`);",
  "      process.stderr.write(`GDRE_CONTROLLED_STDERR_${process.pid}\\n`);",
  "      fs.writeFileSync(path.join(controlDir, `owned-${process.pid}.json`), JSON.stringify({ pid: process.pid }));",
  "      waitForRelease();",
  "      return;",
  "    }",
  "  } catch {}",
  "  setTimeout(waitForOwnership, 10);",
  "}",
  "waitForOwnership();",
].join("\n");

const unconfirmedCompletion = (pid: number | null): OwnershipCompletion => ({
  helperExitCode: null,
  helperSignal: null,
  launchStarted: pid !== null,
  rootPid: pid,
  rootExitObserved: false,
  rootExitCode: null,
  rootExit: null,
  cleanupConfirmed: false,
  noDescendantsConfirmed: false,
  knownPids: pid === null ? [] : [pid],
  activePids: null,
  stopRequested: false,
  actions: [],
  error: "injected unconfirmed cleanup",
  status: null,
});

const unconfirmedLaunch = async (request: OwnedLaunchRequest, statusPath: string): Promise<OwnershipHandle> => {
  if (!statusPath.includes(`${path.sep}.gdre${path.sep}operations${path.sep}`)) {
    return new NativeOwnershipFactory({
      helperScriptPath: path.join(installationRoot, "native", "gdre-job-object.ps1"),
    }).launch(request, statusPath);
  }

  // A controlled stand-in for the helper: it launches the same root and exposes
  // its streams, but always reports an unconfirmed cleanup.
  const startedMono = performance.now();
  const rootStartedAtUtc = new Date().toISOString();
  const child = spawn(request.executable, [...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const completion = unconfirmedCompletion(child.pid ?? null);
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
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    ready: Promise.resolve({ success: true, error: null, helperPid: null, rootPid: child.pid ?? null, rootStartedAtUtc }),
    rootExit,
    waitForCompletion: async () => {
      await closed;
      return completion;
    },
    terminate: async () => {
      try { child.kill(); } catch { /* the test child may already be gone */ }
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      return completion;
    },
  };
};

const attachDelayMs = Number(process.env.GDRE_MCP_TEST_ATTACH_DELAY_MS ?? 0);
const delayedOwnership = (): OwnershipFactory => {
  const delegate = new NativeOwnershipFactory({
    helperScriptPath: path.join(installationRoot, "native", "gdre-job-object.ps1"),
  });
  return {
    async launch(request: OwnedLaunchRequest, statusPath: string): Promise<OwnershipHandle> {
      const handle = await delegate.launch(request, statusPath);
      return {
        stdout: handle.stdout,
        stderr: handle.stderr,
        // The fixture delays only Node's readiness observation; the helper has
        // already created and owned the root.
        ready: new Promise((resolve) => {
          setTimeout(() => {
            void handle.ready.then(resolve, () => resolve({
              success: false,
              error: "delayed ownership readiness failed",
              helperPid: null,
              rootPid: null,
              rootStartedAtUtc: null,
            }));
          }, attachDelayMs);
        }),
        rootExit: handle.rootExit,
        waitForCompletion: () => handle.waitForCompletion(),
        terminate: (trigger) => handle.terminate(trigger),
      };
    },
  };
};
const ownershipFactory = process.env.GDRE_MCP_TEST_OWNERSHIP === "unconfirmed"
  ? { launch: unconfirmedLaunch } satisfies OwnershipFactory
  : attachDelayMs > 0 ? delayedOwnership() : undefined;

const storageFaults = (): StorageFaults => {
  const value = process.env.GDRE_MCP_TEST_STORAGE_FAULT;
  if (value === "failStreams") return { failStreams: true };
  if (value === "failManifest") return { failManifest: true };
  if (value === "failArtifacts") return { failArtifacts: true };
  if (value !== undefined && value.startsWith("failAfterWrites:")) {
    const count = Number(value.slice("failAfterWrites:".length));
    return Number.isSafeInteger(count) ? { failAfterWrites: count } : {};
  }
  return {};
};

class FaultRuntimeRunner implements ProcessRunner {
  private readonly delegate = new NodeProcessRunner();

  public async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const startup = /[\\/]\.gdre[\\/]startup[\\/]/u.test(options.cwd);
    if (!startup && mode === "extract-partial" && options.argv.some((token) => token.startsWith("--list-files="))) {
      const input = options.argv.find((token) => token.startsWith("--list-files="))!.slice("--list-files=".length);
      const output = [
        `Input files: [${JSON.stringify(input)}]`,
        "GDRE Tools v2.8.0-beta.2",
        "Windows 10.0.26100, headless",
        `Opening file: ${input}`,
        "", "Contents:", "res://partial.txt", "", "Total files: 1", "",
      ].join("\n");
      return this.delegate.run({
        ...options,
        executable: process.execPath,
        argv: ["-e", versionScript(options.statusPath, 0, output, 0)],
      });
    }
    if (!startup && (mode === "controlled" || mode === "extract-partial")) {
      if (controlDirectory === undefined) throw new Error("GDRE_MCP_TEST_CONTROL_DIR is required for the controlled process mode");
      process.stderr.write(`fault-runner:controlled:${options.cwd}\n`);
      return this.delegate.run({
        ...options,
        executable: process.execPath,
        argv: ["-e", controlledScript(controlDirectory, options.argv, options.statusPath)],
      });
    }
    const script = startup
      ? versionScript(options.statusPath)
      : mode === "long" ? longScript : versionScript(options.statusPath, mode === "delayed" ? 1500 : 0);
    process.stderr.write(`fault-runner:${startup ? "startup" : mode}:${options.cwd}\n`);
    return this.delegate.run({
      ...options,
      executable: process.execPath,
      argv: ["-e", script],
    });
  }
}

async function main(): Promise<void> {
  if (mode === "controlled" && controlDirectory === undefined) {
    throw new Error("GDRE_MCP_TEST_CONTROL_DIR is required for the controlled process mode");
  }
  const execution = await openExecution(installationRoot, {
    processRunner: new FaultRuntimeRunner(),
    ownershipFactory,
    storageFaults: storageFaults(),
  });
  const handle = serveStdioConnection(execution);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await handle.close("shutdown");
  };
  process.once("SIGINT", () => void shutdown().catch(() => undefined));
  process.once("SIGTERM", () => void shutdown().catch(() => undefined));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fault test server startup failed: ${message}\n`);
  process.exitCode = 1;
});
