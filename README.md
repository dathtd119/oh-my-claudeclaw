# oh-my-claudeclaw

A fork of [claudeclaw](https://github.com/dathtd119/claudeclaw) that adds multi-session architecture, per-job configuration, parallel execution, and intelligent Telegram routing.

## What's Different from Vanilla Claudeclaw

| Feature | claudeclaw | oh-my-claudeclaw |
|---------|-----------|-----------------|
| Sessions | Single shared session for everything | Per-agent session isolation with daily rotation |
| Execution | Serial queue (one job at a time) | Parallel execution across groups |
| Job config | schedule + notify only | agent, model, tools, effort, maxTurns |
| Agents | N/A | Modular agent-driven config (operator, secretary, etc.) |
| Channels | Hardcoded Telegram | Config-driven channel dict (Telegram, WhatsApp) |
| Telegram routing | All messages → same session | Local LLM classifier routes to agent sessions |
| Classification | N/A | Local Qwen 2B (~135ms) with Haiku fallback |
| Subagent detection | N/A | Per-agent keywords/LLM/hybrid strategy |
| Session rotation | Manual reset only | Auto-rotate at token threshold (120k default) |
| Token tracking | None | Estimates content tokens from JSONL transcripts |

## Core Architecture

### Modular Agent-Driven Configuration

`settings.json` is the single source of truth. Agent names are unique keys, channels are a separate dict, and agents reference channels by name.

```json
{
  "channels": {
    "system": { "type": "telegram", "token": "...", "chatId": 123 },
    "secretary": { "type": "telegram", "token": "...", "chatId": 123 }
  },
  "agents": {
    "operator": {
      "model": "sonnet",
      "channel": "system",
      "subagentDetection": { "enabled": false }
    },
    "secretary": {
      "model": "sonnet",
      "channel": "secretary",
      "subagentDetection": {
        "enabled": true,
        "strategy": "keywords",
        "tasks": {
          "whatsapp_read": { "keywords": ["whatsapp", "message", "chat"] },
          "obsidian_sync": { "keywords": ["obsidian", "postsale", "report"] }
        }
      }
    }
  },
  "localLlm": {
    "url": "http://localhost:9292/v1/chat/completions",
    "model": "qwen-2b",
    "timeout": 10000
  }
}
```

No hardcoded agent or channel names in code — everything is config-driven.

### Local LLM Offloading

Small tasks (classification, subagent detection) are offloaded to a local Qwen 2B model via [llama-swap](https://github.com/mostlygeek/llama-swap) (OpenAI-compatible endpoint):

- **Message classification**: Local LLM (~135ms, free) → Haiku fallback on failure
- **Subagent task detection**: Per-agent strategy — `keywords`, `llm`, or `hybrid`
- **Timeout**: 10s, graceful fallback to Haiku CLI on any error

### Job Frontmatter

```yaml
---
agent: secretary           # agent name → determines channel + model
schedule: "30 7 * * *"
recurring: true
model: haiku               # optional model override
tools: "Read,Bash,Skill,Task"
max_turns: 5               # optional turn limit
---
```

Jobs reference agents by name. Channel routing is automatic via `agents[name].channel`.

### Message Routing (send.sh)

```bash
# Agent-based routing (recommended)
send.sh agent secretary "📊 PostSale update"
send.sh agent operator "⚙️ System alert"

# Shorthand
send.sh secretary "message"
send.sh system "message"
```

`send.sh` reads `settings.json` dynamically: agent → channel name → credentials → Telegram API.

### Telegram Message Routing

1. **Reply-to routing**: If user replies to a bot message, route to the same session group
2. **Classifier**: Local LLM classifies as `secretary` or `general`, falls back to Haiku
3. **Fallback**: Default to `operator` agent

### Session Groups & Rotation

- Each agent gets its own daily session group (e.g., `secretary_2026-03-03`)
- When token count exceeds threshold (120k default), session is archived and rotated
- Jobs without `session_group` in frontmatter use agent name as group

```json
{
  "sessionRotation": {
    "threshold": 120000,
    "enabled": true
  }
}
```

### Subagent Detection

Per-agent configuration with three strategies:

| Strategy | Mechanism | Cost | Accuracy |
|----------|-----------|------|----------|
| `keywords` | Check keywords per task | Free | Medium |
| `llm` | Local Qwen 2B classify | Free (local) | High |
| `hybrid` | LLM first, keywords fallback | Free | High |

## API Endpoints (Web UI)

- `GET /api/sessions` — list active session groups with token counts
- `POST /api/sessions/:group/rotate` — force session rotation

## Installation

```bash
# As a Claude Code plugin (replaces claudeclaw)
claude plugin add dathtd119/oh-my-claudeclaw
```

## Architecture

```
src/
├── config.ts             # Channels/agents/localLlm config + parsing
├── local-llm.ts          # Local LLM client (Qwen 2B, 10s timeout, null fallback)
├── router.ts             # Message classifier (local LLM → Haiku) + subagent detection
├── runner.ts             # Agent-aware execution, per-group queues
├── session-registry.ts   # Multi-session storage + daily rotation
├── session-queries.ts    # Session lookup utilities
├── sessions.ts           # Backward-compatible shim → session-registry
├── subagent.ts           # Stateless subagent runner for external data
├── jobs.ts               # Extended frontmatter parsing (agent field)
├── commands/
│   ├── start.ts          # Daemon startup, localLlm init, hot-reload
│   └── telegram.ts       # Agent-aware routing, reply-to tracking
└── ui/
    └── server.ts         # Sessions API endpoints
```
