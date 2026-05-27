# AI Agent · MCP Tool-Use · Legacy PHP Modernizer

A provider-agnostic AI agent that uses **Model Context Protocol (MCP)** tools to
read, search, and rewrite a legacy PHP codebase into a hardened, modern version.
Ships with a streaming **CLI REPL** and a **web UI** that renders the ReAct
loop live.

> Built as a focused demonstration of: tool-using LLM agents, the MCP protocol,
> provider abstraction (Gemini + OpenAI), event-driven streaming, and a thin
> fullstack delivery surface.

---

## Architecture

```
        CLI REPL            Web UI (Express + SSE)        Workflow
        src/cli/            src/web/                       src/workflows/
            └────────────────────┬──────────────────────────┘
                                 ▼
                       ┌───────────────────┐
                       │       Agent       │   ReAct loop · history · events
                       │     src/agent/    │
                       └────┬─────────┬────┘
                  tools(MCP)│         │ provider
                            ▼         └──────▶  Gemini | OpenAI  (src/providers/)
                  ┌──────────────────┐
                  │    MCP Client    │   adapts tools; lists resources & prompts
                  │  src/mcp/client  │
                  └─────────┬────────┘
                            │ spawns over stdio (JSON-RPC)
                            ▼
  ──────────────────────────────────────────────────────────────────────────
   MCP Server — src/mcp/server.js   (spawned as a separate process)
  ──────────────────────────────────────────────────────────────────────────
   TOOLS (20)
     filesystem  read_file  write_file  edit_file  list_directory
                 create_directory  file_info  delete_path  move_path  preview_changes
     search      search_code (literal/regex)     find_files (glob)
     git         git_status   git_diff   git_log
     shell       run_command  (allowlist + no shell + timeout)
     php/sec     php_lint     security_scan     security_report (before/after)
     undo        list_backups     restore_backup
   RESOURCES     project://structure          file:///{+path}
   PROMPTS       modernize_file               security_review
  ──────────────────────────────────────────────────────────────────────────
   every path is sandboxed to the project root (safeResolve); tools carry MCP
   annotations (readOnly / destructive / idempotent / openWorld hints); writes
   auto-snapshot for undo; the Agent gates destructive tools behind approval
  ──────────────────────────────────────────────────────────────────────────
```

**Why this layout matters:**

| Concern | Where it lives | Why it's isolated |
|---|---|---|
| LLM call format (Gemini vs OpenAI) | `src/providers/*` | Swap providers without touching the agent |
| ReAct loop & history | `src/agent/Agent.js` | Loop logic is provider-agnostic |
| Tools (grouped by domain) | `src/mcp/tools/*` | Each module self-registers onto the server; add a category without editing the others |
| Resources & prompts | `src/mcp/resources.js`, `prompts.js` | The other two MCP primitives — read-only context and reusable prompt templates |
| Sandbox & process exec | `src/mcp/lib/sandbox.js` | One place owns path confinement, the dir walk, and no-shell process spawning |
| MCP server wiring | `src/mcp/server.js` | Separate process, plain MCP wire format — works with this agent, MCP Inspector, Claude Desktop, IDEs |
| Tool transport | `src/mcp/client.js` | Stdio today; swap to HTTP/SSE/WebSocket with one line |
| Presentation | `src/cli/`, `src/web/` | Both consume the same event stream from the agent |

---

## What the agent can do

It uses MCP-served filesystem tools to operate on the project. The headline
workflow (`npm run demo`) is end-to-end legacy modernization:

1. Lists `legacy/` to find PHP files.
2. Reads each one and identifies vulnerabilities (SQL injection, hardcoded
   credentials, weak sessions, missing input validation).
3. Writes a hardened replacement under `modernized/` using PDO + prepared
   statements + `password_verify` + secure session cookies.
4. Emits a markdown security report listing what it fixed in each file.

The full ReAct loop — every model turn, every tool call, every tool result — is
visible in the CLI and streamed to the web UI over Server-Sent Events.

---

## MCP surface

The server exposes all three MCP primitives. Every tool declares
[annotations](https://modelcontextprotocol.io/) (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) so a host can reason about
what each tool does before calling it.

| Tool | Group | Annotation | What it does |
|---|---|---|---|
| `read_file` | filesystem | read-only | Read a file (optional line range), with line numbers |
| `write_file` | filesystem | destructive | Write a file, creating parent dirs |
| `edit_file` | filesystem | destructive | Surgical find/replace (unique match or `replaceAll`) |
| `list_directory` | filesystem | read-only | List a directory with type + size |
| `create_directory` | filesystem | idempotent | Create a directory (recursive) |
| `file_info` | filesystem | read-only | Type, byte size, line count, mtime |
| `delete_path` | filesystem | destructive | Delete a file or directory (refuses root) |
| `move_path` | filesystem | destructive | Move / rename |
| `preview_changes` | filesystem | read-only | Dry-run **unified diff** of proposed content vs current file (no write) |
| `search_code` | search | read-only | Recursive substring **or regex** content search |
| `find_files` | search | read-only | Glob file discovery (`**`, `*`, `?`) |
| `git_status` | git | read-only | Porcelain working-tree status |
| `git_diff` | git | read-only | Unified diff (working tree or staged) |
| `git_log` | git | read-only | Compact recent commit history |
| `run_command` | shell | open-world | Run an **allowlisted** program with no shell + timeout |
| `php_lint` | php/sec | read-only | `php -l` syntax check |
| `security_scan` | php/sec | read-only | Heuristic vuln scan (SQLi, XSS, secrets, weak hashing…) |
| `security_report` | php/sec | read-only | Before/after severity comparison (e.g. legacy vs modernized) |
| `list_backups` | undo | read-only | List auto-snapshots taken before files were changed |
| `restore_backup` | undo | destructive | Roll a file back to a snapshot |

**Resources** — `project://structure` (the file tree) and `file:///{+path}`
(any project file, with a `list` callback that enumerates them for discovery).

**Prompts** — `modernize_file` and `security_review`: parameterized templates a
host can surface as slash commands.

> Try it live: `npm run web` lists all three in the sidebar; click a resource or
> prompt to preview it. Or point **MCP Inspector** / **Claude Desktop** at
> `npm run mcp`.

---

## Trust & audit

An autonomous agent that edits files is only useful if you can trust it. These
features make a run safe to start and easy to review:

- **Human-in-the-loop approval.** The Agent calls an `approve({name, args,
  annotations})` hook before every tool runs. The CLI auto-approves read-only
  tools and **prompts before destructive ones** (using the tool's
  `destructiveHint` annotation); toggle blanket approval with `/auto`. A denied
  call returns a tool error and the loop continues — the model adapts instead of
  crashing.
- **Automatic backups + undo.** `write_file` / `edit_file` / `delete_path` /
  `move_path` snapshot the prior version into `.agent-backups/` first.
  `list_backups` and `restore_backup` make any change reversible — no run is a
  one-way door.
- **Dry-run preview.** `preview_changes` returns a unified diff of a proposed
  rewrite without touching disk, so you (or the model) can review before writing.
- **Token & cost tracking.** Providers report token usage; the Agent accumulates
  it and emits a `usage` event with an estimated USD cost — shown in the CLI
  summary and the web timeline.
- **Run recorder.** Every workflow/CLI run is saved to `.agent-runs/<ts>.json`
  (full event trace) and `.md` (readable summary) for an audit trail.
- **Tests.** `npm test` runs a `node:test` suite (no extra deps) covering the
  sandbox, glob, diff, the security rules, the backup round-trip, and the full
  ReAct loop driven by a stub provider (approval + usage included).

---

## Quick start

```bash
npm install
cp .env.example .env          # then edit .env and add at least one API key
```

Pick one provider:

```dotenv
# Default: Gemini (generous free tier)
AGENT_PROVIDER=gemini
GEMINI_API_KEY=...

# Or OpenAI
AGENT_PROVIDER=openai
OPENAI_API_KEY=...
```

Then run any of:

```bash
npm run demo    # one-shot: run the modernization workflow end-to-end
npm run cli     # interactive REPL with live tool-call trace
npm run web     # browser UI at http://localhost:3000
```

---

## Demo flows

### Workflow demo (`npm run demo`)
Best for showing in an interview — it runs without any input and produces a
visible reasoning trace plus real generated files under `modernized/`.

### REPL (`npm run cli`)
Free-form. Try:
- `List the files in legacy/ and tell me what each one does.`
- `Read legacy/legacy_sample.php and identify every security issue.`
- `Search the project for SQL queries that concatenate user input.`
- `Rewrite legacy/legacy_sample.php as modernized/SecureLogin.php.`

Commands: `/reset`, `/tools`, `/resources`, `/prompts`, `/auto` (toggle approval), `/exit`.

### Web UI (`npm run web`)
- Sidebar lists every MCP **tool** (with annotation badges), **resource**, and
  **prompt** — fetched from the live MCP server. Click a resource or prompt to
  preview its content.
- Timeline renders every `tool_call`/`tool_result`/`assistant_text`/`final`
  event as it streams from the backend.
- One-click example prompts (security scan, glob search, modernize + lint, git diff).

---

## Project structure

```
src/
  agent/
    Agent.js          # ReAct loop, history, approval hook, usage, events
    events.js         # AgentEvent enum
    cost.js           # token → USD estimate
    recorder.js       # persist a run's trace to .agent-runs/
  providers/
    GeminiProvider.js # Google Gemini, native function-calling
    OpenAIProvider.js # OpenAI chat.completions, native tool-use
    index.js          # createProvider() factory driven by AGENT_PROVIDER
  mcp/
    server.js         # Wires all capabilities onto one McpServer, starts stdio
    client.js         # Spawns server, adapts tools + lists resources/prompts
    lib/
      sandbox.js      # safeResolve, dir walk, no-shell process exec, glob
    tools/
      filesystem.js   # read/write/edit/list/create/info/delete/move/preview
      search.js       # search_code (regex), find_files (glob)
      git.js          # git_status / git_diff / git_log
      shell.js        # run_command (allowlisted, no shell, timeout)
      php.js          # php_lint, security_scan, security_report
      backup.js       # list_backups, restore_backup (undo)
    resources.js      # project://structure, file:///{+path}
    prompts.js        # modernize_file, security_review
  workflows/
    modernize-php.js  # Headline end-to-end demo
  cli/
    repl.js           # Interactive REPL (approval prompts, /auto)
    render.js         # ANSI rendering of AgentEvents
  web/
    server.js         # Express + Server-Sent Events
    public/
      index.html      # Single-file UI: chat + tool-call timeline
test/                 # node:test suite (npm test)
legacy/               # Unsafe sample input
modernized/           # Agent-generated output
.agent-backups/       # Auto-snapshots for undo (gitignored)
.agent-runs/          # Saved run traces (gitignored)
```

---

## Design notes worth discussing in the interview

- **Why MCP and not just in-process function tools?**
  MCP defines a transport-agnostic protocol for tool exposure. The same tools
  this agent uses could be served to Claude Desktop, Cursor, or a remote agent
  with no changes. The agent treats the tools as a black box behind
  `client.listTools()` / `client.callTool()`.

- **Why a provider abstraction?**
  Tool-calling formats differ wildly (Gemini's `functionDeclarations` vs
  OpenAI's `tools[].function`). The `Agent` only knows the neutral shape
  `{ name, description, parameters, handler }` — providers translate.

- **Why an event stream instead of return values?**
  An agent run can take 20+ seconds and 8+ tool calls. Returning only the
  final text is a bad demo and a worse UX. The same `onEvent` callback drives
  the CLI's ANSI renderer and the web UI's SSE stream — one source of truth.

- **Sandbox boundary.** `lib/sandbox.js` resolves every path against the project
  root and rejects anything that escapes it — prompt injection that tries to
  exfiltrate `~/.ssh/id_rsa` won't reach disk.

- **`run_command` is defense-in-depth, not a raw shell.** Allowlist of programs
  + arguments passed as an argv array + **no shell** (so `;`, `|`, `$()`,
  backticks, and globbing are never interpreted) + cwd locked to the project
  root + a hard timeout + a bounded output buffer. The disallowed-command and
  path-escape paths are both exercised in testing.

- **Tool annotations.** Every tool ships `readOnly/destructive/idempotent/
  openWorld` hints, so a host can decide (e.g.) to auto-approve read-only tools
  and gate destructive ones — surfaced as badges in the web UI.

- **All three MCP primitives.** Tools *do* things; **resources** expose
  read-only context (`project://structure`, `file:///{+path}`); **prompts** are
  reusable templates (`modernize_file`, `security_review`). The same server
  works unchanged with MCP Inspector or Claude Desktop.

- **`security_scan` is honest.** It flags the legacy SQL injection as HIGH but
  does *not* flag a PDO prepared statement — so "scan before, scan after" is a
  real before/after, not theater.

- **Retry/backoff.** `GeminiProvider` wraps every call in exponential backoff
  for 429/503/quota errors — Gemini's free tier returns these frequently
  during a long demo.

---

## What's deliberately out of scope

- No per-session state on the web server — conversation history is in-process.
- No auth on the web UI — assumes localhost demo.
- Interactive approval is wired into the **CLI**; the web UI auto-approves
  (a localhost demo). The Agent's `approve` hook is the extension point — a
  production web UI would round-trip the approval over the event channel.
- No streaming of intra-turn tokens (events are per agent step). The web UI
  could be upgraded to token-level streaming by switching providers to their
  streaming APIs.
