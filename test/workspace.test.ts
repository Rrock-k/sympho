import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sanitizeIdentifier,
  workspacePath,
  createWorkspace,
  removeWorkspace,
} from "../src/workspace/index.js";

describe("sanitizeIdentifier", () => {
  it("replaces non-safe chars with underscore", () => {
    expect(sanitizeIdentifier("ABC-123")).toBe("ABC-123");
    expect(sanitizeIdentifier("FOO/BAR BAZ")).toBe("FOO_BAR_BAZ");
    expect(sanitizeIdentifier("issue#42!")).toBe("issue_42_");
  });

  it("preserves dots and hyphens", () => {
    expect(sanitizeIdentifier("v1.0-beta")).toBe("v1.0-beta");
  });
});

describe("workspace lifecycle", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sympho-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates workspace directory", () => {
    const result = createWorkspace(tmpRoot, "TEST-1");
    expect(result.createdNow).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toBe(workspacePath(tmpRoot, "TEST-1"));
  });

  it("reuses existing workspace", () => {
    const first = createWorkspace(tmpRoot, "TEST-2");
    const second = createWorkspace(tmpRoot, "TEST-2");
    expect(first.createdNow).toBe(true);
    expect(second.createdNow).toBe(false);
    expect(first.path).toBe(second.path);
  });

  it("removes workspace", () => {
    const result = createWorkspace(tmpRoot, "TEST-3");
    expect(existsSync(result.path)).toBe(true);

    removeWorkspace(tmpRoot, "TEST-3");
    expect(existsSync(result.path)).toBe(false);
  });

  it("no-ops when removing nonexistent workspace", () => {
    expect(() => removeWorkspace(tmpRoot, "NOPE")).not.toThrow();
  });
});
