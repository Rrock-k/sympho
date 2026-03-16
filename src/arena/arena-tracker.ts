/**
 * ArenaTracker — reads spec files from specs/ directory as issues.
 *
 * Each .md file in the spec dir becomes an issue.
 * Combined spec.md (if present) becomes the primary issue.
 * Supports live spec updates via hash comparison.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { Issue } from "../types.js";
import type { Tracker } from "../tracker/tracker.js";

export class ArenaTracker implements Tracker {
  private specDir: string;
  private workDir: string;
  private lastSpecHash: string = "";
  private issues: Issue[] = [];

  constructor(specDir: string, workDir: string) {
    this.specDir = specDir;
    this.workDir = workDir;
    this.refresh();
  }

  /** Recompute issues from spec files. Returns true if specs changed. */
  refresh(): boolean {
    const newHash = this.hashSpecs();
    if (newHash === this.lastSpecHash && this.issues.length > 0) {
      return false;
    }

    this.lastSpecHash = newHash;
    this.issues = this.readSpecsAsIssues();
    return true;
  }

  getSpecHash(): string {
    return this.lastSpecHash;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    this.refresh();
    // All arena issues are active (Todo) until marked done
    return this.issues.filter((i) => i.state === "Todo");
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const stateSet = new Set(states.map((s) => s.toLowerCase()));
    return this.issues.filter((i) => stateSet.has(i.state.toLowerCase()));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const idSet = new Set(ids);
    return this.issues.filter((i) => idSet.has(i.id));
  }

  markIssueDone(issueId: string): void {
    const issue = this.issues.find((i) => i.id === issueId);
    if (issue) issue.state = "Done";
  }

  // --- Private ---

  private hashSpecs(): string {
    try {
      const files = this.getSpecFiles();
      const content = files
        .map((f) => readFileSync(join(this.specDir, f), "utf-8"))
        .join("\n");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return "none";
    }
  }

  private getSpecFiles(): string[] {
    if (!existsSync(this.specDir)) return [];
    return readdirSync(this.specDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  }

  private readSpecsAsIssues(): Issue[] {
    const files = this.getSpecFiles();

    if (files.length === 0) {
      // If no individual specs, check for combined spec.md
      const combinedSpec = join(this.workDir, "spec.md");
      if (existsSync(combinedSpec)) {
        return [this.specFileToIssue("spec.md", readFileSync(combinedSpec, "utf-8"), 0)];
      }
      return [];
    }

    // Single combined issue from all specs (arena typically works as one task)
    const allContent = files
      .map((f) => `--- ${basename(f)} ---\n${readFileSync(join(this.specDir, f), "utf-8")}`)
      .join("\n\n");

    const title = files.length === 1
      ? this.extractTitle(readFileSync(join(this.specDir, files[0]!), "utf-8")) ?? files[0]!
      : `Arena project (${files.length} specs)`;

    return [{
      id: "arena-combined",
      identifier: "ARENA-1",
      title,
      description: allContent,
      priority: 1,
      state: "Todo",
      branchName: process.env.ARENA_PUSH_BRANCH ?? null,
      url: null,
      labels: ["arena"],
      blockedBy: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
  }

  private specFileToIssue(filename: string, content: string, index: number): Issue {
    const title = this.extractTitle(content) ?? filename.replace(/\.md$/, "");
    return {
      id: `arena-spec-${index}`,
      identifier: `ARENA-${index + 1}`,
      title,
      description: content,
      priority: 1,
      state: "Todo",
      branchName: process.env.ARENA_PUSH_BRANCH ?? null,
      url: null,
      labels: ["arena"],
      blockedBy: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private extractTitle(content: string): string | null {
    const match = content.match(/^#\s+(.+)/m);
    return match?.[1]?.trim() ?? null;
  }
}
