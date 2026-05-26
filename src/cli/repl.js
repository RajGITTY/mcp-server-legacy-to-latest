import "dotenv/config";
import readline from "readline";
import { Agent } from "../agent/Agent.js";
import { connectMcpTools } from "../mcp/client.js";
import { createProvider } from "../providers/index.js";
import { renderEvent } from "./render.js";

const SYSTEM_PROMPT = `You are an engineering assistant with filesystem tools provided over MCP.
Use the tools to explore the project before answering questions about it.
Be terse: prefer one short paragraph over multi-section reports.
End with a clear answer; do not call more tools after the answer.`;

async function main() {
  const provider = createProvider();
  console.log(`\x1b[2mProvider: ${provider.name}\x1b[0m`);
  console.log(`\x1b[2mConnecting MCP server…\x1b[0m`);

  const mcp = await connectMcpTools();
  console.log(`\x1b[2mMCP tools available: ${mcp.tools.map((t) => t.name).join(", ")}\x1b[0m`);
  console.log(`\x1b[2mType your prompt. Commands: /reset, /tools, /exit\x1b[0m\n`);

  const agent = new Agent({
    provider,
    tools: mcp.tools,
    systemPrompt: SYSTEM_PROMPT,
    maxSteps: 12,
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((res) => rl.question("\x1b[1m\x1b[34m▷ \x1b[0m", res));

  const shutdown = async () => {
    rl.close();
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  while (true) {
    let line;
    try { line = (await ask()).trim(); } catch { break; }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") { agent.reset(); console.log("\x1b[2m(history cleared)\x1b[0m"); continue; }
    if (line === "/tools") { console.log(mcp.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")); continue; }

    try {
      await agent.run(line, { onEvent: renderEvent });
    } catch (err) {
      console.error(`\x1b[31mAgent error:\x1b[0m ${err.message}`);
    }
  }

  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
