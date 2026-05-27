# Context Graph

A navigational map of this repo: modules, how they depend on each other, the
contracts that flow between them, and the runtime paths. Use it to find where a
concern lives before diving into a file.

Project: **AI Agent · MCP Tool-Use · Legacy PHP Modernizer** (`ai-agent-mcp-modernizer` v2.0.0)
ES modules, Node, no build step. Source under [src/](src/).

---

## Module dependency graph

Arrows point from a module to what it imports/depends on. Three entry points
(workflow, CLI, web) all converge on the same `Agent`, which fans out to a
provider and to an MCP server (running as a separate process) that exposes
tools, resources, and prompts.

```
                 ┌──────────────────────── entry points ────────────────────────┐
                 │                                                                │
   workflows/modernize-php.js        cli/repl.js                  web/server.js
        │  │  │  │                      │  │  │  │                   │  │  │
        │  │  │  └── cli/render.js ◀────┘  │  │  └── cli/render.js    │  │  (SSE → browser
        │  │  │                            │  │                       │  │   public/index.html)
        ▼  ▼  ▼                            ▼  ▼                       ▼  ▼
     ┌───────────────────────────────────────────────────────────────────────┐
     │ agent/Agent.js  ─▶ events.js (enum) · cost.js (token→$) · approve() hook │
     │ agent/recorder.js  persists each run's trace to .agent-runs/            │
     └───────────────────────────────────────────────────────────────────────┘
        │                                   │
        │ tools[]                           │ provider
        ▼                                   ▼
  mcp/client.js                     providers/index.js  (createProvider factory)
        │ spawns (stdio JSON-RPC)           │   (step() also returns token usage)
        ▼                                   ├──▶ providers/GeminiProvider.js  → @google/generative-ai
  mcp/server.js  ◀── registers ──┐          └──▶ providers/OpenAIProvider.js  → openai
        │                        │
        │ each module self-registers onto the server:
        ├─ tools/filesystem.js   ┐  (write/edit/delete/move auto-snapshot; preview_changes)
        ├─ tools/search.js       │
        ├─ tools/git.js          ├─▶ all import  mcp/lib/sandbox.js
        ├─ tools/shell.js        │   (safeResolve · walk · runProcess · glob ·
        ├─ tools/php.js          │    snapshot/restore · unifiedDiff)
        ├─ tools/backup.js       ┘
        ├─ resources.js   (project://structure, file:///{+path})
        └─ prompts.js     (modernize_file, security_review)
```

Every entry point also imports `dotenv/config`, plus `createProvider` +
`connectMcpTools` to wire the agent together.

---

## Module responsibilities

| Module | File | Responsibility | Depends on |
|---|---|---|---|
| **Agent** | [src/agent/Agent.js](src/agent/Agent.js) | Bounded ReAct loop, history, tool dispatch, **approval gate**, **usage accumulation**, event emission. | `events.js`, `cost.js` |
| **Events** | [src/agent/events.js](src/agent/events.js) | `AgentEvent` enum — the vocabulary every consumer subscribes to. | — |
| **Cost** | [src/agent/cost.js](src/agent/cost.js) | `estimateCost(model, usage)` — token → USD from a small price table. | — |
| **Recorder** | [src/agent/recorder.js](src/agent/recorder.js) | Captures a run's event stream; saves JSON + markdown to `.agent-runs/`. | `events.js` |
| **Provider factory** | [src/providers/index.js](src/providers/index.js) | `createProvider(name)` picks Gemini/OpenAI from `AGENT_PROVIDER`. | both providers |
| **Gemini provider** | [src/providers/GeminiProvider.js](src/providers/GeminiProvider.js) | Neutral `{messages, tools}` ↔ Gemini function-calling. Backoff on 429/503/quota; strips unsupported schema keys. | `@google/generative-ai` |
| **OpenAI provider** | [src/providers/OpenAIProvider.js](src/providers/OpenAIProvider.js) | Same contract via `chat.completions` + native tool-use. | `openai` |
| **MCP client** | [src/mcp/client.js](src/mcp/client.js) | Spawns the server over stdio; adapts tools to the Agent shape; lists resources/prompts; exposes `readResource`/`getPrompt`. | SDK client, `server.js` |
| **MCP server** | [src/mcp/server.js](src/mcp/server.js) | `buildServer()` wires every capability module onto one `McpServer`; starts stdio when run directly. | SDK, all tool/resource/prompt modules |
| **Sandbox/helpers** | [src/mcp/lib/sandbox.js](src/mcp/lib/sandbox.js) | `ROOT`, `safeResolve`, `walk`, `runProcess` (no-shell), `globToRegExp`, `snapshot`/`listBackups`/`restoreBackup`, `unifiedDiff`, `ok`/`fail`/`guard`. | `fs`, `child_process` |
| **Filesystem tools** | [src/mcp/tools/filesystem.js](src/mcp/tools/filesystem.js) | `read_file`, `write_file`, `edit_file`, `list_directory`, `create_directory`, `file_info`, `delete_path`, `move_path`, `preview_changes`. Mutating tools auto-snapshot first. | `lib/sandbox.js`, `zod` |
| **Search tools** | [src/mcp/tools/search.js](src/mcp/tools/search.js) | `search_code` (literal/regex), `find_files` (glob). | `lib/sandbox.js`, `zod` |
| **Git tools** | [src/mcp/tools/git.js](src/mcp/tools/git.js) | `git_status`, `git_diff`, `git_log` (read-only, via `runProcess`). | `lib/sandbox.js`, `zod` |
| **Shell tool** | [src/mcp/tools/shell.js](src/mcp/tools/shell.js) | `run_command` — allowlist + no shell + timeout. | `lib/sandbox.js`, `zod` |
| **PHP/security tools** | [src/mcp/tools/php.js](src/mcp/tools/php.js) | `php_lint` (`php -l`), `security_scan` (heuristic vuln `RULES`), `security_report` (before/after). Exports `scanText`/`RULES` for tests. | `lib/sandbox.js`, `zod` |
| **Backup/undo tools** | [src/mcp/tools/backup.js](src/mcp/tools/backup.js) | `list_backups`, `restore_backup` — roll back auto-snapshots. | `lib/sandbox.js`, `zod` |
| **Resources** | [src/mcp/resources.js](src/mcp/resources.js) | `project://structure` (tree) + `file:///{+path}` template with a `list` callback. | SDK `ResourceTemplate`, `lib/sandbox.js` |
| **Prompts** | [src/mcp/prompts.js](src/mcp/prompts.js) | `modernize_file`, `security_review` parameterized templates. | `zod` |
| **Workflow** | [src/workflows/modernize-php.js](src/workflows/modernize-php.js) | Headline demo: legacy→modern PHP, scan + lint loop (maxSteps 20). | Agent, client, factory, render |
| **CLI REPL** | [src/cli/repl.js](src/cli/repl.js) | Interactive prompt; `/reset`, `/tools`, `/resources`, `/prompts`, `/exit`. | Agent, client, factory, render |
| **Renderer** | [src/cli/render.js](src/cli/render.js) | Maps `AgentEvent`s to ANSI terminal output. Honors `NO_COLOR`. | `events.js` |
| **Web server** | [src/web/server.js](src/web/server.js) | Express; SSE chat stream; `/api/meta`, `/api/resource`, `/api/prompt`. | Agent, client, factory, express |
| **Web UI** | [src/web/public/index.html](src/web/public/index.html) | Chat + live timeline; sidebar of tools (annotation badges), resources, prompts with click-to-preview. | (browser) |

---

## Key contracts (the data that flows across edges)

**Neutral message** (history in `Agent.messages`):
`{ role: "system"|"user"|"assistant"|"tool", content, ... }`. Providers attach
private fields (`_geminiParts`, `_openaiToolCalls`) on assistant messages and
round-trip them; the Agent never inspects these.

**Tool descriptor** (Agent → provider, produced by `mcp/client.js`):
`{ name, description, parameters /* JSON Schema */, annotations, handler(args) -> string }`.

**Provider step contract** — both providers implement
`step({ messages, tools }) -> { text, toolCalls: [{id,name,args}], assistantMessage, usage: {inputTokens, outputTokens} }`.

**Approval hook** — `Agent({ approve })` where
`approve({ name, args, annotations }) -> boolean`. Called before every tool runs;
`false` returns a tool error instead of executing. Default approves all.

**AgentEvent stream** (`events.js`) — emitted via `onEvent`, the single source
of truth for all three UIs:
`start · step · assistant_text · tool_call · tool_denied · tool_result · usage · final · error`.
The `usage` event carries `{steps, toolCalls, inputTokens, outputTokens, totalTokens, costUsd}`.

**MCP results** (server side, from `lib/sandbox.js` helpers):
tools return `{ content:[{type:"text",text}], isError? }`; resources return
`{ contents:[{uri,mimeType,text}] }`; prompts return `{ messages:[{role,content:{type:"text",text}}] }`.

**Tool annotations** — each tool carries `readOnlyHint` / `destructiveHint` /
`idempotentHint` / `openWorldHint`; the client passes them through and the web
UI renders them as badges.

---

## Runtime flows

**ReAct loop** ([Agent.js](src/agent/Agent.js)) — repeats up to `maxSteps`:
```
user prompt → provider.step() ─┬─ toolCalls?  → run each tool.handler() → push tool results → loop
                               └─ final text  → emit `final`, return
```

**Tool call path** (one hop):
```
Agent.run → approve({name,args,annotations})?  ──no──▶ tool_denied + error result
          │ yes
          ▼
          tool.handler(args)          [mcp/client.js]
          → client.callTool(MCP)      [stdio JSON-RPC]
          → tools/*.js handler        [separate process]
          → safeResolve / ALLOWED allowlist → (snapshot if mutating) → fs or runProcess → text back up
```

**Three ways to drive the Agent** (`npm run …`):
- `demo` → [modernize-php.js](src/workflows/modernize-php.js) → renders to terminal.
- `cli` → [repl.js](src/cli/repl.js) → renders to terminal.
- `web` → [server.js](src/web/server.js) → `POST /api/chat` streams SSE → browser timeline.
- `mcp` → runs the server standalone (for MCP Inspector / Claude Desktop).

---

## Cross-cutting concerns — where each lives

| Concern | Location |
|---|---|
| Provider swap (Gemini ↔ OpenAI) | `AGENT_PROVIDER` env → [providers/index.js](src/providers/index.js); Agent untouched |
| Tool transport swap (stdio → HTTP/SSE/WS) | [mcp/client.js](src/mcp/client.js) transport line only |
| Filesystem sandbox | `safeResolve()` in [mcp/lib/sandbox.js](src/mcp/lib/sandbox.js) — rejects paths escaping `ROOT` |
| Human-in-the-loop approval | `approve` hook in [Agent.js](src/agent/Agent.js); CLI prompts on `destructiveHint` ([repl.js](src/cli/repl.js)) |
| Undo / backups | `snapshot`/`restoreBackup` in [mcp/lib/sandbox.js](src/mcp/lib/sandbox.js); tools in [tools/backup.js](src/mcp/tools/backup.js); store in `.agent-backups/` |
| Token usage & cost | providers return `usage`; Agent accumulates; `estimateCost` in [agent/cost.js](src/agent/cost.js) |
| Run audit trail | [agent/recorder.js](src/agent/recorder.js) → `.agent-runs/<ts>.{json,md}` |
| Tests | [test/](test/) via `npm test` (`node:test`, no extra deps) |
| Shell safety | `ALLOWED` allowlist in [mcp/tools/shell.js](src/mcp/tools/shell.js) + `runProcess` runs with **no shell** |
| Process execution | `runProcess()` in [mcp/lib/sandbox.js](src/mcp/lib/sandbox.js) (used by git/shell/php tools) |
| Vulnerability rules | `RULES` in [mcp/tools/php.js](src/mcp/tools/php.js) |
| Tool error handling | `guard()` wrapper in [mcp/lib/sandbox.js](src/mcp/lib/sandbox.js) — turns throws into MCP error results |
| Retry / backoff | `withRetry()` in [GeminiProvider.js](src/providers/GeminiProvider.js) (429/503/quota) |
| Schema compatibility | `stripUnsupportedSchemaKeys()` in [GeminiProvider.js](src/providers/GeminiProvider.js) |
| Loop bound | `maxSteps` per entry point (demo 20, cli/web 12) |
| Config | [.env](.env) (`AGENT_PROVIDER`, `*_API_KEY`, `*_MODEL`, `PORT`) — template in [.env.example](.env.example) |
| Conversation state | In-process on `Agent.messages`; web has no per-session isolation |

---

## Data directories (not code, but part of the graph)

- [legacy/](legacy/) — unsafe sample PHP input; the agent is told never to modify it.
  `security_scan legacy` reports a HIGH SQL injection + LOW input-handling notes.
- [modernized/](modernized/) — agent-generated hardened output (PDO, prepared
  statements, `password_verify`, secure sessions). Written by `write_file`;
  `security_scan` no longer reports the HIGH finding here (prepared statements).
- [test/](test/) — `node:test` suite (`npm test`).
- `.agent-backups/`, `.agent-runs/` — runtime artifacts (snapshots + run traces),
  both gitignored and dot-prefixed so the agent's own tools never list them.

---

## Where to start for common tasks

- **Change the loop / tool-dispatch behavior** → [Agent.js](src/agent/Agent.js)
- **Add a new LLM provider** → implement the `step()` contract, register in [providers/index.js](src/providers/index.js)
- **Add a tool** → add it to the right `tools/*.js` module (or a new one wired in [server.js](src/mcp/server.js)); the client auto-discovers it
- **Add a vulnerability rule** → append to `RULES` in [tools/php.js](src/mcp/tools/php.js)
- **Add an allowlisted command** → `ALLOWED` in [tools/shell.js](src/mcp/tools/shell.js) (must be a real executable for no-shell exec)
- **Add a resource or prompt** → [resources.js](src/mcp/resources.js) / [prompts.js](src/mcp/prompts.js)
- **Change approval behavior** → the `approve` hook in [repl.js](src/cli/repl.js); the gate itself is in [Agent.js](src/agent/Agent.js)
- **Tune cost estimates** → `PRICES` in [agent/cost.js](src/agent/cost.js)
- **Change what a run trace looks like** → `toMarkdown` in [agent/recorder.js](src/agent/recorder.js)
- **Add a test** → [test/](test/) (`*.test.js`); use the fake-server collector in [test/tools.test.js](test/tools.test.js) or the `StubProvider` in [test/agent.test.js](test/agent.test.js)
- **Change how output looks** → [render.js](src/cli/render.js) (terminal) or [index.html](src/web/public/index.html) (web)
- **Add a new event type** → [events.js](src/agent/events.js), then handle it in every consumer
