import fs from "fs/promises";
import { z } from "zod";
import { safeResolve, relPath, ok, guard, walk, globToRegExp } from "../lib/sandbox.js";

/**
 * Code navigation tools: substring/regex content search and glob file discovery.
 * Both are read-only and skip node_modules/.git (see walk()).
 */
export function registerSearchTools(server) {
  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Recursive content search across the project. Treats query as a literal substring by default, " +
        "or as a regular expression when useRegex:true. Returns file:line: matched line.",
      inputSchema: {
        query: z.string().describe("Substring or regular expression to search for"),
        dirPath: z.string().default(".").describe("Directory to search in"),
        useRegex: z.boolean().default(false).describe("Interpret query as a JavaScript regular expression"),
        ignoreCase: z.boolean().default(false).describe("Case-insensitive match"),
        maxResults: z.number().int().min(1).max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ query, dirPath, useRegex, ignoreCase, maxResults }) => {
      const flags = ignoreCase ? "i" : "";
      const matcher = useRegex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

      const matches = [];
      await walk(safeResolve(dirPath), async (filePath) => {
        if (matches.length >= maxResults) return;
        let content;
        try {
          content = await fs.readFile(filePath, "utf-8");
        } catch {
          return; // unreadable / binary
        }
        const rel = relPath(filePath);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (matcher.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      });
      return ok(matches.length ? matches.join("\n") : "No matches found.");
    })
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files (glob)",
      description:
        "Find files by glob pattern relative to a directory. Supports ** (any depth), * (within a segment), and ?. " +
        "Example: src/**/*.js",
      inputSchema: {
        pattern: z.string().describe("Glob pattern, e.g. **/*.php or src/**/*.js"),
        dirPath: z.string().default(".").describe("Base directory to search from"),
        maxResults: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ pattern, dirPath, maxResults }) => {
      const base = safeResolve(dirPath);
      const re = globToRegExp(pattern);
      const baseRel = relPath(base);
      const hits = [];
      await walk(base, async (filePath) => {
        if (hits.length >= maxResults) return;
        const rel = relPath(filePath);
        // Match the pattern against the path relative to the search base.
        const candidate = baseRel === "." ? rel : rel.slice(baseRel.length + 1);
        if (re.test(candidate)) hits.push(rel);
      });
      hits.sort();
      return ok(hits.length ? hits.join("\n") : "No files matched.");
    })
  );
}
