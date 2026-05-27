import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";

import { registerFilesystemTools } from "../src/mcp/tools/filesystem.js";
import { registerBackupTools } from "../src/mcp/tools/backup.js";
import { registerPhpTools } from "../src/mcp/tools/php.js";

// A minimal stand-in for McpServer that just captures registered tool handlers,
// so we can call them directly without spawning the server over stdio.
function collectTools(...registerFns) {
  const tools = {};
  const server = {
    registerTool: (name, _config, handler) => (tools[name] = handler),
    registerResource: () => {},
    registerPrompt: () => {},
  };
  for (const fn of registerFns) fn(server);
  return {
    call: async (name, args) => {
      const res = await tools[name](args, {});
      const text = (res.content ?? []).map((c) => c.text).join("\n");
      return { text, isError: Boolean(res.isError) };
    },
  };
}

const T = collectTools(registerFilesystemTools, registerBackupTools, registerPhpTools);
const TMP = ".agent-test-tmp/note.txt";

test.after(async () => {
  await fs.rm(".agent-test-tmp", { recursive: true, force: true });
});

test("path escape is rejected by a tool handler", async () => {
  const r = await T.call("read_file", { filePath: "../../etc/passwd" });
  assert.ok(r.isError);
  assert.match(r.text, /escapes project root/);
});

test("write → edit → preview → backup → restore round trip", async () => {
  let r = await T.call("write_file", { filePath: TMP, content: "alpha\nbeta\n" });
  assert.ok(!r.isError);

  // preview is a dry run: it must not change the file
  r = await T.call("preview_changes", { filePath: TMP, newContent: "alpha\nGAMMA\n" });
  assert.match(r.text, /\+GAMMA/);
  assert.equal(await fs.readFile(".agent-test-tmp/note.txt", "utf-8"), "alpha\nbeta\n");

  // edit creates a backup of the prior version
  r = await T.call("edit_file", { filePath: TMP, oldText: "beta", newText: "gamma" });
  assert.ok(!r.isError);
  assert.equal(await fs.readFile(".agent-test-tmp/note.txt", "utf-8"), "alpha\ngamma\n");

  const list = await T.call("list_backups", {});
  const idMatch = list.text.match(/^(\S+)\s.*note\.txt/m);
  assert.ok(idMatch, "a backup for note.txt should be listed");

  // restore reverts to the pre-edit content
  r = await T.call("restore_backup", { id: idMatch[1] });
  assert.ok(!r.isError);
  assert.equal(await fs.readFile(".agent-test-tmp/note.txt", "utf-8"), "alpha\nbeta\n");
});

test("edit_file refuses an ambiguous match", async () => {
  await T.call("write_file", { filePath: TMP, content: "x\nx\n" });
  const r = await T.call("edit_file", { filePath: TMP, oldText: "x", newText: "y" });
  assert.ok(r.isError);
  assert.match(r.text, /matched 2 times/);
});

test("security_scan reports the legacy SQL injection as HIGH", async () => {
  const r = await T.call("security_scan", { targetPath: "legacy" });
  assert.match(r.text, /HIGH/);
  assert.match(r.text, /sql-injection/);
});

test("security_report shows HIGH issues resolved from legacy to modernized", async () => {
  const r = await T.call("security_report", { before: "legacy", after: "modernized" });
  assert.match(r.text, /# Security report/);
  assert.match(r.text, /resolved/);
});
