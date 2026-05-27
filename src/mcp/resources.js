import fs from "fs/promises";
import path from "path";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ROOT, safeResolve, relPath, walk } from "./lib/sandbox.js";

/**
 * MCP *resources* — read-only context the host can attach to a conversation,
 * distinct from tools (which perform actions). We expose two:
 *
 *   project://structure   a static resource: the project file tree
 *   file:///{+path}        a templated resource: any project file by path
 *
 * Surfacing both shows the resource model end-to-end: a fixed URI and a
 * parameterized URI template with a `list` callback for discovery.
 */
export function registerResources(server) {
  server.registerResource(
    "project-structure",
    "project://structure",
    {
      title: "Project structure",
      description: "The project's file tree (excludes node_modules, .git, build output).",
      mimeType: "text/plain",
    },
    async (uri) => {
      const tree = await buildTree(ROOT);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: tree }] };
    }
  );

  server.registerResource(
    "project-file",
    // {+path} (reserved expansion) matches slashes, so file:///src/agent/Agent.js
    // routes here; a bare {path} would only match a single path segment.
    new ResourceTemplate("file:///{+path}", {
      // Enumerate readable project files so clients can browse available resources.
      list: async () => {
        const resources = [];
        await walk(ROOT, (full) => {
          const rel = relPath(full);
          resources.push({ uri: `file:///${rel}`, name: rel, mimeType: guessMime(rel) });
        });
        resources.sort((a, b) => a.name.localeCompare(b.name));
        return { resources: resources.slice(0, 500) };
      },
    }),
    {
      title: "Project file",
      description: "Read any UTF-8 file in the project by its relative path, e.g. file:///src/agent/Agent.js",
    },
    async (uri) => {
      // Take the path from the URI itself rather than the template variable so a
      // path with slashes round-trips cleanly.
      const rel = decodeURIComponent(uri.pathname.replace(/^\/+/, ""));
      const text = await fs.readFile(safeResolve(rel), "utf-8");
      return { contents: [{ uri: uri.href, mimeType: guessMime(rel), text }] };
    }
  );
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
      ".php": "application/x-php", ".md": "text/markdown", ".html": "text/html",
      ".css": "text/css", ".txt": "text/plain",
    }[ext] || "text/plain"
  );
}

// Render an indented directory tree, skipping the usual noise directories.
async function buildTree(dir, prefix = "", depth = 0) {
  if (depth > 6) return "";
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  entries = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  let out = "";
  for (const e of entries) {
    out += `${prefix}${e.isDirectory() ? "📁 " : "📄 "}${e.name}\n`;
    if (e.isDirectory()) out += await buildTree(path.join(dir, e.name), prefix + "  ", depth + 1);
  }
  return out;
}
