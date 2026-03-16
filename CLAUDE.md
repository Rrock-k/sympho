# Sympho

Autonomous agent orchestrator inspired by OpenAI Symphony.
Polls issue trackers, dispatches coding agents (claude-code) in isolated per-issue workspaces.

## Architecture

- **Orchestrator** (`src/orchestrator.ts`) — polling loop, dispatch, concurrency control, retries, reconciliation
- **AgentRunner** (`src/agent/agent-runner.ts`) — manages claude-code process, multi-turn loop per issue
- **Workspace** (`src/workspace/workspace.ts`) — per-issue directory isolation, lifecycle hooks, path safety
- **Tracker** (`src/tracker/`) — abstract issue tracker interface
  - `tracker.ts` — interface definition
  - `linear.ts` — Linear GraphQL adapter
  - `memory.ts` — in-memory adapter for tests
- **Workflow** (`src/workflow.ts`) — parses WORKFLOW.md (YAML frontmatter + Liquid prompt template), file watcher
- **PromptBuilder** (`src/prompt-builder.ts`) — renders Liquid templates with issue context via liquidjs
- **Config** (`src/config.ts`) — typed configuration from WORKFLOW.md frontmatter via Zod, env var resolution
- **CLI** (`src/cli.ts`) — entry point, arg parsing, signal handling
- **Types** (`src/types.ts`) — core domain types (Issue, RunningEntry, RetryEntry, AgentEvent, etc.)

## Commands

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (dev mode)
npm run start    # Run compiled JS
npm run lint     # Type-check without emitting
npm test         # Run vitest tests
```

## Key Design Decisions

- TypeScript + Node.js (consistency with agents-arena ecosystem)
- WORKFLOW.md lives in the target repo (teams version prompt + config with code)
- claude-code as primary agent (via CLI spawning, --output-format stream-json)
- Multi-turn: uses --resume <session_id> for continuation turns
- Tracker is abstract — Linear adapter ships first, Memory for tests, others pluggable
- Private-first: standalone daemon, with future arena adapter for community mode
- Config validated with Zod, supports $VAR env var substitution
- Liquid templates (liquidjs) with strict mode for prompt rendering
- In-memory orchestrator state, no persistent DB — recovers via tracker polling on restart
