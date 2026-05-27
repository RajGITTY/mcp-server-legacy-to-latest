import fs from "fs/promises";
import path from "path";
import { AgentEvent } from "./events.js";

// Each run is saved here as a JSON trace + a human-readable markdown summary, so
// an autonomous run leaves an audit trail. Dot-prefixed, so the agent's own
// tools never list/search it.
const RUNS_DIR = path.join(process.cwd(), ".agent-runs");

/**
 * Wrap an agent run to capture its full event stream and persist it.
 * Usage: const r = createRecorder({prompt, provider}); agent.run(p,{onEvent:r.onEvent}); await r.save();
 */
export function createRecorder({ prompt = "", provider = "" } = {}) {
  const events = [];
  const startedAt = new Date();
  return {
    onEvent: (ev) => events.push({ at: Date.now(), ...ev }),
    save: async () => {
      try {
        await fs.mkdir(RUNS_DIR, { recursive: true });
        const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
        const base = path.join(RUNS_DIR, stamp);
        const meta = { startedAt: startedAt.toISOString(), provider, prompt, events };
        await fs.writeFile(`${base}.json`, JSON.stringify(meta, null, 2), "utf-8");
        await fs.writeFile(`${base}.md`, toMarkdown(meta), "utf-8");
        return { json: `${base}.json`, md: `${base}.md` };
      } catch {
        return null; // recording is best-effort, never breaks a run
      }
    },
  };
}

function toMarkdown({ startedAt, provider, prompt, events }) {
  const out = [`# Agent run — ${startedAt}`, "", `**Provider:** ${provider}`, "", `**Prompt:** ${prompt}`, "", "## Trace", ""];
  for (const ev of events) {
    switch (ev.type) {
      case AgentEvent.Step: out.push(`### Step ${ev.step}/${ev.maxSteps}`); break;
      case AgentEvent.AssistantText: if (ev.text?.trim()) out.push(`- 💬 ${ev.text.trim()}`); break;
      case AgentEvent.ToolCall: out.push(`- 🔧 \`${ev.name}\` ${trunc(JSON.stringify(ev.args), 160)}`); break;
      case AgentEvent.ToolDenied: out.push(`- ⛔ denied \`${ev.name}\``); break;
      case AgentEvent.ToolResult: out.push(`  - ${ev.ok ? "✅" : "❌"} ${trunc(ev.content, 200)}`); break;
      case AgentEvent.Usage:
        out.push("", "## Usage", `- steps: ${ev.steps}, tool calls: ${ev.toolCalls}`,
          `- tokens: ${ev.totalTokens} (in ${ev.inputTokens} / out ${ev.outputTokens})`,
          ev.costUsd != null ? `- est. cost: $${ev.costUsd.toFixed(5)}` : "");
        break;
      case AgentEvent.Final: out.push("", "## Final answer", "", ev.text || ""); break;
      case AgentEvent.Error: out.push("", "## Error", ev.message); break;
    }
  }
  return out.filter((l) => l !== undefined).join("\n") + "\n";
}

function trunc(s, n) {
  s = String(s ?? "").replace(/\n/g, " ");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
