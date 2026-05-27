import "dotenv/config";
import { Agent } from "../agent/Agent.js";
import { connectMcpTools } from "../mcp/client.js";
import { createProvider } from "../providers/index.js";
import { createRecorder } from "../agent/recorder.js";
import { renderEvent } from "../cli/render.js";

const SYSTEM_PROMPT = `You are a Principal Engineer modernizing a legacy PHP codebase.

Your loop:
1. Use find_files (pattern legacy/**/*.php) or list_directory to discover legacy PHP files.
2. Use read_file to inspect each one, and security_scan to enumerate its vulnerabilities.
3. Confirm the issues (SQL injection, hardcoded credentials, missing input validation,
   weak session handling, missing CSRF protection, plain-text passwords, etc.).
4. Use write_file to emit a hardened replacement under modernized/ using PDO with prepared
   statements, password_hash/password_verify, secure sessions, and PSR-style class structure.
   Preserve the original behavior.
5. Run php_lint on each modernized file to confirm it is syntactically valid, and security_scan
   on it to confirm the findings are resolved. Fix anything that remains.
6. When all legacy files have a clean modernized counterpart, produce a final markdown report
   summarizing every vulnerability you fixed, grouped by file. Do not call more tools after
   the report.

Rules:
- Always read a file before rewriting it.
- Modernized files go under the modernized/ directory, mirroring filenames.
- Do not modify anything under legacy/.
- Be concise in your reasoning; the user is watching the trace live.`;

export async function runModernizationWorkflow({ provider, onEvent } = {}) {
  const mcp = await connectMcpTools();
  try {
    const llmProvider = provider ?? createProvider();
    const agent = new Agent({
      provider: llmProvider,
      tools: mcp.tools,
      systemPrompt: SYSTEM_PROMPT,
      maxSteps: 20,
    });

    const prompt = [
      "Modernize every PHP file under legacy/.",
      "Output the modernized versions under modernized/ and end with a security report.",
    ].join(" ");

    // Record the full run to .agent-runs/ for an audit trail.
    const recorder = createRecorder({ prompt, provider: llmProvider.name });
    const combined = (ev) => {
      recorder.onEvent(ev);
      if (onEvent) onEvent(ev);
    };
    try {
      return await agent.run(prompt, { onEvent: combined });
    } finally {
      const saved = await recorder.save();
      if (saved) console.error(`\n[recorder] run trace saved to ${saved.md}`);
    }
  } finally {
    await mcp.close();
  }
}

// CLI entry: `node src/workflows/modernize-php.js`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  runModernizationWorkflow({ onEvent: renderEvent })
    .then((final) => {
      console.log("\n=== FINAL REPORT ===\n");
      console.log(final);
    })
    .catch((err) => {
      console.error("\nWorkflow failed:", err.message);
      process.exit(1);
    });
}
