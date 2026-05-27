import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Agent } from "../agent/Agent.js";
import { connectMcpTools } from "../mcp/client.js";
import { createProvider } from "../providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const SYSTEM_PROMPT = `You are an engineering assistant with filesystem tools provided over MCP.
Use the tools to explore the project before answering. Keep responses concise.
Once you have the answer, return it and stop calling tools.`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Single shared MCP connection + agent for the demo. Conversation history is
// per-process - fine for an interview demo, would be per-session in prod.
let provider, agent, mcp;
async function init() {
  provider = createProvider();
  mcp = await connectMcpTools();
  agent = new Agent({ provider, tools: mcp.tools, systemPrompt: SYSTEM_PROMPT, maxSteps: 12 });
  console.log(`[web] provider=${provider.name}  tools=${mcp.tools.map((t) => t.name).join(",")}`);
}

app.get("/api/meta", (_req, res) => {
  res.json({
    provider: provider?.name ?? "(initializing)",
    tools: mcp?.tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations })) ?? [],
    resources: [
      ...(mcp?.resources?.map((r) => ({ uri: r.uri, name: r.name, description: r.description })) ?? []),
      ...(mcp?.resourceTemplates?.map((t) => ({
        uri: t.uriTemplate,
        name: t.name,
        description: t.description,
        template: true,
      })) ?? []),
    ],
    prompts:
      mcp?.prompts?.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments ?? [],
      })) ?? [],
  });
});

app.post("/api/reset", (_req, res) => {
  agent?.reset();
  res.json({ ok: true });
});

// Read an MCP resource by URI (for the sidebar preview).
app.get("/api/resource", async (req, res) => {
  try {
    const text = await mcp.readResource(String(req.query.uri ?? ""));
    res.json({ text });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Render an MCP prompt template (arguments passed as JSON query params).
app.get("/api/prompt", async (req, res) => {
  try {
    const args = req.query.args ? JSON.parse(String(req.query.args)) : {};
    const text = await mcp.getPrompt(String(req.query.name ?? ""), args);
    res.json({ text });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Server-Sent Events: stream every agent event as it happens so the UI can
// render a live timeline of the ReAct loop.
app.post("/api/chat", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await agent.run(prompt, { onEvent: (ev) => send(ev.type, ev) });
    send("done", { ok: true });
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

init()
  .then(() => app.listen(PORT, () => console.log(`[web] http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("Failed to initialize web server:", err);
    process.exit(1);
  });
