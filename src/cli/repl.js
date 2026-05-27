import "dotenv/config";
import readline from "readline";
import { Agent } from "../agent/Agent.js";
import { connectMcpTools } from "../mcp/client.js";
import { createProvider } from "../providers/index.js";
import { createRecorder } from "../agent/recorder.js";
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
  console.log(
    `\x1b[2mMCP: ${mcp.tools.length} tools, ${mcp.resources.length} resources, ${mcp.prompts.length} prompts\x1b[0m`
  );
  console.log(`\x1b[2mType your prompt. Commands: /reset, /tools, /resources, /prompts, /auto, /exit\x1b[0m\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((res) => rl.question("\x1b[1m\x1b[34m▷ \x1b[0m", res));
  const askYesNo = (q) =>
    new Promise((res) => rl.question(`\x1b[33m${q} [y/N] \x1b[0m`, (a) => res(/^y(es)?$/i.test(a.trim()))));

  // Human-in-the-loop: auto-approve read-only tools; confirm destructive ones
  // (using each tool's MCP annotations). Toggle blanket approval with /auto.
  let autoApprove = false;
  const approve = async ({ name, annotations }) => {
    if (autoApprove || !annotations?.destructiveHint) return true;
    return askYesNo(`Allow destructive tool "${name}"?`);
  };

  const agent = new Agent({
    provider,
    tools: mcp.tools,
    systemPrompt: SYSTEM_PROMPT,
    maxSteps: 12,
    approve,
  });

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
    if (line === "/resources") {
      const all = [...mcp.resources.map((r) => r.uri), ...mcp.resourceTemplates.map((t) => t.uriTemplate)];
      console.log(all.map((u) => `- ${u}`).join("\n") || "(none)");
      continue;
    }
    if (line === "/prompts") { console.log(mcp.prompts.map((p) => `- ${p.name}: ${p.description ?? ""}`).join("\n") || "(none)"); continue; }
    if (line === "/auto") {
      autoApprove = !autoApprove;
      console.log(`\x1b[2mauto-approve ${autoApprove ? "ON (destructive tools run without asking)" : "OFF (destructive tools require confirmation)"}\x1b[0m`);
      continue;
    }

    const recorder = createRecorder({ prompt: line, provider: provider.name });
    try {
      await agent.run(line, { onEvent: (ev) => { recorder.onEvent(ev); renderEvent(ev); } });
    } catch (err) {
      console.error(`\x1b[31mAgent error:\x1b[0m ${err.message}`);
    } finally {
      const saved = await recorder.save();
      if (saved) console.log(`\x1b[2m(run saved to ${saved.md})\x1b[0m`);
    }
  }

  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
