/**
 * In-memory tracker for tests and local development.
 */

import type { Issue } from "../types.js";
import type { Tracker } from "./tracker.js";
import { normalizeState } from "../config.js";

export class MemoryTracker implements Tracker {
  private issues: Map<string, Issue> = new Map();

  addIssue(issue: Issue): void {
    this.issues.set(issue.id, issue);
  }

  updateIssueState(issueId: string, state: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.state = state;
    }
  }

  removeIssue(issueId: string): void {
    this.issues.delete(issueId);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return Array.from(this.issues.values());
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const normalizedStates = new Set(states.map(normalizeState));
    return Array.from(this.issues.values()).filter((issue) =>
      normalizedStates.has(normalizeState(issue.state))
    );
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const idSet = new Set(ids);
    return Array.from(this.issues.values()).filter((issue) => idSet.has(issue.id));
  }
}
