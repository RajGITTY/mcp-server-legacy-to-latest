import { z } from "zod";
import { ok, guard, runProcess } from "../lib/sandbox.js";

/**
 * Allowlist of programs run_command may execute. Everything else is rejected
 * before a process is ever spawned. These are all real executables (resolvable
 * cross-platform via PATH), so we can run them with NO shell — the single most
 * important control here, since it means nothing in `args` is ever interpreted
 * by a shell (no `;`, `|`, `$()`, backticks, globbing, redirection).
 */
const ALLOWED = new Set(["php", "node", "git"]);

const MAX_TIMEOUT_MS = 60_000;

/**
 * A deliberately constrained command runner. The interview talking point:
 * defense in depth — allowlist + no shell + argv array (not a string) +
 * cwd locked to the project root + a hard timeout + bounded output buffer.
 */
export function registerShellTools(server) {
  server.registerTool(
    "run_command",
    {
      title: "Run command (sandboxed)",
      description:
        `Run an allowlisted program (${[...ALLOWED].join(", ")}) with arguments, in the project root, ` +
        "with no shell and a timeout. Arguments are passed as an array and never shell-interpreted. " +
        "Returns exit code, stdout, and stderr.",
      inputSchema: {
        command: z.string().describe(`Program to run; one of: ${[...ALLOWED].join(", ")}`),
        args: z.array(z.string()).default([]).describe("Arguments, passed verbatim (no shell expansion)"),
        timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).default(15000),
      },
      // openWorldHint: this tool reaches outside the server's own state.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ command, args, timeoutMs }) => {
      const program = command.trim();
      if (!ALLOWED.has(program)) {
        throw new Error(`command "${program}" is not allowlisted (allowed: ${[...ALLOWED].join(", ")})`);
      }
      const { stdout, stderr, code, timedOut, spawnError } = await runProcess(program, args, { timeout: timeoutMs });
      if (spawnError) throw new Error(`${program} is not installed or not on PATH`);

      const parts = [`$ ${program} ${args.join(" ")}`.trim(), `exit code: ${code}${timedOut ? " (timed out)" : ""}`];
      if (stdout.trim()) parts.push("--- stdout ---", stdout.trimEnd());
      if (stderr.trim()) parts.push("--- stderr ---", stderr.trimEnd());
      return ok(parts.join("\n"));
    })
  );
}
