#!/usr/bin/env node

/**
 * Arena cycle entry point — drop-in replacement for direct.js.
 *
 * Spawned by arena-runner via commandTemplate:
 *   node {loopdir}/dist/arena/entry.js --agent claude-code --spec-dir {specdir} --work-dir {workdir}
 *
 * This uses sympho's multi-turn agent loop with WORKFLOW.md support,
 * while speaking the arena contract: .arena/progress.json, .arena/done,
 * git commit/push, deploy.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProgressWriter } from "./progress-writer.js";
import { ArenaTracker } from "./arena-tracker.js";
import { runAgent } from "../agent/index.js";
import { loadConfig, parseConfig } from "../config.js";
import { loadWorkflowFile, parseWorkflowFile } from "../workflow.js";
import type { WorkflowDefinition } from "../types.js";
import type { ServiceConfig } from "../config.js";

// ── Parse args ────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, fallback = ""): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
}

const AGENT = getArg("agent", "claude-code");
const MODEL = getArg("model", "");
const SPEC_DIR = getArg("spec-dir", "/workspace/specs");
const WORK_DIR = getArg("work-dir", "/workspace");
const MAX_ITERATIONS = Number(process.env.DIRECT_MAX_ITERATIONS || "10");
const PUSH_BRANCH = process.env.ARENA_PUSH_BRANCH || `arena/project-${process.env.ARENA_PROJECT_ID || "unknown"}`;
const SECRETS_FILE = join(WORK_DIR, ".env.arena-secrets");
const COMPLETION_SIGNAL = "<promise>TASK_COMPLETE</promise>";
const DONE_FILE = join(WORK_DIR, ".arena", "done");

// ── Logging ───────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[sympho-cycle] [${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ── Secrets / env ─────────────────────────────────────────

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx)!] = line.slice(idx + 1);
  }
  return env;
}

function readAuthCache(): Record<string, string> {
  try {
    const raw = readFileSync(join(WORK_DIR, ".arena", "auth-refresh.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) env[k] = v;
    }
    return env;
  } catch {
    return {};
  }
}

// ── Git ───────────────────────────────────────────────────

function gitCommitAndPush(message: string): void {
  try {
    execSync("git add -A", { cwd: WORK_DIR, stdio: "pipe" });
    execSync(`git commit -m "${message}" --allow-empty`, { cwd: WORK_DIR, stdio: "pipe" });
    execSync(`git push origin ${PUSH_BRANCH}`, { cwd: WORK_DIR, stdio: "pipe", timeout: 60_000 });
    log("Git commit + push OK");
  } catch {
    log("Git commit/push failed (non-fatal)");
  }
}

// ── Deploy ────────────────────────────────────────────────

function deployApp(): void {
  log("Deploying app...");
  try {
    execSync("fuser -k 3000/tcp 2>/dev/null || true", { cwd: WORK_DIR, stdio: "pipe" });
  } catch { /* ignore */ }

  if (existsSync(join(WORK_DIR, "package.json"))) {
    try {
      execSync("npm install", { cwd: WORK_DIR, stdio: "pipe", timeout: 120_000 });
      execSync("setsid npm start </dev/null >/tmp/app.log 2>&1 &", {
        cwd: WORK_DIR,
        stdio: "pipe",
        env: { ...process.env, ...readEnvFile(SECRETS_FILE), PORT: "3000" },
        shell: "/bin/bash",
      });
      execSync("sleep 3", { stdio: "pipe" });
      try {
        execSync("curl -sf http://localhost:3000/health", { stdio: "pipe", timeout: 5000 });
        log("App deployed on :3000 (health OK)");
      } catch {
        log("App started (health check unavailable)");
      }
    } catch (err) {
      log(`App deployment failed: ${err}`);
    }
  }
}

// ── CLAUDE.md ─────────────────────────────────────────────

function ensureClaudeMd(): void {
  const path = join(WORK_DIR, "CLAUDE.md");
  if (existsSync(path)) return;

  writeFileSync(path, `# Project Instructions

Build the project described in the spec files under \`specs/\`.
Read **all** \`.md\` files in the \`specs/\` directory — each one describes a feature or requirement.

## IMPORTANT: Working Directory
- **All project files (package.json, src/, etc.) MUST be created in the current working directory** — NOT in any subdirectory.
- Do NOT create subdirectories like \`ARENA-1/\` or similar — work directly in the project root.

## Runtime Environment
- Running inside a Docker container (node:22-slim)
- \`sudo\` available for system packages (apt-get)
- App must be self-contained: \`npm start\` should start everything
- Network access available for npm install, API calls, etc.
- Git is pre-installed; commit frequently

## Requirements
- App must serve on port 3000 (\`process.env.PORT || 3000\`)
- Include a \`/health\` endpoint returning \`{"ok": true}\`
- Use environment variables from \`process.env\` for secrets
- Available secrets are in \`.env.arena-secrets\`
- If you need a missing secret: \`node /arena/request-secrets.js SECRET_KEY "What for"\`

## Completion
When the task is **fully complete**, run: \`touch ${DONE_FILE}\`
`);
}

// ── Build workflow / config ───────────────────────────────

function resolveWorkflow(): { workflow: WorkflowDefinition; config: ServiceConfig } {
  const workflowPath = join(WORK_DIR, "WORKFLOW.md");

  // If project has its own WORKFLOW.md, use it
  if (existsSync(workflowPath)) {
    log("Using project WORKFLOW.md");
    const workflow = loadWorkflowFile(workflowPath);
    const config = loadConfig(workflow);
    return { workflow, config };
  }

  // Otherwise build a default arena workflow
  log("No WORKFLOW.md found, using default arena config");
  const agentCmd = AGENT === "claude-code"
    ? `claude --print --dangerously-skip-permissions --output-format stream-json --verbose${MODEL ? ` --model ${MODEL}` : ""}`
    : `codex exec --dangerously-bypass-approvals-and-sandbox -C ${WORK_DIR}${MODEL ? ` --model ${MODEL}` : ""}`;

  const workflow: WorkflowDefinition = parseWorkflowFile(`---
tracker:
  kind: memory
workspace:
  root: ${WORK_DIR}
agent:
  command: "${agentCmd}"
  max_concurrent_agents: 1
  max_turns: ${MAX_ITERATIONS}
  turn_timeout_ms: 1800000
  stall_timeout_ms: 600000
---

You are building a project autonomously. Complete ALL tasks described in the specs.

IMPORTANT RULES:
- The app MUST serve on port 3000 (use process.env.PORT || 3000)
- Include a /health endpoint returning {"ok": true}
- Available project secrets are in .env.arena-secrets
- If you need a missing secret, call: node /arena/request-secrets.js SECRET_KEY "What this secret is for"
- When the task is FULLY complete and working, run: touch ${DONE_FILE}
- Do NOT mark completion until everything is implemented and functional

--- SPECS ---
{{ issue.description }}
`);

  const config = loadConfig(workflow);
  return { workflow, config };
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  log("Starting sympho arena cycle");
  log(`Agent: ${AGENT} | Model: ${MODEL} | Max iterations: ${MAX_ITERATIONS}`);
  log(`Work dir: ${WORK_DIR} | Spec dir: ${SPEC_DIR}`);

  // Inject auth + secrets into process.env so agent inherits them
  Object.assign(process.env, readAuthCache(), readEnvFile(SECRETS_FILE), { CI: "true" });

  ensureClaudeMd();

  const progress = new ProgressWriter(WORK_DIR);
  progress.clearDoneMarker();
  progress.write({ state: "planning", message: "Sympho initializing", iteration: 0 });

  const tracker = new ArenaTracker(SPEC_DIR, WORK_DIR);
  const { workflow, config } = resolveWorkflow();

  const candidates = await tracker.fetchCandidateIssues();
  if (candidates.length === 0) {
    log("No specs found, exiting");
    progress.write({ state: "error", message: "No spec files found" });
    process.exit(1);
  }

  const issue = candidates[0]!;
  log(`Working on: ${issue.identifier} — ${issue.title}`);

  let completed = false;
  const abortController = new AbortController();

  // Spec change detection
  let prevSpecHash = tracker.getSpecHash();

  // Run sympho agent loop
  let currentIteration = 0;
  try {
    const result = await runAgent({
      config,
      workflow,
      issue,
      attempt: null,
      tracker,
      maxTurns: MAX_ITERATIONS,
      workspacePath: WORK_DIR,
      signal: abortController.signal,
      onEvent: (event) => {
        // Update progress on every agent event
        const iteration = currentIteration || 1;

        if (event.type === "result") {
          currentIteration++;
          // Don't write completed for success — check done file first
        } else if (event.type === "assistant" && event.content) {
          progress.write({
            state: "coding",
            message: event.content.slice(0, 200),
            iteration,
          });

          // Check for legacy completion signal in output
          if (!completed && event.content.includes(COMPLETION_SIGNAL)) {
            log("Legacy completion signal detected — stopping agent");
            completed = true;
            abortController.abort();
          }
        } else if (event.type === "tool_use") {
          progress.write({
            state: "coding",
            message: `Using tool: ${(event.raw as any).name ?? "unknown"}`,
            iteration,
          });
        }

        // Check for .arena/done after each event
        if (!completed && progress.isDone()) {
          log("Completion file (.arena/done) detected — stopping agent");
          completed = true;
          abortController.abort();
        }

        // Live spec change detection
        if (tracker.refresh()) {
          const newHash = tracker.getSpecHash();
          log(`Specs changed mid-run (${prevSpecHash.slice(0, 8)} → ${newHash.slice(0, 8)})`);
          prevSpecHash = newHash;
        }
      },
    });

    // Final done file check
    if (progress.isDone()) {
      completed = true;
    }

    log(`Agent finished: ${result.turnCount} turns, $${result.costUsd.toFixed(4)}`);
  } catch (err) {
    log(`Agent error: ${(err as Error).message}`);
    progress.write({ state: "error", message: (err as Error).message });
  }

  // Post-run: commit, push, deploy
  progress.write({ state: "committing", message: "Committing changes", iteration: MAX_ITERATIONS });
  gitCommitAndPush(`feat: sympho agent run (${completed ? "completed" : "max iterations"})`);

  progress.write({ state: "deploying", message: "Deploying app", iteration: MAX_ITERATIONS });
  deployApp();

  gitCommitAndPush("chore: final state after deploy");

  if (completed) {
    progress.write({ state: "completed", message: "Task complete", iteration: MAX_ITERATIONS });
    progress.markDone();
    log("SUCCESS");
    process.exit(0);
  } else {
    progress.write({ state: "max_iterations", message: `Reached ${MAX_ITERATIONS} iterations`, iteration: MAX_ITERATIONS });
    log(`INCOMPLETE: max iterations (${MAX_ITERATIONS}) reached`);
    process.exit(1);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
