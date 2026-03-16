import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../src/tracker/memory.js";
import type { Issue } from "../src/types.js";

const makeIssue = (id: string, state: string): Issue => ({
  id,
  identifier: `TEST-${id}`,
  title: `Issue ${id}`,
  description: null,
  priority: null,
  state,
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
});

describe("MemoryTracker", () => {
  it("fetches all candidates", async () => {
    const tracker = new MemoryTracker();
    tracker.addIssue(makeIssue("1", "Todo"));
    tracker.addIssue(makeIssue("2", "In Progress"));

    const issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(2);
  });

  it("fetches by states", async () => {
    const tracker = new MemoryTracker();
    tracker.addIssue(makeIssue("1", "Todo"));
    tracker.addIssue(makeIssue("2", "Done"));
    tracker.addIssue(makeIssue("3", "In Progress"));

    const done = await tracker.fetchIssuesByStates(["Done"]);
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe("2");
  });

  it("fetches by IDs", async () => {
    const tracker = new MemoryTracker();
    tracker.addIssue(makeIssue("1", "Todo"));
    tracker.addIssue(makeIssue("2", "Done"));

    const result = await tracker.fetchIssueStatesByIds(["2"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.state).toBe("Done");
  });

  it("updates issue state", async () => {
    const tracker = new MemoryTracker();
    tracker.addIssue(makeIssue("1", "Todo"));

    tracker.updateIssueState("1", "In Progress");
    const result = await tracker.fetchIssueStatesByIds(["1"]);
    expect(result[0]!.state).toBe("In Progress");
  });

  it("removes issue", async () => {
    const tracker = new MemoryTracker();
    tracker.addIssue(makeIssue("1", "Todo"));
    tracker.removeIssue("1");

    const result = await tracker.fetchCandidateIssues();
    expect(result).toHaveLength(0);
  });
});
