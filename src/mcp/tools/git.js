import { z } from "zod";
import { safeResolve, ok, guard, runProcess } from "../lib/sandbox.js";

// Run a git subcommand in the project root. Args are passed as an argv array
// (no shell), so a path argument can never be interpreted as a flag injection.
async function git(args) {
  const { stdout, stderr, code, spawnError } = await runProcess("git", args, { timeout: 15000 });
  if (spawnError) throw new Error("git is not installed or not on PATH");
  if (code !== 0) throw new Error(stderr.trim() || `git exited with code ${code}`);
  return stdout;
}

/**
 * Read-only git tools so the agent can inspect what it changed during a run —
 * the natural complement to write_file/edit_file in a modernization workflow.
 */
export function registerGitTools(server) {
  server.registerTool(
    "git_status",
    {
      title: "git status",
      description: "Show the working-tree status (porcelain): staged, modified, and untracked files.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => {
      const out = await git(["status", "--porcelain=v1", "--branch"]);
      return ok(out.trim() || "working tree clean");
    })
  );

  server.registerTool(
    "git_diff",
    {
      title: "git diff",
      description: "Show unified diff of unstaged changes, optionally for a single path. Use staged:true for the index.",
      inputSchema: {
        filePath: z.string().optional().describe("Limit the diff to this path (relative to project root)"),
        staged: z.boolean().default(false).describe("Diff the staged changes instead of the working tree"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ filePath, staged }) => {
      const args = ["diff"];
      if (staged) args.push("--cached");
      if (filePath) {
        safeResolve(filePath); // validate it stays inside the repo
        args.push("--", filePath);
      }
      const out = await git(args);
      return ok(out.trim() || "(no differences)");
    })
  );

  server.registerTool(
    "git_log",
    {
      title: "git log",
      description: "Show recent commit history as a compact one-line-per-commit log.",
      inputSchema: {
        maxCount: z.number().int().min(1).max(100).default(15).describe("Number of commits to show"),
        filePath: z.string().optional().describe("Limit history to this path"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ maxCount, filePath }) => {
      const args = ["log", `-n${maxCount}`, "--pretty=format:%h %ad %an %s", "--date=short"];
      if (filePath) {
        safeResolve(filePath);
        args.push("--", filePath);
      }
      const out = await git(args);
      return ok(out.trim() || "(no commits)");
    })
  );
}
