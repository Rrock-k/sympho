/**
 * Typed configuration derived from WORKFLOW.md front matter, validated with Zod.
 */

import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDefinition } from "./types.js";

/** Resolve $VAR references to env values. */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    const envVal = process.env[envKey];
    return envVal || undefined;
  }
  return value;
}

/** Coerce string integers to numbers. */
const coerceInt = z.union([z.number(), z.string().transform(Number)]).pipe(z.number().int());
const optionalCoerceInt = coerceInt.optional();

const TrackerSchema = z.object({
  kind: z.enum(["linear", "github", "memory", "file"]).default("linear"),
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  project_slug: z.string().optional(),
  repo: z.string().optional(),
  tasks_file: z.string().optional(),
  backlog_file: z.string().optional(),
  active_states: z.array(z.string()).default(["Todo", "In Progress"]),
  terminal_states: z.array(z.string()).default(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]),
}).default({});

const PollingSchema = z.object({
  interval_ms: coerceInt.default(30_000),
}).default({});

const WorkspaceSchema = z.object({
  root: z.string().default(join(tmpdir(), "sympho_workspaces")),
}).default({});

const HooksSchema = z.object({
  after_create: z.string().nullable().default(null),
  before_run: z.string().nullable().default(null),
  after_run: z.string().nullable().default(null),
  before_remove: z.string().nullable().default(null),
  timeout_ms: coerceInt.default(60_000),
}).default({});

const AgentSchema = z.object({
  command: z.string().default("claude --output-format stream-json -p"),
  max_concurrent_agents: coerceInt.default(10),
  max_turns: coerceInt.default(20),
  max_retry_backoff_ms: coerceInt.default(300_000),
  max_concurrent_agents_by_state: z.record(z.string(), coerceInt).default({}),
  turn_timeout_ms: coerceInt.default(3_600_000),
  stall_timeout_ms: coerceInt.default(300_000),
}).default({});

const ServiceConfigSchema = z.object({
  tracker: TrackerSchema,
  polling: PollingSchema,
  workspace: WorkspaceSchema,
  hooks: HooksSchema,
  agent: AgentSchema,
}).passthrough();

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export function parseConfig(raw: Record<string, unknown>): ServiceConfig {
  const parsed = ServiceConfigSchema.parse(raw);

  // Resolve env vars
  if (parsed.tracker.api_key) {
    parsed.tracker.api_key = resolveEnvVar(parsed.tracker.api_key) ?? parsed.tracker.api_key;
  }

  // Expand ~ in workspace root
  if (parsed.workspace.root.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    parsed.workspace.root = parsed.workspace.root.replace(/^~/, home);
  }

  // Normalize max_concurrent_agents_by_state keys
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.agent.max_concurrent_agents_by_state)) {
    if (value > 0) {
      normalized[key.toLowerCase().trim()] = value;
    }
  }
  parsed.agent.max_concurrent_agents_by_state = normalized;

  return parsed;
}

export function loadConfig(workflow: WorkflowDefinition): ServiceConfig {
  return parseConfig(workflow.config);
}

export function normalizeState(state: string): string {
  return state.toLowerCase().trim();
}

export function validateConfigForDispatch(config: ServiceConfig): string | null {
  if (!config.tracker.kind) return "missing tracker.kind";

  if (config.tracker.kind === "linear") {
    const apiKey = resolveEnvVar(config.tracker.api_key);
    if (!apiKey) return "missing tracker.api_key (set LINEAR_API_KEY)";
    if (!config.tracker.project_slug) return "missing tracker.project_slug";
  }

  if (config.tracker.kind === "github") {
    const apiKey = resolveEnvVar(config.tracker.api_key);
    if (!apiKey) return "missing tracker.api_key (set GITHUB_TOKEN)";
    if (!config.tracker.repo) return "missing tracker.repo";
  }

  if (config.tracker.kind === "file") {
    if (!config.tracker.tasks_file) return "missing tracker.tasks_file";
    if (!config.tracker.backlog_file) return "missing tracker.backlog_file";
  }

  if (!config.agent.command) return "missing agent.command";

  return null;
}

export function maxConcurrentForState(config: ServiceConfig, stateName: string): number {
  const normalized = normalizeState(stateName);
  return config.agent.max_concurrent_agents_by_state[normalized] ?? config.agent.max_concurrent_agents;
}
