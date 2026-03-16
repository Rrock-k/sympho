/**
 * GitHub Issues tracker adapter.
 * Uses GitHub REST API v3 via the gh CLI or direct HTTP.
 */

import type { Issue, BlockerRef } from "../types.js";
import type { Tracker } from "./tracker.js";
import { normalizeState } from "../config.js";
import { logger } from "../logger.js";

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 100;
const TIMEOUT_MS = 30_000;

interface GitHubConfig {
  token: string;
  repo: string; // "owner/repo"
  activeStates: string[];
  terminalStates: string[];
}

/** Map GitHub issue state to normalized state names. */
function mapGitHubState(ghState: string, stateReason: string | null): string {
  if (ghState === "open") return "Todo";
  if (ghState === "closed" && stateReason === "completed") return "Done";
  if (ghState === "closed" && stateReason === "not_planned") return "Cancelled";
  if (ghState === "closed") return "Closed";
  return ghState;
}

export class GitHubTracker implements Tracker {
  private config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  private async api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${GITHUB_API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    // GitHub Issues API: fetch open issues (active candidates)
    const [owner, repo] = this.config.repo.split("/");
    const allIssues: Issue[] = [];
    let page = 1;

    while (true) {
      const ghIssues = await this.api<GitHubIssue[]>(
        `/repos/${owner}/${repo}/issues`,
        {
          state: "open",
          per_page: String(PER_PAGE),
          page: String(page),
          sort: "created",
          direction: "asc",
        }
      );

      for (const ghIssue of ghIssues) {
        // Skip pull requests (GitHub API includes them in /issues)
        if (ghIssue.pull_request) continue;
        allIssues.push(normalizeGitHubIssue(ghIssue));
      }

      if (ghIssues.length < PER_PAGE) break;
      page++;
    }

    // Filter to active states
    const activeStates = new Set(this.config.activeStates.map(normalizeState));
    return allIssues.filter((issue) => activeStates.has(normalizeState(issue.state)));
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const normalizedStates = new Set(states.map(normalizeState));
    const [owner, repo] = this.config.repo.split("/");

    // Determine which GitHub API state to query
    const needOpen = states.some((s) => ["todo", "in progress"].includes(normalizeState(s)));
    const needClosed = states.some((s) =>
      ["done", "closed", "cancelled", "canceled", "duplicate"].includes(normalizeState(s))
    );

    const allIssues: Issue[] = [];

    for (const ghState of [needOpen && "open", needClosed && "closed"].filter(Boolean) as string[]) {
      let page = 1;
      while (true) {
        const ghIssues = await this.api<GitHubIssue[]>(
          `/repos/${owner}/${repo}/issues`,
          {
            state: ghState,
            per_page: String(PER_PAGE),
            page: String(page),
          }
        );

        for (const ghIssue of ghIssues) {
          if (ghIssue.pull_request) continue;
          const issue = normalizeGitHubIssue(ghIssue);
          if (normalizedStates.has(normalizeState(issue.state))) {
            allIssues.push(issue);
          }
        }

        if (ghIssues.length < PER_PAGE) break;
        page++;
      }
    }

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const [owner, repo] = this.config.repo.split("/");
    const results: Issue[] = [];

    // GitHub doesn't have batch-by-ID, fetch individually
    for (const id of ids) {
      try {
        // ID format for GitHub is the issue number
        const ghIssue = await this.api<GitHubIssue>(
          `/repos/${owner}/${repo}/issues/${id}`
        );
        if (!ghIssue.pull_request) {
          results.push(normalizeGitHubIssue(ghIssue));
        }
      } catch (err) {
        logger.warn({ id, error: (err as Error).message }, "Failed to fetch GitHub issue by ID");
      }
    }

    return results;
  }
}

// --- Types ---

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

// --- Normalization ---

function normalizeGitHubIssue(gh: GitHubIssue): Issue {
  return {
    id: String(gh.number),
    identifier: `#${gh.number}`,
    title: gh.title,
    description: gh.body,
    priority: null, // GitHub Issues don't have native priority
    state: mapGitHubState(gh.state, gh.state_reason),
    branchName: null,
    url: gh.html_url,
    labels: gh.labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase()),
    blockedBy: [], // GitHub doesn't have native blocking relations
    createdAt: new Date(gh.created_at),
    updatedAt: new Date(gh.updated_at),
  };
}
