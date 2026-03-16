import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTracker } from "../src/tracker/file.js";

const BACKLOG_CONTENT = `# Project Backlog

### [PLANNED] RA-100: Build auth module
> Priority: P1
> Depends on: RA-099

Implement JWT authentication with refresh tokens.

### [IN PROGRESS] RA-101: Add user profiles
> Priority: P2

Create user profile pages with avatar upload.

### [DONE] RA-099: Set up database
> Priority: P0

PostgreSQL schema and migrations.

### [PLANNED] RA-102: Payment integration
> Priority: P1
> Depends on: RA-100, RA-101

Integrate Stripe for payments.
`;

describe("FileTracker", () => {
  let tmpDir: string;
  let tasksPath: string;
  let backlogPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sympho-file-tracker-test-"));
    tasksPath = "TASKS";
    backlogPath = "BACKLOG.md";
    writeFileSync(join(tmpDir, backlogPath), BACKLOG_CONTENT);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTracker(taskIds: string[]) {
    writeFileSync(
      join(tmpDir, tasksPath),
      taskIds.join("\n") + "\n"
    );
    return new FileTracker({
      baseDir: tmpDir,
      tasksFile: tasksPath,
      backlogFile: backlogPath,
      activeStates: ["Planned", "In Progress"],
      terminalStates: ["Done", "Archived"],
    });
  }

  it("fetches candidate issues from TASKS file", async () => {
    const tracker = makeTracker(["RA-100", "RA-101"]);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.identifier).sort()).toEqual(["RA-100", "RA-101"]);
  });

  it("parses backlog headings correctly", async () => {
    const tracker = makeTracker(["RA-100"]);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues[0]!.title).toBe("Build auth module");
    expect(issues[0]!.state).toBe("Planned");
    expect(issues[0]!.priority).toBe(1);
    expect(issues[0]!.description).toContain("JWT authentication");
  });

  it("parses dependencies as blockedBy", async () => {
    const tracker = makeTracker(["RA-102"]);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues[0]!.blockedBy).toHaveLength(2);
    expect(issues[0]!.blockedBy[0]!.identifier).toBe("RA-100");
    expect(issues[0]!.blockedBy[1]!.identifier).toBe("RA-101");
  });

  it("filters out terminal state issues", async () => {
    const tracker = makeTracker(["RA-099", "RA-100"]);
    const issues = await tracker.fetchCandidateIssues();

    // RA-099 is Done (terminal), should be filtered
    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe("RA-100");
  });

  it("fetchIssuesByStates returns matching issues", async () => {
    const tracker = makeTracker(["RA-099", "RA-100", "RA-101"]);
    const done = await tracker.fetchIssuesByStates(["Done"]);

    expect(done).toHaveLength(1);
    expect(done[0]!.identifier).toBe("RA-099");
  });

  it("fetchIssueStatesByIds returns matching issues", async () => {
    const tracker = makeTracker(["RA-100"]);
    const issues = await tracker.fetchIssueStatesByIds(["RA-101"]);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.state).toBe("In Progress");
  });

  it("handles missing TASKS file", async () => {
    const tracker = new FileTracker({
      baseDir: tmpDir,
      tasksFile: "NONEXISTENT",
      backlogFile: backlogPath,
      activeStates: ["Planned"],
      terminalStates: ["Done"],
    });

    const issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(0);
  });

  it("skips comment lines in TASKS file", async () => {
    writeFileSync(
      join(tmpDir, tasksPath),
      "# Current sprint\nRA-100\n# Backlog\nRA-101\n"
    );

    const tracker = new FileTracker({
      baseDir: tmpDir,
      tasksFile: tasksPath,
      backlogFile: backlogPath,
      activeStates: ["Planned", "In Progress"],
      terminalStates: ["Done"],
    });

    const issues = await tracker.fetchCandidateIssues();
    expect(issues).toHaveLength(2);
  });

  it("is case-insensitive on task IDs", async () => {
    const tracker = makeTracker(["ra-100"]);
    const issues = await tracker.fetchCandidateIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe("RA-100");
  });
});
