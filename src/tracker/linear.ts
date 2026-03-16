/**
 * Linear issue tracker adapter.
 */

import type { Issue, BlockerRef } from "../types.js";
import type { Tracker } from "./tracker.js";
import { normalizeState } from "../config.js";
import { logger } from "../logger.js";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const TIMEOUT_MS = 30_000;

interface LinearConfig {
  endpoint?: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
}

export class LinearTracker implements Tracker {
  private config: LinearConfig;

  constructor(config: LinearConfig) {
    this.config = config;
  }

  private get endpoint(): string {
    return this.config.endpoint ?? DEFAULT_ENDPOINT;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.config.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Linear API returned ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };

      if (json.errors?.length) {
        throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
      }

      if (!json.data) {
        throw new Error("Linear API returned no data");
      }

      return json.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let hasNextPage = true;
    let afterCursor: string | undefined;

    while (hasNextPage) {
      const data = await this.graphql<CandidateResponse>(CANDIDATE_QUERY, {
        projectSlug: this.config.projectSlug,
        states: this.config.activeStates,
        first: PAGE_SIZE,
        after: afterCursor ?? null,
      });

      const connection = data.issues;
      for (const node of connection.nodes) {
        allIssues.push(normalizeIssue(node));
      }

      hasNextPage = connection.pageInfo.hasNextPage;
      afterCursor = connection.pageInfo.endCursor ?? undefined;

      if (hasNextPage && !afterCursor) {
        logger.warn("Linear returned hasNextPage=true but no endCursor, stopping pagination");
        break;
      }
    }

    return allIssues;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let hasNextPage = true;
    let afterCursor: string | undefined;

    while (hasNextPage) {
      const data = await this.graphql<CandidateResponse>(ISSUES_BY_STATE_QUERY, {
        projectSlug: this.config.projectSlug,
        states,
        first: PAGE_SIZE,
        after: afterCursor ?? null,
      });

      const connection = data.issues;
      for (const node of connection.nodes) {
        allIssues.push(normalizeIssue(node));
      }

      hasNextPage = connection.pageInfo.hasNextPage;
      afterCursor = connection.pageInfo.endCursor ?? undefined;
      if (hasNextPage && !afterCursor) break;
    }

    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const data = await this.graphql<IssuesByIdResponse>(ISSUES_BY_ID_QUERY, { ids });

    return data.nodes.filter(Boolean).map(normalizeIssue);
  }
}

// --- GraphQL queries ---

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  relations {
    nodes {
      type
      relatedIssue {
        id
        identifier
        state { name }
      }
    }
  }
`;

const CANDIDATE_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_STATE_QUERY = `
  query IssuesByState($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_ID_QUERY = `
  query IssuesById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue { ${ISSUE_FIELDS} }
    }
  }
`;

// --- Types ---

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  branchName: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
        state: { name: string };
      };
    }>;
  };
}

interface CandidateResponse {
  issues: {
    nodes: LinearIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface IssuesByIdResponse {
  nodes: LinearIssueNode[];
}

// --- Normalization ---

function normalizeIssue(node: LinearIssueNode): Issue {
  const blockedBy: BlockerRef[] = (node.relations?.nodes ?? [])
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: r.relatedIssue.id ?? null,
      identifier: r.relatedIssue.identifier ?? null,
      state: r.relatedIssue.state?.name ?? null,
    }));

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === "number" ? node.priority : null,
    state: node.state.name,
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels: (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
    blockedBy,
    createdAt: node.createdAt ? new Date(node.createdAt) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}
