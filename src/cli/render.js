import { AgentEvent } from "../agent/events.js";

// Tiny ANSI palette - avoids a chalk dependency. Honors NO_COLOR.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const color = {
  dim: c("2"),
  bold: c("1"),
  cyan: c("36"),
  green: c("32"),
  yellow: c("33"),
  red: c("31"),
  magenta: c("35"),
  blue: c("34"),
};

function truncate(s, n = 400) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}${color.dim(`… (${s.length - n} more chars)`)}` : s;
}

export function renderEvent(ev) {
  switch (ev.type) {
    case AgentEvent.Start:
      console.log(`\n${color.bold(color.blue("▶ user"))}  ${ev.prompt}`);
      break;
    case AgentEvent.Step:
      console.log(color.dim(`\n— step ${ev.step}/${ev.maxSteps} —`));
      break;
    case AgentEvent.AssistantText:
      if (ev.text?.trim()) console.log(`${color.cyan("◆ assistant")}  ${ev.text}`);
      break;
    case AgentEvent.ToolCall: {
      const args = JSON.stringify(ev.args);
      console.log(`${color.yellow("→ tool")}  ${color.bold(ev.name)}  ${color.dim(truncate(args, 200))}`);
      break;
    }
    case AgentEvent.ToolDenied:
      console.log(`${color.red("⛔ denied")}  ${color.bold(ev.name)} ${color.dim("(blocked by approval policy)")}`);
      break;
    case AgentEvent.ToolResult: {
      const tag = ev.ok ? color.green("✓ result") : color.red("✗ result");
      console.log(`${tag}  ${color.bold(ev.name)}\n${color.dim(truncate(ev.content, 600))}`);
      break;
    }
    case AgentEvent.Usage: {
      const cost = ev.costUsd != null ? ` · ~$${ev.costUsd.toFixed(5)}` : "";
      console.log(
        color.dim(
          `\nⓘ ${ev.steps} steps · ${ev.toolCalls} tool calls · ${ev.totalTokens} tokens (in ${ev.inputTokens}/out ${ev.outputTokens})${cost}`
        )
      );
      break;
    }
    case AgentEvent.Final:
      console.log(`\n${color.green(color.bold("● final"))}\n${ev.text}\n`);
      break;
    case AgentEvent.Error:
      console.error(`${color.red("‼ error")}  ${ev.message}`);
      break;
  }
}
