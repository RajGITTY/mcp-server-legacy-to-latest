import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, "server.js");

/**
 * Spawn the MCP server as a subprocess and adapt its capabilities for the app:
 *
 *  - tools      → the { name, description, parameters, handler } shape the Agent
 *                 expects (annotations carried along for the UI).
 *  - resources  → listed (static + templated) for display/inspection.
 *  - prompts    → listed, plus passthrough readResource()/getPrompt() helpers.
 *
 * Tools live in a separate process behind the standard MCP protocol, not as
 * in-memory functions. Swap the transport (HTTP, SSE, WebSocket) and nothing
 * else here changes.
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
    annotations: t.annotations ?? {},
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

  // Resources and prompts are optional capabilities — tolerate servers without them.
  const resources = await safeList(() => client.listResources(), "resources");
  const resourceTemplates = await safeList(() => client.listResourceTemplates(), "resourceTemplates");
  const prompts = await safeList(() => client.listPrompts(), "prompts");

  return {
    tools,
    resources,
    resourceTemplates,
    prompts,
    // Passthroughs so a UI can actually read a resource / render a prompt.
    readResource: async (uri) => {
      const res = await client.readResource({ uri });
      return (res.contents ?? []).map((c) => c.text ?? `[${c.mimeType ?? "binary"}]`).join("\n");
    },
    getPrompt: async (name, args = {}) => {
      const res = await client.getPrompt({ name, arguments: args });
      return (res.messages ?? [])
        .map((m) => (typeof m.content?.text === "string" ? m.content.text : ""))
        .join("\n");
    },
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function safeList(fn, key) {
  try {
    const res = await fn();
    return res[key] ?? [];
  } catch {
    return []; // capability not advertised by the server
  }
}
