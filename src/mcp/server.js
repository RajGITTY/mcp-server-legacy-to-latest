import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();

// All tools confine paths to ROOT to prevent the agent (or a prompt injection)
// from escaping the working directory.
function safeResolve(rel) {
  const full = path.resolve(ROOT, rel ?? ".");
  if (!full.startsWith(ROOT)) throw new Error(`Path escapes project root: ${rel}`);
  return full;
}

function ok(text) { return { content: [{ type: "text", text }] }; }
function fail(err) {
  return { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true };
}

const server = new McpServer({ name: "engineering-tools", version: "2.0.0" });

server.registerTool(
  "read_file",
  {
    description: "Read a UTF-8 file from the project. Returns file contents with line numbers.",
    inputSchema: { filePath: z.string().describe("Path relative to project root") },
  },
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(safeResolve(filePath), "utf-8");
      const numbered = content.split("\n").map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
      return ok(numbered);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "write_file",
  {
    description: "Write a UTF-8 file (creates parent directories). Overwrites if it exists.",
    inputSchema: {
      filePath: z.string().describe("Path relative to project root"),
      content: z.string().describe("Full file contents to write"),
    },
  },
  async ({ filePath, content }) => {
    try {
      const full = safeResolve(filePath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      return ok(`Wrote ${content.length} bytes to ${filePath}`);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_directory",
  {
    description: "List entries in a directory (non-recursive). Returns name and type per line.",
    inputSchema: { dirPath: z.string().default(".").describe("Path relative to project root") },
  },
  async ({ dirPath }) => {
    try {
      const entries = await fs.readdir(safeResolve(dirPath), { withFileTypes: true });
      const lines = entries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => `${e.isDirectory() ? "DIR " : "FILE"}  ${e.name}`)
        .sort();
      return ok(lines.join("\n") || "(empty)");
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "search_code",
  {
    description: "Recursive substring search across the project (skips node_modules/.git). Returns matches with file:line and the matched line.",
    inputSchema: {
      query: z.string().describe("Substring to search for"),
      dirPath: z.string().default(".").describe("Directory to search in"),
      maxResults: z.number().int().min(1).max(200).default(50),
    },
  },
  async ({ query, dirPath, maxResults }) => {
    try {
      const start = safeResolve(dirPath);
      const matches = [];
      await walk(start, async (filePath) => {
        if (matches.length >= maxResults) return;
        let content;
        try { content = await fs.readFile(filePath, "utf-8"); } catch { return; }
        const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (lines[i].includes(query)) matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      });
      return ok(matches.length ? matches.join("\n") : "No matches found.");
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "create_directory",
  {
    description: "Create a directory (recursive). No-op if it already exists.",
    inputSchema: { dirPath: z.string().describe("Path relative to project root") },
  },
  async ({ dirPath }) => {
    try {
      await fs.mkdir(safeResolve(dirPath), { recursive: true });
      return ok(`Created ${dirPath}`);
    } catch (e) { return fail(e); }
  }
);

async function walk(dir, visit) {
  const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build"]);
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp] engineering-tools server ready (root=${ROOT})`);
