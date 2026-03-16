/**
 * Core domain types for Sympho orchestrator.
 */

/** Normalized issue record from any tracker. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Parsed WORKFLOW.md. */
export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

/** Run attempt for one issue. */
export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: Date;
  status: RunAttemptStatus;
  error?: string;
}

export type RunAttemptStatus =
  | "preparing_workspace"
  | "building_prompt"
  | "launching_agent"
  | "streaming_turn"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "canceled";

/** Running entry in orchestrator state. */
export interface RunningEntry {
  issueId: string;
  issueIdentifier: string;
  issue: Issue;
  attempt: number | null;
  workspacePath: string;
  startedAt: Date;
  turnCount: number;
  lastEvent: string | null;
  lastEventAt: Date | null;
  lastMessage: string | null;
  sessionId: string | null;
  tokens: TokenUsage;
  abortController: AbortController;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Retry entry. */
export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}

/** Agent event emitted from claude-code stream-json. */
export interface AgentEvent {
  type: string;
  subtype?: string;
  sessionId?: string;
  costUsd?: number;
  usage?: TokenUsage;
  content?: string;
  error?: string;
  raw: Record<string, unknown>;
}
