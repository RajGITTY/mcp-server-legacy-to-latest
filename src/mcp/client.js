import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, "server.js");

/**
 * Spawn the MCP server as a subprocess, list its tools, and adapt each one
 * into the { name, description, parameters, handler } shape the Agent expects.
 *
 * This is the bridge that makes "MCP tool use" real for the agent: tools live
 * in a separate process behind the standard MCP protocol, not as in-memory
 * function references. Swap the transport (HTTP, SSE, websocket) and nothing
 * else changes.
 */
export async function connectMcpTools() {
  const transport = new StdioClientTransport({
    command: process.execPath, // current node binary
    args: [SERVER_SCRIPT],
    cwd: process.cwd(),
  });

  const client = new Client({ name: "ai-agent-cli", version: "2.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const { tools: remoteTools } = await client.listTools();

  const tools = remoteTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema ?? { type: "object", properties: {} },
    handler: async (args) => {
      const res = await client.callTool({ name: t.name, arguments: args ?? {} });
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (res.isError) throw new Error(text || "tool returned an error");
      return text;
    },
  }));

  return {
    tools,
    close: async () => {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}
