/**
 * Abstract tracker interface — adapter boundary for issue tracker reads.
 */

import type { Issue } from "../types.js";

export interface Tracker {
  /** Fetch issues in active states for the configured project. */
  fetchCandidateIssues(): Promise<Issue[]>;

  /** Fetch issues in specific states (used for startup cleanup). */
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;

  /** Fetch current states for specific issue IDs (reconciliation). */
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
}
