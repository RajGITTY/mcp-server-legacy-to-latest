import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";

// The project root every tool is confined to. All filesystem and process tools
// resolve user-supplied paths against this and reject anything that escapes it,
// so a prompt injection cannot read ~/.ssh/id_rsa or write outside the repo.
export const ROOT = process.cwd();

// Directories we never recurse into for search/listing/tree operations.
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".cache", "dist", "build", "coverage", "vendor",
]);

/**
 * Resolve a project-relative path to an absolute one, refusing to escape ROOT.
 * `path.resolve` collapses `..`, so `../../etc/passwd` is caught by the prefix
 * check. The trailing-separator guard stops `/root` matching `/root-evil`.
 */
export function safeResolve(rel) {
  const full = path.resolve(ROOT, rel ?? ".");
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  return full;
}

// Project-relative, forward-slashed path for display (stable across OSes).
export function relPath(full) {
  return path.relative(ROOT, full).split(path.sep).join("/") || ".";
}

// ---- MCP CallToolResult helpers -------------------------------------------
export function ok(text) {
  return { content: [{ type: "text", text: String(text) }] };
}
export function fail(err) {
  return {
    content: [{ type: "text", text: `Error: ${err?.message || err}` }],
    isError: true,
  };
}

/**
 * Wrap a tool body so every thrown error becomes a clean MCP error result
 * instead of crashing the server. Keeps each tool definition to its happy path.
 */
export function guard(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (e) {
      return fail(e);
    }
  };
}

// ---- Filesystem walk -------------------------------------------------------
/** Recursively visit every file under `dir`, skipping SKIP_DIRS and dotfiles. */
export async function walk(dir, visit) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

// ---- Process execution -----------------------------------------------------
/**
 * Run an external program with arguments, no shell (so nothing in `args` is
 * interpreted by a shell — the core of the run_command safety story). Always
 * resolves; the caller inspects exit code and streams rather than catching.
 */
export function runProcess(command, args = [], { cwd = ROOT, timeout = 15000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error?.code ?? 0,
          timedOut: Boolean(error?.killed && error?.signal === "SIGTERM"),
          spawnError: error && error.code === "ENOENT" ? error : null,
        });
      }
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

// ---- Glob ------------------------------------------------------------------
/**
 * Compile a glob pattern to a RegExp. Supports `**` (any depth), `*` (within a
 * segment), `?` (single char). Small, dependency-free, good enough for file
 * discovery in a demo codebase.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more path segments; bare `**` matches anything.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

// Human-readable byte size.
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function fileExists(full) {
  try {
    await fs.access(full);
    return true;
  } catch {
    return false;
  }
}

// ---- Backups / undo --------------------------------------------------------
// Before a tool overwrites/deletes/moves an existing file, we snapshot it here
// so the change is reversible. The dir is dot-prefixed, so walk()/listing skip
// it automatically (it never shows up in search/find/list results).
export const BACKUP_DIR = path.join(ROOT, ".agent-backups");
const INDEX_FILE = path.join(BACKUP_DIR, "index.json");

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * Copy an existing file into the backup store and record it. Best-effort: never
 * throws, so a snapshot failure can't break the tool that triggered it. Returns
 * the backup record, or null if there was nothing to back up.
 */
export async function snapshot(rel, reason = "modify") {
  try {
    const full = safeResolve(rel);
    const st = await fs.stat(full);
    if (!st.isFile()) return null; // only files are snapshotted
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const backupFile = path.join(BACKUP_DIR, `${id}.bak`);
    await fs.copyFile(full, backupFile);
    const index = await readIndex();
    const record = { id, path: relPath(full), reason, bytes: st.size, savedAt: new Date().toISOString() };
    index.push({ ...record, backupFile: path.basename(backupFile) });
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
    return record;
  } catch {
    return null;
  }
}

export async function listBackups() {
  const index = await readIndex();
  return index.map(({ backupFile, ...rest }) => rest).reverse(); // newest first
}

export async function restoreBackup(id) {
  const index = await readIndex();
  const rec = index.find((r) => r.id === id);
  if (!rec) throw new Error(`no backup with id "${id}"`);
  const backupFile = path.join(BACKUP_DIR, rec.backupFile);
  const dest = safeResolve(rec.path);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(backupFile, dest);
  return rec;
}

// ---- Unified diff (dependency-free, LCS-based) -----------------------------
/**
 * Produce a unified diff between two texts. Used by preview_changes so the
 * agent can show a dry-run before writing. Self-contained (no git, no deps) so
 * output is identical across platforms.
 */
export function unifiedDiff(oldText, newText, { path: label = "file", context = 3 } = {}) {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;
  const header = `--- a/${label}\n+++ b/${label}\n`;
  if (n * m > 4_000_000) return `${header}@@ files too large for inline diff (${n} vs ${m} lines) @@`;

  // LCS length table, then backtrack into an edit script.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);

  // Tag each op with its 1-based line numbers in a and b.
  let aLine = 1;
  let bLine = 1;
  const tagged = ops.map(([t, line]) => {
    const e = { t, line, a: aLine, b: bLine };
    if (t !== "+") aLine++;
    if (t !== "-") bLine++;
    return e;
  });

  // Group changes into hunks with `context` lines of surrounding equality.
  const changes = tagged.map((e, idx) => (e.t !== " " ? idx : -1)).filter((x) => x >= 0);
  if (!changes.length) return ""; // identical

  const hunks = [];
  let start = Math.max(0, changes[0] - context);
  let end = Math.min(tagged.length - 1, changes[0] + context);
  for (const c of changes.slice(1)) {
    if (c - context <= end + 1) {
      end = Math.min(tagged.length - 1, c + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, c - context);
      end = Math.min(tagged.length - 1, c + context);
    }
  }
  hunks.push([start, end]);

  let out = header;
  for (const [s, e] of hunks) {
    const slice = tagged.slice(s, e + 1);
    const al = slice.filter((x) => x.t !== "+").length;
    const bl = slice.filter((x) => x.t !== "-").length;
    const as = slice[0].a;
    const bs = slice[0].b;
    out += `@@ -${al ? as : as - 1},${al} +${bl ? bs : bs - 1},${bl} @@\n`;
    out += slice.map((x) => `${x.t}${x.line}`).join("\n") + "\n";
  }
  return out;
}
