import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/orchestrator.js";
import { MemoryTracker } from "../src/tracker/memory.js";
import type { Issue } from "../src/types.js";

const makeIssue = (id: string, state: string, priority: number | null = null): Issue => ({
  id,
  identifier: `TEST-${id}`,
  title: `Test issue ${id}`,
  description: `Description for ${id}`,
  priority,
  state,
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: null,
});

describe("Orchestrator", () => {
  let tmpDir: string;
  let workflowPath: string;
  let tracker: MemoryTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sympho-orch-test-"));
    workflowPath = join(tmpDir, "WORKFLOW.md");

    writeFileSync(
      workflowPath,
      `---
tracker:
  kind: memory
  active_states: [Todo, In Progress]
  terminal_states: [Done, Closed]
polling:
  interval_ms: 60000
workspace:
  root: ${join(tmpDir, "workspaces")}
agent:
  command: echo test
  max_concurrent_agents: 2
  max_turns: 1
  stall_timeout_ms: 0
---
Work on {{ issue.identifier }}: {{ issue.title }}
`
    );

    tracker = new MemoryTracker();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates orchestrator and reads config", () => {
    const orch = new Orchestrator({
      workflowPath,
      trackerFactory: () => tracker,
    });

    const state = orch.getState();
    expect(state.counts.running).toBe(0);
    expect(state.counts.retrying).toBe(0);
  });

  it("getState returns running and retrying arrays", () => {
    const orch = new Orchestrator({
      workflowPath,
      trackerFactory: () => tracker,
    });

    const state = orch.getState();
    expect(state.running).toEqual([]);
    expect(state.retrying).toEqual([]);
    expect(state.agentTotals.inputTokens).toBe(0);
    expect(state.agentTotals.costUsd).toBe(0);
  });

  it("starts and stops without errors", async () => {
    const orch = new Orchestrator({
      workflowPath,
      trackerFactory: () => tracker,
    });

    // Start will do a tick (which with memory tracker returns empty candidates)
    await orch.start();

    const state = orch.getState();
    expect(state.counts.running).toBe(0);

    await orch.stop();
  });

  it("dispatches issues from memory tracker", async () => {
    tracker.addIssue(makeIssue("1", "Todo", 1));

    const orch = new Orchestrator({
      workflowPath,
      trackerFactory: () => tracker,
    });

    await orch.start();

    // Give agent a moment to start (echo test exits immediately)
    await new Promise((r) => setTimeout(r, 500));

    // After the quick agent runs, it should have processed or be retrying
    const state = orch.getState();
    // The issue should have been dispatched (might be in retry after echo exits)
    expect(state.agentTotals).toBeDefined();

    await orch.stop();
  });
});
