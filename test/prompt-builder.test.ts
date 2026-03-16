import { describe, it, expect } from "vitest";
import { buildPrompt, buildContinuationPrompt } from "../src/prompt-builder.js";
import type { Issue, WorkflowDefinition } from "../src/types.js";

const makeIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: "abc123",
  identifier: "TEST-1",
  title: "Fix the bug",
  description: "Something is broken",
  priority: 1,
  state: "In Progress",
  branchName: null,
  url: "https://example.com/TEST-1",
  labels: ["bug"],
  blockedBy: [],
  createdAt: new Date("2026-01-01"),
  updatedAt: null,
  ...overrides,
});

describe("buildPrompt", () => {
  it("renders template with issue data", () => {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "Work on {{ issue.identifier }}: {{ issue.title }}",
    };

    const result = buildPrompt(workflow, makeIssue());
    expect(result).toBe("Work on TEST-1: Fix the bug");
  });

  it("renders description conditionally", () => {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: `{% if issue.description %}{{ issue.description }}{% else %}No desc{% endif %}`,
    };

    expect(buildPrompt(workflow, makeIssue())).toBe("Something is broken");
    expect(buildPrompt(workflow, makeIssue({ description: null }))).toBe("No desc");
  });

  it("passes attempt variable", () => {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "Attempt: {{ attempt }}",
    };

    expect(buildPrompt(workflow, makeIssue(), 3)).toBe("Attempt: 3");
  });

  it("uses default template for empty prompt", () => {
    const workflow: WorkflowDefinition = { config: {}, promptTemplate: "" };
    const result = buildPrompt(workflow, makeIssue());

    expect(result).toContain("TEST-1");
    expect(result).toContain("Fix the bug");
  });

  it("renders labels", () => {
    const workflow: WorkflowDefinition = {
      config: {},
      promptTemplate: "{% for label in issue.labels %}{{ label }} {% endfor %}",
    };

    const result = buildPrompt(workflow, makeIssue({ labels: ["bug", "urgent"] }));
    expect(result.trim()).toBe("bug urgent");
  });
});

describe("buildContinuationPrompt", () => {
  it("includes turn numbers", () => {
    const result = buildContinuationPrompt(3, 10);
    expect(result).toContain("#3 of 10");
  });
});
