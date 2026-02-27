# oh-my-claudeclaw

A fork of [claudeclaw](https://github.com/dathtd119/claudeclaw) that adds multi-session architecture, per-job configuration, parallel execution, and intelligent Telegram routing.

## What's Different from Vanilla Claudeclaw

| Feature | claudeclaw | oh-my-claudeclaw |
|---------|-----------|-----------------|
| Sessions | Single shared session for everything | Per-group session isolation |
| Execution | Serial queue (one job at a time) | Parallel execution across groups |
| Job config | schedule + notify only | model, tools, effort, maxTurns, sessionGroup |
| Telegram routing | All messages → same session | Classifier routes to secretary/general sessions |
| Session rotation | Manual reset only | Auto-rotate at token threshold (120k default) |
| Token tracking | None | Estimates content tokens from JSONL transcripts |

## New Concepts

### Session Groups

Jobs and Telegram messages are assigned to **session groups**. Each group maintains its own Claude session, enabling:

- **Isolation**: Secretary work doesn't pollute general conversation context
- **Parallelism**: Different groups execute concurrently
- **Persistence**: Groups with `sessionGroup` in frontmatter resume their session; stateless jobs get fresh sessions

### Job Frontmatter Extensions

```yaml
---
schedule: "0 8 * * *"
recurring: true
notify: true
session_group: secretary    # persistent session group
model: haiku                # override default model
tools: "Read,Bash,Skill"    # restrict available tools
effort: low                 # claude --effort flag
max_turns: 5                # limit conversation turns
---
```

Jobs without `session_group` run stateless (no `--resume`, fully parallel).

### Telegram Message Routing

1. **Reply-to routing**: If user replies to a bot message, route to the same session group that produced it
2. **Classifier (Layer 1)**: Stateless Haiku call classifies message as `secretary` or `general`
3. **Fallback**: Default to `general` group

### Session Rotation

When a session group's token count exceeds the threshold (default 120k), the session is archived and a new one created. Configure in `settings.json`:

```json
{
  "sessionRotation": {
    "threshold": 120000,
    "enabled": true
  }
}
```

## API Endpoints (Web UI)

New endpoints added to the existing web dashboard:

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
├── session-registry.ts   # Multi-session storage + rotation
├── token-estimator.ts    # JSONL token estimation (~55ms/6MB)
├── router.ts             # Telegram message classifier + reply-to tracking
├── runner.ts             # RunOptions, per-group queues
├── sessions.ts           # Backward-compatible shim → session-registry
├── jobs.ts               # Extended frontmatter parsing
├── config.ts             # sessionRotation config
├── commands/
│   ├── start.ts          # Passes RunOptions to job execution
│   └── telegram.ts       # 3-layer routing, reply-to tracking
└── ui/
    └── server.ts         # Sessions API endpoints
```
