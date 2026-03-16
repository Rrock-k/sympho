/**
 * Sympho — Autonomous agent orchestrator.
 * Public API for programmatic use.
 */

export { Orchestrator } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";

export { WorkflowStore, parseWorkflowFile, loadWorkflowFile } from "./workflow.js";
export { parseConfig, loadConfig, validateConfigForDispatch, normalizeState } from "./config.js";
export type { ServiceConfig } from "./config.js";

export { runAgent } from "./agent/index.js";
export type { AgentRunResult, AgentRunOptions } from "./agent/index.js";

export type { Tracker } from "./tracker/tracker.js";
export { LinearTracker } from "./tracker/linear.js";
export { MemoryTracker } from "./tracker/memory.js";

export {
  prepareWorkspace,
  createWorkspace,
  removeWorkspace,
  sanitizeIdentifier,
  workspacePath,
} from "./workspace/index.js";

export { buildPrompt, buildContinuationPrompt } from "./prompt-builder.js";

export type {
  Issue,
  BlockerRef,
  WorkflowDefinition,
  RunAttempt,
  RunAttemptStatus,
  RunningEntry,
  RetryEntry,
  TokenUsage,
  AgentEvent,
} from "./types.js";
