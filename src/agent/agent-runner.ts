/**
 * AgentRunner — manages claude-code process, multi-turn loop per issue.
 *
 * Uses `claude --output-format stream-json -p` to stream NDJSON events.
 * Supports multi-turn via `--resume <session_id>`.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Issue, AgentEvent, TokenUsage } from "../types.js";
import type { ServiceConfig } from "../config.js";
import type { Tracker } from "../tracker/tracker.js";
import { buildPrompt, buildContinuationPrompt } from "../prompt-builder.js";
import { prepareWorkspace, runLifecycleHook } from "../workspace/index.js";
import type { WorkflowDefinition } from "../types.js";
import { normalizeState } from "../config.js";
import { logger, issueLogger } from "../logger.js";

type Log = ReturnType<typeof issueLogger>;

export interface AgentRunResult {
  sessionId: string | null;
  turnCount: number;
  tokens: TokenUsage;
  costUsd: number;
}

export interface AgentRunOptions {
  config: ServiceConfig;
  workflow: WorkflowDefinition;
  issue: Issue;
  attempt: number | null;
  tracker: Tracker;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxTurns?: number;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const {
    config,
    workflow,
    issue,
    attempt,
    tracker,
    onEvent,
    signal,
  } = opts;
  const maxTurns = opts.maxTurns ?? config.agent.max_turns;
  const log = issueLogger(issue.id, issue.identifier);

  // 1. Prepare workspace
  const wsPath = await prepareWorkspace(config, issue.identifier, {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  });

  // 2. Run before_run hook
  const hookOk = await runLifecycleHook(config, "before_run", wsPath, {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  });
  if (!hookOk) {
    throw new Error("before_run hook failed");
  }

  const result: AgentRunResult = {
    sessionId: null,
    turnCount: 0,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
  };

  try {
    // 3. Multi-turn loop
    let currentIssue = issue;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (signal?.aborted) break;

      result.turnCount = turn;

      const prompt =
        turn === 1
          ? buildPrompt(workflow, currentIssue, attempt)
          : buildContinuationPrompt(turn, maxTurns);

      log.info({ turn, maxTurns, sessionId: result.sessionId }, "Starting agent turn");

      const turnResult = await runSingleTurn({
        config,
        prompt,
        workspacePath: wsPath,
        sessionId: result.sessionId,
        onEvent,
        signal,
      });

      // Accumulate results
      result.sessionId = turnResult.sessionId ?? result.sessionId;
      result.tokens.inputTokens += turnResult.tokens.inputTokens;
      result.tokens.outputTokens += turnResult.tokens.outputTokens;
      result.tokens.totalTokens += turnResult.tokens.totalTokens;
      result.costUsd += turnResult.costUsd;

      log.info(
        { turn, maxTurns, sessionId: result.sessionId, costUsd: result.costUsd },
        "Agent turn completed"
      );

      if (turnResult.error) {
        throw new Error(`Agent turn ${turn} failed: ${turnResult.error}`);
      }

      // Check if issue still active
      if (turn < maxTurns) {
        const shouldContinue = await checkIssueContinuation(currentIssue, tracker, config, log);
        if (!shouldContinue.continue) break;
        if (shouldContinue.refreshedIssue) {
          currentIssue = shouldContinue.refreshedIssue;
        }
      }
    }
  } finally {
    // 4. Run after_run hook (always, failure ignored)
    await runLifecycleHook(config, "after_run", wsPath, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    });
  }

  return result;
}

// --- Single turn execution ---

interface TurnResult {
  sessionId: string | null;
  tokens: TokenUsage;
  costUsd: number;
  error: string | null;
}

async function runSingleTurn(opts: {
  config: ServiceConfig;
  prompt: string;
  workspacePath: string;
  sessionId: string | null;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  const { config, prompt, workspacePath, sessionId, onEvent, signal } = opts;

  const args = buildClaudeArgs(config.agent.command, prompt, sessionId);
  const turnTimeoutMs = config.agent.turn_timeout_ms;

  return new Promise<TurnResult>((resolve, reject) => {
    const result: TurnResult = {
      sessionId: null,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      error: null,
    };

    const proc = spawn(args[0]!, args.slice(1), {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Close stdin immediately — non-interactive
    proc.stdin.end();

    // Turn timeout
    const timeout = setTimeout(() => {
      result.error = "turn_timeout";
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, turnTimeoutMs);

    // Abort signal
    const abortHandler = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    // Parse stdout as NDJSON
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const event = parseLine(line);
      if (!event) return;

      // Track session and usage
      if (event.sessionId) result.sessionId = event.sessionId;
      if (event.costUsd) result.costUsd = event.costUsd;
      if (event.usage) {
        result.tokens.inputTokens = Math.max(result.tokens.inputTokens, event.usage.inputTokens);
        result.tokens.outputTokens = Math.max(result.tokens.outputTokens, event.usage.outputTokens);
        result.tokens.totalTokens = Math.max(result.tokens.totalTokens, event.usage.totalTokens);
      }

      if (event.type === "result" && event.subtype === "error") {
        result.error = event.error ?? "unknown_agent_error";
      }

      onEvent?.(event);
    });

    // Capture stderr for diagnostics
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 10_000) stderrBuf = stderrBuf.slice(-5_000);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);

      if (code !== 0 && !result.error) {
        result.error = `process_exit_${code ?? "unknown"}`;
      }

      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
      result.error = `spawn_error: ${err.message}`;
      resolve(result);
    });
  });
}

// --- Helpers ---

function buildClaudeArgs(command: string, prompt: string, sessionId: string | null): string[] {
  // Base command: split on spaces (simple, handles "claude --output-format stream-json -p")
  const parts = command.split(/\s+/);

  // Add resume flag if we have a session
  if (sessionId) {
    parts.push("--resume", sessionId);
  }

  // Add prompt as the last argument
  parts.push(prompt);

  return parts;
}

function parseLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;

    const event: AgentEvent = {
      type: String(raw.type ?? "unknown"),
      subtype: raw.subtype ? String(raw.subtype) : undefined,
      raw,
    };

    // Extract session_id from result events
    if (raw.session_id) event.sessionId = String(raw.session_id);

    // Extract cost
    if (typeof raw.cost_usd === "number") event.costUsd = raw.cost_usd;

    // Extract usage
    const usage = raw.usage as Record<string, unknown> | undefined;
    if (usage) {
      event.usage = {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
      };
    }

    // Extract error
    if (raw.error) event.error = String(raw.error);

    // Extract content
    if (typeof raw.content === "string") event.content = raw.content;

    return event;
  } catch {
    return null;
  }
}

async function checkIssueContinuation(
  issue: Issue,
  tracker: Tracker,
  config: ServiceConfig,
  log: Log
): Promise<{ continue: boolean; refreshedIssue?: Issue }> {
  try {
    const refreshed = await tracker.fetchIssueStatesByIds([issue.id]);
    const updated = refreshed.find((i) => i.id === issue.id);

    if (!updated) {
      log.info("Issue no longer found in tracker, stopping");
      return { continue: false };
    }

    const activeStates = new Set(config.tracker.active_states.map(normalizeState));
    if (activeStates.has(normalizeState(updated.state))) {
      log.info({ state: updated.state }, "Issue still active, continuing");
      return { continue: true, refreshedIssue: updated };
    }

    log.info({ state: updated.state }, "Issue no longer active, stopping");
    return { continue: false };
  } catch (err) {
    log.error({ error: (err as Error).message }, "Failed to refresh issue state");
    return { continue: false };
  }
}
