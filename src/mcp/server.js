import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

import { ROOT } from "./lib/sandbox.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerSearchTools } from "./tools/search.js";
import { registerGitTools } from "./tools/git.js";
import { registerShellTools } from "./tools/shell.js";
import { registerPhpTools } from "./tools/php.js";
import { registerBackupTools } from "./tools/backup.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

/**
 * "engineering-tools" MCP server.
 *
 * Exposes all three MCP primitives over stdio:
 *   - tools      filesystem, code search, git, sandboxed shell, PHP/security
 *   - resources  project structure + any file by URI
 *   - prompts    modernize_file, security_review
 *
 * Tools are grouped into modules under tools/; each registers itself onto the
 * shared server. The same server speaks plain MCP, so it works unchanged with
 * this project's agent, MCP Inspector, Claude Desktop, or any other MCP client.
 */
export function buildServer() {
  // The high-level McpServer advertises tools/resources/prompts capabilities
  // automatically as they are registered below.
  const server = new McpServer({ name: "engineering-tools", version: "2.0.0" });

  registerFilesystemTools(server); // read/write/edit/list/create/delete/move/info
  registerSearchTools(server); // search_code (regex), find_files (glob)
  registerGitTools(server); // git_status / git_diff / git_log
  registerShellTools(server); // run_command (allowlisted, no shell)
  registerPhpTools(server); // php_lint, security_scan, security_report
  registerBackupTools(server); // list_backups, restore_backup (undo)
  registerResources(server); // project://structure, file:///{+path}
  registerPrompts(server); // modernize_file, security_review

  return server;
}

// Start over stdio when this file is the process entry point — both `npm run
// mcp` and the client's subprocess spawn. Compare resolved native paths rather
// than file:// URL strings, which differ by a slash on Windows.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] engineering-tools ready over stdio (root=${ROOT})`);
}
