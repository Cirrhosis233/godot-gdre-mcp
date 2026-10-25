import { fileURLToPath } from "node:url";
import { serveStdioConnection } from "./stdio.js";
import { openExecution } from "./execution.js";

function installationRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

async function main(): Promise<void> {
  const execution = await openExecution(installationRoot());
  const connection = serveStdioConnection(execution);
  let stopping = false;

  const shutdown = async (reason: "shutdown" | "disconnect"): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // Bounded safety net: a stuck OS handle must not leave the server alive
    // after a termination request.
    const forceExit = setTimeout(() => {
      process.stderr.write("GDRE MCP shutdown exceeded its bounded allowance; forcing exit.\n");
      process.exit(1);
    }, 30_000);
    forceExit.unref();
    try {
      await connection.close(reason);
    } finally {
      clearTimeout(forceExit);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("shutdown").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Shutdown failed: ${message}\n`);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown("shutdown").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Shutdown failed: ${message}\n`);
      process.exitCode = 1;
    });
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GDRE MCP startup failed: ${message}\n`);
  process.exitCode = 1;
});
