import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { safeResolve, relPath, ok, guard, formatBytes, fileExists, snapshot, unifiedDiff } from "../lib/sandbox.js";

/**
 * Core filesystem tools. Every path is sandboxed to the project root by
 * safeResolve(). Annotations advertise behavior to MCP clients: readOnlyHint
 * for inspectors, destructiveHint for mutating tools, idempotentHint where a
 * repeated call is a no-op.
 */
export function registerFilesystemTools(server) {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 text file. Returns contents with line numbers, optionally limited to a line range.",
      inputSchema: {
        filePath: z.string().describe("Path relative to project root"),
        startLine: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        endLine: z.number().int().min(1).optional().describe("Last line to return (inclusive)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ filePath, startLine, endLine }) => {
      const content = await fs.readFile(safeResolve(filePath), "utf-8");
      const lines = content.split("\n");
      const from = startLine ? startLine - 1 : 0;
      const to = endLine ?? lines.length;
      const numbered = lines
        .slice(from, to)
        .map((l, i) => `${String(from + i + 1).padStart(4)} | ${l}`)
        .join("\n");
      return ok(numbered || "(empty selection)");
    })
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description: "Write a UTF-8 file, creating parent directories. Overwrites if it exists.",
      inputSchema: {
        filePath: z.string().describe("Path relative to project root"),
        content: z.string().describe("Full file contents to write"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async ({ filePath, content }) => {
      const full = safeResolve(filePath);
      const existed = await fileExists(full);
      if (existed) await snapshot(filePath, "write"); // reversible overwrite
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      return ok(`${existed ? "Overwrote" : "Wrote"} ${formatBytes(Buffer.byteLength(content))} to ${filePath}${existed ? " (previous version backed up)" : ""}`);
    })
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file (find/replace)",
      description:
        "Surgically replace an exact substring in a file without rewriting the whole thing. " +
        "Fails if oldText is missing, or if it is ambiguous and replaceAll is false.",
      inputSchema: {
        filePath: z.string().describe("Path relative to project root"),
        oldText: z.string().min(1).describe("Exact text to find (include surrounding context to make it unique)"),
        newText: z.string().describe("Replacement text"),
        replaceAll: z.boolean().default(false).describe("Replace every occurrence instead of requiring a unique match"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(async ({ filePath, oldText, newText, replaceAll }) => {
      const full = safeResolve(filePath);
      const before = await fs.readFile(full, "utf-8");
      const count = before.split(oldText).length - 1;
      if (count === 0) throw new Error("oldText not found in file");
      if (count > 1 && !replaceAll) {
        throw new Error(`oldText matched ${count} times; pass replaceAll:true or add more context to make it unique`);
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
      await snapshot(filePath, "edit"); // reversible
      await fs.writeFile(full, after, "utf-8");
      return ok(`Replaced ${replaceAll ? count : 1} occurrence(s) in ${filePath} (previous version backed up)`);
    })
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List entries in a directory (non-recursive). Returns type, size, and name per line.",
      inputSchema: { dirPath: z.string().default(".").describe("Path relative to project root") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ dirPath }) => {
      const dir = safeResolve(dirPath);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = await Promise.all(
        entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map(async (e) => {
            if (e.isDirectory()) return `DIR              ${e.name}/`;
            const { size } = await fs.stat(path.join(dir, e.name));
            return `FILE  ${formatBytes(size).padStart(9)}  ${e.name}`;
          })
      );
      return ok(lines.join("\n") || "(empty)");
    })
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create directory",
      description: "Create a directory (recursive). No-op if it already exists.",
      inputSchema: { dirPath: z.string().describe("Path relative to project root") },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(async ({ dirPath }) => {
      await fs.mkdir(safeResolve(dirPath), { recursive: true });
      return ok(`Created ${dirPath}`);
    })
  );

  server.registerTool(
    "file_info",
    {
      title: "File info",
      description: "Return metadata for a file or directory: type, byte size, line count (text files), and modified time.",
      inputSchema: { filePath: z.string().describe("Path relative to project root") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ filePath }) => {
      const full = safeResolve(filePath);
      const st = await fs.stat(full);
      const info = {
        path: relPath(full),
        type: st.isDirectory() ? "directory" : "file",
        size: formatBytes(st.size),
        bytes: st.size,
        modified: st.mtime.toISOString(),
      };
      if (st.isFile() && st.size < 2 * 1024 * 1024) {
        try {
          const text = await fs.readFile(full, "utf-8");
          info.lines = text.split("\n").length;
        } catch {
          /* binary file — skip line count */
        }
      }
      return ok(JSON.stringify(info, null, 2));
    })
  );

  server.registerTool(
    "delete_path",
    {
      title: "Delete file or directory",
      description: "Delete a file, or a directory (recursive when recursive:true). Refuses to delete the project root.",
      inputSchema: {
        targetPath: z.string().describe("Path relative to project root"),
        recursive: z.boolean().default(false).describe("Allow deleting a non-empty directory"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async ({ targetPath, recursive }) => {
      const full = safeResolve(targetPath);
      if (relPath(full) === ".") throw new Error("refusing to delete the project root");
      await snapshot(targetPath, "delete"); // back up files before removal
      await fs.rm(full, { recursive, force: false });
      return ok(`Deleted ${targetPath} (backed up if it was a file)`);
    })
  );

  server.registerTool(
    "move_path",
    {
      title: "Move / rename",
      description: "Move or rename a file or directory. Creates the destination's parent directories.",
      inputSchema: {
        from: z.string().describe("Source path relative to project root"),
        to: z.string().describe("Destination path relative to project root"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(async ({ from, to }) => {
      const src = safeResolve(from);
      const dst = safeResolve(to);
      await snapshot(from, "move"); // restorable at the original path
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      return ok(`Moved ${from} -> ${to}`);
    })
  );

  server.registerTool(
    "preview_changes",
    {
      title: "Preview changes (dry run)",
      description:
        "Show a unified diff between a file's current contents and proposed new contents, WITHOUT writing. " +
        "Use this to review a rewrite before calling write_file.",
      inputSchema: {
        filePath: z.string().describe("Target path relative to project root"),
        newContent: z.string().describe("Proposed new contents"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ filePath, newContent }) => {
      const full = safeResolve(filePath);
      const current = (await fileExists(full)) ? await fs.readFile(full, "utf-8") : "";
      const diff = unifiedDiff(current, newContent, { path: filePath });
      if (!diff) return ok("(no changes — proposed content is identical)");
      const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
      const removed = (diff.match(/^-(?!--)/gm) || []).length;
      return ok(`${current === "" ? "(new file)\n" : ""}+${added} -${removed}\n\n${diff}`);
    })
  );
}
