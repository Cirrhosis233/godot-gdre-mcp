import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
import { commandRegistry } from "./registry.js";
import type { Execution } from "./execution.js";
import type { CommandId, CommandInput, OperationResult } from "./types.js";

const SERVER_NAME = "godot-gdre-mcp";
const SERVER_VERSION = "0.1.0";

/** Build one connection-pinned MCP server from the authoritative registry. */
export function buildServer(execution: Execution): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const executeTool = async (
    commandId: CommandId,
    arguments_: unknown,
    context: ServerContext,
  ): Promise<CallToolResult> => {
    const progressToken = context.mcpReq._meta?.progressToken;
    const hasProgressToken = typeof progressToken === "string" || typeof progressToken === "number";
    let sequence = 0;
    const notifyProgress = (message: string): void => {
      if (!hasProgressToken) return;
      sequence += 1;
      void context.mcpReq
        .notify({
          method: "notifications/progress",
          params: { progressToken, progress: sequence, message },
        })
        .catch(() => undefined);
    };
    const progress = hasProgressToken
      ? (update: { readonly phase: string; readonly sequence: number }) => {
          sequence = Math.max(sequence, update.sequence);
          notifyProgress(update.phase);
        }
      : undefined;
    const result: OperationResult = await execution.execute(commandId, arguments_, {
      signal: context.mcpReq.signal,
      progress,
    });
    return {
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.success,
    };
  };

  for (const command of commandRegistry) {
    const inputSchema: ZodType<CommandInput> = command.inputSchema;
    server.registerTool(
      command.toolName,
      {
        title: command.title,
        description: command.description,
        annotations: command.annotations,
        inputSchema,
        outputSchema: command.outputSchema,
      },
      (arguments_, context) => executeTool(command.id, arguments_, context),
    );
  }

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
