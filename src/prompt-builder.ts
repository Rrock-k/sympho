/**
 * Builds agent prompts from issue data using Liquid templates.
 */

import { Liquid } from "liquidjs";
import type { Issue, WorkflowDefinition } from "./types.js";

const DEFAULT_TEMPLATE = `You are working on an issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

const engine = new Liquid({ strictVariables: true, strictFilters: true });

function issueToTemplateObject(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branchName,
    branchName: issue.branchName,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    blockedBy: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.createdAt?.toISOString() ?? null,
    createdAt: issue.createdAt?.toISOString() ?? null,
    updated_at: issue.updatedAt?.toISOString() ?? null,
    updatedAt: issue.updatedAt?.toISOString() ?? null,
  };
}

export function buildPrompt(
  workflow: WorkflowDefinition,
  issue: Issue,
  attempt: number | null = null
): string {
  const template = workflow.promptTemplate.trim() || DEFAULT_TEMPLATE;

  const result = engine.parseAndRenderSync(template, {
    issue: issueToTemplateObject(issue),
    attempt,
  });

  return result;
}

export function buildContinuationPrompt(turnNumber: number, maxTurns: number): string {
  return `Continuation guidance:

- The previous turn completed normally, but the issue is still in an active state.
- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.
- Resume from the current workspace state instead of restarting from scratch.
- The original task instructions and prior turn context are already present, so do not restate them before acting.
- Focus on the remaining work and do not end the turn while the issue stays active unless you are truly blocked.
`;
}
