import { describe, it, expect } from "vitest";
import { parseWorkflowFile } from "../src/workflow.js";

describe("parseWorkflowFile", () => {
  it("parses YAML front matter and prompt body", () => {
    const content = `---
tracker:
  kind: linear
  project_slug: test-project
polling:
  interval_ms: 5000
---

You are working on {{ issue.identifier }}.
`;

    const result = parseWorkflowFile(content);

    expect(result.config).toEqual({
      tracker: { kind: "linear", project_slug: "test-project" },
      polling: { interval_ms: 5000 },
    });
    expect(result.promptTemplate).toBe("You are working on {{ issue.identifier }}.");
  });

  it("returns empty config when no front matter", () => {
    const content = "Just a prompt template.";
    const result = parseWorkflowFile(content);

    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("Just a prompt template.");
  });

  it("trims prompt template", () => {
    const content = `---
tracker:
  kind: memory
---

  Hello world

`;
    const result = parseWorkflowFile(content);
    expect(result.promptTemplate).toBe("Hello world");
  });

  it("throws on non-object YAML front matter", () => {
    const content = `---
- list
- items
---
prompt`;

    expect(() => parseWorkflowFile(content)).toThrow("must decode to an object");
  });

  it("handles null front matter", () => {
    const content = `---
---
prompt body`;

    const result = parseWorkflowFile(content);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe("prompt body");
  });
});
