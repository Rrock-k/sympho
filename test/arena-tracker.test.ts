import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArenaTracker } from "../src/arena/arena-tracker.js";

describe("ArenaTracker", () => {
  let tmpDir: string;
  let specDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sympho-arena-test-"));
    specDir = join(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads single spec as one issue", async () => {
    writeFileSync(join(specDir, "001-feature.md"), "# Build a TODO app\n\nCreate a simple app.");

    const tracker = new ArenaTracker(specDir, tmpDir);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe("ARENA-1");
    expect(issues[0]!.title).toBe("Build a TODO app");
    expect(issues[0]!.state).toBe("Todo");
    expect(issues[0]!.labels).toEqual(["arena"]);
  });

  it("combines multiple specs into one issue", async () => {
    writeFileSync(join(specDir, "001-api.md"), "# API\n\nBuild REST API.");
    writeFileSync(join(specDir, "002-frontend.md"), "# Frontend\n\nBuild UI.");

    const tracker = new ArenaTracker(specDir, tmpDir);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Arena project (2 specs)");
    expect(issues[0]!.description).toContain("--- 001-api.md ---");
    expect(issues[0]!.description).toContain("--- 002-frontend.md ---");
  });

  it("detects spec changes via refresh", () => {
    writeFileSync(join(specDir, "001-spec.md"), "# v1\n\nOriginal.");
    const tracker = new ArenaTracker(specDir, tmpDir);

    const hash1 = tracker.getSpecHash();

    // No change
    expect(tracker.refresh()).toBe(false);

    // Change spec
    writeFileSync(join(specDir, "001-spec.md"), "# v2\n\nUpdated.");
    expect(tracker.refresh()).toBe(true);
    expect(tracker.getSpecHash()).not.toBe(hash1);
  });

  it("marks issue as done", async () => {
    writeFileSync(join(specDir, "001-spec.md"), "# Task\n\nDo something.");
    const tracker = new ArenaTracker(specDir, tmpDir);

    let issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(1);

    tracker.markIssueDone("arena-combined");

    issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(0);
  });

  it("handles empty spec directory", async () => {
    const tracker = new ArenaTracker(specDir, tmpDir);
    const issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(0);
  });

  it("falls back to combined spec.md", async () => {
    writeFileSync(join(tmpDir, "spec.md"), "# Combined\n\nAll specs here.");

    const tracker = new ArenaTracker(specDir, tmpDir);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Combined");
  });
});
