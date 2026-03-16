#!/usr/bin/env node

/**
 * Sympho CLI — entry point for the orchestrator daemon.
 */

import { resolve } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { LinearTracker } from "./tracker/linear.js";
import { MemoryTracker } from "./tracker/memory.js";
import type { ServiceConfig } from "./config.js";
import type { Tracker } from "./tracker/tracker.js";
import { logger } from "./logger.js";

function parseArgs(argv: string[]): { workflowPath: string } {
  let workflowPath = "WORKFLOW.md";

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--workflow" || arg === "-w") && argv[i + 1]) {
      workflowPath = argv[i + 1]!;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
sympho — autonomous agent orchestrator

Usage:
  sympho [options]

Options:
  -w, --workflow <path>   Path to WORKFLOW.md (default: ./WORKFLOW.md)
  -h, --help              Show this help

Environment:
  LINEAR_API_KEY          API key for Linear tracker
  GITHUB_TOKEN            API token for GitHub Issues tracker
  LOG_LEVEL               Log level (default: info)
`);
      process.exit(0);
    }
  }

  return { workflowPath: resolve(workflowPath) };
}

function createTracker(config: ServiceConfig): Tracker {
  switch (config.tracker.kind) {
    case "linear":
      return new LinearTracker({
        endpoint: config.tracker.endpoint,
        apiKey: config.tracker.api_key!,
        projectSlug: config.tracker.project_slug!,
        activeStates: config.tracker.active_states,
        terminalStates: config.tracker.terminal_states,
      });
    case "memory":
      return new MemoryTracker();
    default:
      throw new Error(`Unsupported tracker kind: ${config.tracker.kind}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const orchestrator = new Orchestrator({
    workflowPath: args.workflowPath,
    trackerFactory: createTracker,
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Received shutdown signal");
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await orchestrator.start();
  } catch (err) {
    logger.fatal({ error: (err as Error).message }, "Failed to start orchestrator");
    process.exit(1);
  }
}

main();
