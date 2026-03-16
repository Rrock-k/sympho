import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProgressWriter } from "../src/arena/progress-writer.js";

describe("ProgressWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sympho-progress-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes progress.json", () => {
    const pw = new ProgressWriter(tmpDir);
    pw.write({ state: "coding", message: "Working", iteration: 3 });

    const raw = readFileSync(join(tmpDir, ".arena", "progress.json"), "utf-8");
    const data = JSON.parse(raw);

    expect(data.state).toBe("coding");
    expect(data.message).toBe("Working");
    expect(data.iteration).toBe(3);
  });

  it("creates .arena directory if missing", () => {
    const pw = new ProgressWriter(tmpDir);
    pw.write({ state: "planning" });

    expect(existsSync(join(tmpDir, ".arena"))).toBe(true);
  });

  it("manages done marker", () => {
    const pw = new ProgressWriter(tmpDir);

    expect(pw.isDone()).toBe(false);

    pw.markDone();
    expect(pw.isDone()).toBe(true);

    pw.clearDoneMarker();
    expect(pw.isDone()).toBe(false);
  });

  it("clearDoneMarker is safe when no marker exists", () => {
    const pw = new ProgressWriter(tmpDir);
    expect(() => pw.clearDoneMarker()).not.toThrow();
  });
});
