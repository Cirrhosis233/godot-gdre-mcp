import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./mcp.js";
import type { Execution } from "./execution.js";

export type ConnectionCloseReason = "shutdown" | "disconnect";

export interface StdioConnection {
  /**
   * Initiates the one shared shutdown for this connection. Later calls return
   * the same promise so an EOF-driven disconnect and an explicit signal cannot
   * race two different reasons into the execution.
   */
  close(reason: ConnectionCloseReason): Promise<void>;
}

/**
 * Owns the real stdio wire and binds its closure to the shared execution.
 *
 * The SDK installs `wire.onclose` synchronously inside `serveStdio`. Wrapping
 * that callback after the call lets the adapter close the shared execution
 * before the SDK tears down the server instance and aborts request signals.
 * It also covers every wire-closure source (stdin EOF, stdout failure, protocol
 * failure) rather than only process stream events.
 */
export function serveStdioConnection(execution: Execution): StdioConnection {
  const wire = new StdioServerTransport();
  const handle = serveStdio(() => buildServer(execution), { transport: wire });
  const sdkOnclose = wire.onclose;

  let shutdown: Promise<void> | null = null;
  const close = (reason: ConnectionCloseReason): Promise<void> => {
    if (shutdown !== null) return shutdown;
    shutdown = (async () => {
      try {
        await execution.close(reason);
      } finally {
        await handle.close();
      }
    })();
    return shutdown;
  };

  wire.onclose = () => {
    try {
      // ExecutionImpl aborts its operation controllers synchronously here, so
      // they retain the disconnect reason before the SDK aborts request signals.
      void close("disconnect").catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Execution shutdown after disconnect failed: ${message}\n`);
      });
    } finally {
      sdkOnclose?.();
    }
  };

  return { close };
}
