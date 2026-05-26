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
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   ┌─────────────┐         ┌────────────────┐        ┌──────────────┐   │
│   │  CLI REPL   │         │   Web UI       │        │  Workflow    │   │
│   │ src/cli/    │         │  Express + SSE │        │  modernize-  │   │
│   └──────┬──────┘         └────────┬───────┘        │   php.js     │   │
│          │                         │                 └──────┬───────┘   │
│          └──────────────┬──────────┴────────────────────────┘           │
│                         ▼                                               │
│                ┌──────────────────┐                                     │
│                │     Agent        │  ReAct loop, history, event stream  │
│                │  src/agent/      │                                     │
│                └────┬─────────┬───┘                                     │
│                     │         │                                         │
│         tools ◀─────┘         └─────▶  provider                         │
│         (MCP)                          (Gemini | OpenAI)                │
│           │                                  │                          │
│           ▼                                  ▼                          │
│   ┌───────────────┐                ┌─────────────────────┐              │
│   │  MCP Client   │  stdio (JSON-RPC)│  GeminiProvider   │              │
│   │ src/mcp/      │ ◀──────────────▶│  OpenAIProvider   │              │
│   │  client.js    │                 └─────────────────────┘             │
│   └───────┬───────┘                                                     │
│           │ spawns                                                      │
│           ▼                                                             │
│   ┌───────────────────────────────┐                                     │
│   │  MCP Server (separate proc)   │  read_file, write_file,             │
│   │  src/mcp/server.js            │  list_directory, search_code,       │
│   └───────────────────────────────┘  create_directory                   │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

**Why this layout matters:**

| Concern | Where it lives | Why it's isolated |
|---|---|---|
| LLM call format (Gemini vs OpenAI) | `src/providers/*` | Swap providers without touching the agent |
| ReAct loop & history | `src/agent/Agent.js` | Loop logic is provider-agnostic |
| Tools | `src/mcp/server.js` | Run in a separate process, addressable over MCP — same wire format as any MCP client (Claude Desktop, IDEs, etc.) |
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

Commands: `/reset`, `/tools`, `/exit`.

### Web UI (`npm run web`)
- Sidebar lists every MCP tool the agent has access to (fetched from the live
  MCP server).
- Timeline renders every `tool_call`/`tool_result`/`assistant_text`/`final`
  event as it streams from the backend.
- One-click example prompts.

---

## Project structure

```
src/
  agent/
    Agent.js          # ReAct loop, history, event emission
    events.js         # AgentEvent enum
  providers/
    GeminiProvider.js # Google Gemini, native function-calling
    OpenAIProvider.js # OpenAI chat.completions, native tool-use
    index.js          # createProvider() factory driven by AGENT_PROVIDER
  mcp/
    server.js         # MCP server: read_file, write_file, list_directory,
                      #             search_code, create_directory
    client.js         # Spawns server over stdio, adapts MCP tools to Agent
  workflows/
    modernize-php.js  # Headline end-to-end demo
  cli/
    repl.js           # Interactive REPL
    render.js         # ANSI rendering of AgentEvents
  web/
    server.js         # Express + Server-Sent Events
    public/
      index.html      # Single-file UI: chat + tool-call timeline

legacy/               # Unsafe sample input
modernized/           # Agent-generated output
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

- **Sandbox boundary.** `server.js` resolves every path against the project
  root and rejects anything that escapes it — prompt injection that tries to
  exfiltrate `~/.ssh/id_rsa` won't reach disk.

- **Retry/backoff.** `GeminiProvider` wraps every call in exponential backoff
  for 429/503/quota errors — Gemini's free tier returns these frequently
  during a long demo.

---

## What's deliberately out of scope

- No per-session state on the web server — conversation history is in-process.
- No auth on the web UI — assumes localhost demo.
- No streaming of intra-turn tokens (events are per agent step). The web UI
  could easily be upgraded to token-level streaming by switching providers to
  their streaming APIs.
