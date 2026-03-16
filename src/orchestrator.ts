/**
 * Orchestrator — polling loop, dispatch, concurrency control, retries, reconciliation.
 *
 * Owns the single authoritative in-memory runtime state.
 */

import type { Issue, RunningEntry, RetryEntry, TokenUsage, AgentEvent } from "./types.js";
import type { Tracker } from "./tracker/tracker.js";
import type { ServiceConfig } from "./config.js";
import type { WorkflowDefinition } from "./types.js";
import {
  loadConfig,
  validateConfigForDispatch,
  normalizeState,
  maxConcurrentForState,
} from "./config.js";
import { runAgent } from "./agent/index.js";
import { removeWorkspace } from "./workspace/index.js";
import { WorkflowStore } from "./workflow.js";
import { logger } from "./logger.js";
import { StatusWriter, formatElapsed } from "./status-writer.js";
import type { StatusSnapshot, StatusIssue } from "./status-writer.js";
import { dirname } from "node:path";

export interface OrchestratorOptions {
  workflowPath: string;
  trackerFactory: (config: ServiceConfig) => Tracker;
}

export class Orchestrator {
  private workflowStore: WorkflowStore;
  private trackerFactory: (config: ServiceConfig) => Tracker;

  // Runtime state
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retryAttempts = new Map<string, RetryEntry>();
  private completed = new Set<string>();
  private completedIssues = new Map<string, {
    identifier: string;
    title: string;
    costUsd: number;
    elapsed: string;
    turns: number;
    error: string | null;
  }>();
  private agentTotals: TokenUsage & { secondsRunning: number; costUsd: number } = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
    costUsd: 0,
  };

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private statusWriter: StatusWriter;
  private lastStatusFlushMs = 0;

  // Track all known task titles for status display
  private issueTitles = new Map<string, string>();

  constructor(opts: OrchestratorOptions) {
    this.workflowStore = new WorkflowStore(opts.workflowPath);
    this.trackerFactory = opts.trackerFactory;
    this.statusWriter = new StatusWriter(dirname(opts.workflowPath));
  }

  async start(): Promise<void> {
    logger.info("Sympho orchestrator starting");

    // Validate config on startup
    const config = this.getConfig();
    const err = validateConfigForDispatch(config);
    if (err) {
      throw new Error(`Config validation failed: ${err}`);
    }

    // Watch for workflow changes
    this.workflowStore.watch();

    // Startup cleanup
    await this.startupCleanup(config);

    // Immediate first tick then schedule
    this.stopped = false;
    await this.tick();
    this.scheduleTick();

    logger.info(
      {
        pollIntervalMs: config.polling.interval_ms,
        maxConcurrent: config.agent.max_concurrent_agents,
        tracker: config.tracker.kind,
      },
      "Sympho orchestrator running"
    );
  }

  async stop(): Promise<void> {
    logger.info("Stopping orchestrator");
    this.stopped = true;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all running agents
    for (const entry of this.running.values()) {
      entry.abortController.abort();
    }

    // Cancel all retry timers
    for (const entry of this.retryAttempts.values()) {
      clearTimeout(entry.timerHandle);
    }

    this.workflowStore.unwatch();
    logger.info("Orchestrator stopped");
  }

  getState() {
    const now = Date.now();
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
      },
      running: Array.from(this.running.values()).map((r) => ({
        issueId: r.issueId,
        issueIdentifier: r.issueIdentifier,
        state: r.issue.state,
        sessionId: r.sessionId,
        turnCount: r.turnCount,
        lastEvent: r.lastEvent,
        lastMessage: r.lastMessage,
        startedAt: r.startedAt.toISOString(),
        lastEventAt: r.lastEventAt?.toISOString() ?? null,
        tokens: r.tokens,
      })),
      retrying: Array.from(this.retryAttempts.values()).map((r) => ({
        issueId: r.issueId,
        issueIdentifier: r.identifier,
        attempt: r.attempt,
        dueAt: new Date(r.dueAtMs).toISOString(),
        error: r.error,
      })),
      agentTotals: {
        ...this.agentTotals,
        secondsRunning:
          this.agentTotals.secondsRunning +
          Array.from(this.running.values()).reduce(
            (sum, r) => sum + (now - r.startedAt.getTime()) / 1000,
            0
          ),
      },
    };
  }

  // --- Status ---

  private flushStatus(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatusFlushMs < 2000) return;
    this.lastStatusFlushMs = now;

    const snapshot = this.buildStatusSnapshot();
    this.statusWriter.write(snapshot);
  }

  private buildStatusSnapshot(): StatusSnapshot {
    const issues: StatusIssue[] = [];
    const config = this.getConfigSafe();
    const maxTurns = config?.agent.max_turns ?? 20;

    for (const entry of this.running.values()) {
      issues.push({
        issueId: entry.issueId,
        issueIdentifier: entry.issueIdentifier,
        title: entry.issue.title,
        status: "running",
        turn: entry.turnCount,
        maxTurns,
        costUsd: entry.costUsd,
        elapsed: formatElapsed(entry.startedAt),
        lastEvent: entry.lastEvent,
      });
    }

    for (const entry of this.retryAttempts.values()) {
      // Don't show retry as separate row if it's just a continuation check (error=null)
      // — it will appear as completed instead
      if (!entry.error) continue;
      issues.push({
        issueId: entry.issueId,
        issueIdentifier: entry.identifier,
        title: this.issueTitles.get(entry.issueId) ?? "",
        status: "retrying",
        attempt: entry.attempt,
        error: entry.error,
        retryAt: new Date(entry.dueAtMs).toLocaleTimeString(),
      });
    }

    // Show completed issues that are not currently running or retrying
    for (const [id, info] of this.completedIssues) {
      if (this.running.has(id)) continue;
      if (this.retryAttempts.has(id) && this.retryAttempts.get(id)!.error) continue;
      issues.push({
        issueId: id,
        issueIdentifier: info.identifier,
        title: info.title,
        status: info.error ? "failed" : "done",
        turn: info.turns,
        maxTurns,
        costUsd: info.costUsd,
        elapsed: info.elapsed,
        error: info.error,
      });
    }

    return {
      issues,
      totals: {
        costUsd: this.agentTotals.costUsd,
        secondsRunning: this.agentTotals.secondsRunning +
          Array.from(this.running.values()).reduce(
            (sum, r) => sum + (Date.now() - r.startedAt.getTime()) / 1000,
            0
          ),
      },
    };
  }

  // --- Private ---

  private getConfig(): ServiceConfig {
    const workflow = this.workflowStore.get();
    return loadConfig(workflow);
  }

  private getConfigSafe(): ServiceConfig | null {
    try {
      return this.getConfig();
    } catch {
      return null;
    }
  }

  private getTracker(config: ServiceConfig): Tracker {
    return this.trackerFactory(config);
  }

  private scheduleTick(): void {
    if (this.stopped) return;
    const config = this.getConfigSafe();
    const intervalMs = config?.polling.interval_ms ?? 30_000;
    this.pollTimer = setTimeout(() => this.tickLoop(), intervalMs);
  }

  private async tickLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Tick failed");
    }
    this.scheduleTick();
  }

  private async tick(): Promise<void> {
    const config = this.getConfigSafe();
    if (!config) {
      logger.warn("Config unavailable, skipping dispatch");
      return;
    }

    const tracker = this.getTracker(config);

    // 1. Reconcile running issues
    await this.reconcile(config, tracker);

    // 2. Validate config for dispatch
    const validationErr = validateConfigForDispatch(config);
    if (validationErr) {
      logger.warn({ error: validationErr }, "Config validation failed, skipping dispatch");
      return;
    }

    // 3. Fetch candidates
    let candidates: Issue[];
    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Failed to fetch candidates, skipping dispatch");
      return;
    }

    // 4. Sort candidates
    candidates = this.sortCandidates(candidates);

    // 5. Dispatch
    await this.dispatch(config, tracker, candidates);
    this.flushStatus(true);
  }

  private sortCandidates(issues: Issue[]): Issue[] {
    return issues.sort((a, b) => {
      // Priority ascending (null sorts last)
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;

      // Created at oldest first
      const ca = a.createdAt?.getTime() ?? Infinity;
      const cb = b.createdAt?.getTime() ?? Infinity;
      if (ca !== cb) return ca - cb;

      // Identifier lexicographic
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private async dispatch(config: ServiceConfig, tracker: Tracker, candidates: Issue[]): Promise<void> {
    const activeStates = new Set(config.tracker.active_states.map(normalizeState));
    const terminalStates = new Set(config.tracker.terminal_states.map(normalizeState));

    for (const issue of candidates) {
      if (this.stopped) break;

      // Eligibility checks
      if (!issue.id || !issue.identifier || !issue.title || !issue.state) continue;

      const normalized = normalizeState(issue.state);
      if (!activeStates.has(normalized)) continue;
      if (terminalStates.has(normalized)) continue;
      if (this.running.has(issue.id)) continue;
      if (this.claimed.has(issue.id)) continue;

      // Global concurrency
      if (this.running.size >= config.agent.max_concurrent_agents) break;

      // Per-state concurrency
      const stateLimit = maxConcurrentForState(config, issue.state);
      const stateRunning = Array.from(this.running.values()).filter(
        (r) => normalizeState(r.issue.state) === normalized
      ).length;
      if (stateRunning >= stateLimit) continue;

      // Blocker check for Todo state
      if (normalizeState(issue.state) === "todo" && issue.blockedBy.length > 0) {
        const hasNonTerminalBlocker = issue.blockedBy.some(
          (b) => b.state && !terminalStates.has(normalizeState(b.state))
        );
        if (hasNonTerminalBlocker) continue;
      }

      // Dispatch!
      this.dispatchIssue(config, tracker, issue, null);
    }
  }

  private dispatchIssue(config: ServiceConfig, tracker: Tracker, issue: Issue, attempt: number | null): void {
    const log = logger.child({ issueId: issue.id, issueIdentifier: issue.identifier });
    log.info({ attempt }, "Dispatching issue");

    this.claimed.add(issue.id);
    this.issueTitles.set(issue.id, issue.title);

    const abortController = new AbortController();
    const entry: RunningEntry = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issue,
      attempt,
      workspacePath: "",
      startedAt: new Date(),
      turnCount: 0,
      lastEvent: null,
      lastEventAt: null,
      lastMessage: null,
      sessionId: null,
      costUsd: this.completedIssues.get(issue.id)?.costUsd ?? 0,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      abortController,
    };
    this.running.set(issue.id, entry);

    const workflow = this.workflowStore.get();

    // Fire and forget — the run manages its own lifecycle
    runAgent({
      config,
      workflow,
      issue,
      attempt,
      tracker,
      signal: abortController.signal,
      onEvent: (event) => {
        this.handleAgentEvent(issue.id, event);
        this.flushStatus();
      },
    })
      .then((result) => {
        log.info(
          { sessionId: result.sessionId, turnCount: result.turnCount, costUsd: result.costUsd },
          "Agent run completed"
        );
        this.onWorkerExit(issue, null, result);
        this.flushStatus(true);
      })
      .catch((err) => {
        log.error({ error: (err as Error).message }, "Agent run failed");
        this.onWorkerExit(issue, (err as Error).message, null);
        this.flushStatus(true);
      });
  }

  private handleAgentEvent(issueId: string, event: AgentEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    entry.lastEvent = event.type;
    entry.lastEventAt = new Date();

    if (event.content) {
      entry.lastMessage = event.content.slice(0, 200);
    }

    if (event.sessionId) {
      entry.sessionId = event.sessionId;
    }

    if (event.costUsd) {
      entry.costUsd = event.costUsd;
    }

    // "result" events mark the end of a turn
    if (event.type === "result") {
      entry.turnCount++;
    }

    if (event.usage) {
      entry.tokens = {
        inputTokens: Math.max(entry.tokens.inputTokens, event.usage.inputTokens),
        outputTokens: Math.max(entry.tokens.outputTokens, event.usage.outputTokens),
        totalTokens: Math.max(entry.tokens.totalTokens, event.usage.totalTokens),
      };
    }
  }

  private onWorkerExit(issue: Issue, error: string | null, result: { turnCount: number; tokens: TokenUsage; costUsd: number } | null): void {
    const entry = this.running.get(issue.id);
    if (entry) {
      const runSeconds = (Date.now() - entry.startedAt.getTime()) / 1000;
      this.agentTotals.secondsRunning += runSeconds;
      if (result) {
        this.agentTotals.inputTokens += result.tokens.inputTokens;
        this.agentTotals.outputTokens += result.tokens.outputTokens;
        this.agentTotals.totalTokens += result.tokens.totalTokens;
        this.agentTotals.costUsd += result.costUsd;
      }

      // Save completed issue info for status display (accumulate cost across retries)
      const prev = this.completedIssues.get(issue.id);
      this.completedIssues.set(issue.id, {
        identifier: issue.identifier,
        title: issue.title,
        costUsd: entry.costUsd,
        elapsed: formatElapsed(entry.startedAt),
        turns: (prev?.turns ?? 0) + entry.turnCount,
        error,
      });
    }

    this.running.delete(issue.id);

    if (error) {
      // Schedule retry with backoff
      const currentRetry = this.retryAttempts.get(issue.id);
      const attempt = (currentRetry?.attempt ?? 0) + 1;
      const delay = Math.min(10_000 * Math.pow(2, attempt - 1), this.getConfigSafe()?.agent.max_retry_backoff_ms ?? 300_000);
      this.scheduleRetry(issue, attempt, delay, error);
    } else {
      // Normal exit — short continuation retry
      this.scheduleRetry(issue, 1, 1000, null);
      this.completed.add(issue.id);
    }
  }

  private scheduleRetry(issue: Issue, attempt: number, delayMs: number, error: string | null): void {
    // Cancel existing retry
    const existing = this.retryAttempts.get(issue.id);
    if (existing) {
      clearTimeout(existing.timerHandle);
    }

    const dueAtMs = Date.now() + delayMs;
    const timerHandle = setTimeout(() => this.handleRetry(issue.id), delayMs);

    this.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error,
    });

    logger.info(
      { issueId: issue.id, issueIdentifier: issue.identifier, attempt, delayMs, error },
      "Scheduled retry"
    );
  }

  private async handleRetry(issueId: string): Promise<void> {
    const retryEntry = this.retryAttempts.get(issueId);
    if (!retryEntry) return;

    this.retryAttempts.delete(issueId);

    const config = this.getConfigSafe();
    if (!config) {
      this.claimed.delete(issueId);
      return;
    }

    const tracker = this.getTracker(config);
    const activeStates = new Set(config.tracker.active_states.map(normalizeState));

    try {
      const candidates = await tracker.fetchCandidateIssues();
      const issue = candidates.find((c) => c.id === issueId);

      if (!issue) {
        logger.info({ issueId }, "Issue no longer a candidate, releasing claim");
        this.claimed.delete(issueId);
        return;
      }

      if (!activeStates.has(normalizeState(issue.state))) {
        logger.info({ issueId, state: issue.state }, "Issue no longer active, releasing claim");
        this.claimed.delete(issueId);
        return;
      }

      // Check global slots
      if (this.running.size >= config.agent.max_concurrent_agents) {
        this.scheduleRetry(issue, retryEntry.attempt, 5000, "no available orchestrator slots");
        return;
      }

      this.dispatchIssue(config, tracker, issue, retryEntry.attempt);
    } catch (err) {
      logger.error({ issueId, error: (err as Error).message }, "Retry handler failed");
      this.claimed.delete(issueId);
    }
  }

  private async reconcile(config: ServiceConfig, tracker: Tracker): Promise<void> {
    if (this.running.size === 0) return;

    const runningIds = Array.from(this.running.keys());

    // Stall detection
    const now = Date.now();
    const stallTimeoutMs = config.agent.stall_timeout_ms;
    if (stallTimeoutMs > 0) {
      for (const entry of this.running.values()) {
        const lastActivity = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime();
        if (now - lastActivity > stallTimeoutMs) {
          logger.warn(
            { issueId: entry.issueId, issueIdentifier: entry.issueIdentifier, elapsedMs: now - lastActivity },
            "Agent stalled, killing"
          );
          entry.abortController.abort();
        }
      }
    }

    // Tracker state refresh
    try {
      const refreshed = await tracker.fetchIssueStatesByIds(runningIds);
      const refreshedMap = new Map(refreshed.map((i) => [i.id, i]));
      const terminalStates = new Set(config.tracker.terminal_states.map(normalizeState));
      const activeStates = new Set(config.tracker.active_states.map(normalizeState));

      for (const entry of this.running.values()) {
        const updated = refreshedMap.get(entry.issueId);
        if (!updated) continue;

        const state = normalizeState(updated.state);

        if (terminalStates.has(state)) {
          logger.info(
            { issueId: entry.issueId, state: updated.state },
            "Issue terminal, stopping agent and cleaning workspace"
          );
          entry.abortController.abort();
          removeWorkspace(config.workspace.root, entry.issueIdentifier);
        } else if (activeStates.has(state)) {
          entry.issue = updated;
        } else {
          logger.info(
            { issueId: entry.issueId, state: updated.state },
            "Issue no longer active, stopping agent"
          );
          entry.abortController.abort();
        }
      }
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Reconciliation state refresh failed, keeping workers");
    }
  }

  private async startupCleanup(config: ServiceConfig): Promise<void> {
    const tracker = this.getTracker(config);

    try {
      const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminal_states);
      for (const issue of terminalIssues) {
        removeWorkspace(config.workspace.root, issue.identifier);
      }
      if (terminalIssues.length > 0) {
        logger.info({ count: terminalIssues.length }, "Cleaned up terminal workspaces");
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, "Startup cleanup failed, continuing");
    }
  }
}
