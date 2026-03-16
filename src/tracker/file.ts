/**
 * File-based tracker — reads task IDs from a TASKS file,
 * resolves details from a backlog markdown file in the repo.
 *
 * Backlog format:
 *   ### [STATUS] ID: Title
 *   > Priority: P1
 *   > Depends on: RA-022, RA-033
 *
 *   Description text...
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue, BlockerRef } from "../types.js";
import type { Tracker } from "./tracker.js";
import { normalizeState } from "../config.js";
import { logger } from "../logger.js";

interface FileTrackerConfig {
  baseDir: string;
  tasksFile: string;
  backlogFile: string;
  activeStates: string[];
  terminalStates: string[];
}

export class FileTracker implements Tracker {
  private config: FileTrackerConfig;

  constructor(config: FileTrackerConfig) {
    this.config = config;
  }

  private get tasksPath(): string {
    return resolve(this.config.baseDir, this.config.tasksFile);
  }

  private get backlogPath(): string {
    return resolve(this.config.baseDir, this.config.backlogFile);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const taskIds = readTasksFile(this.tasksPath);
    if (taskIds.length === 0) return [];

    const backlog = parseBacklog(this.backlogPath);
    const activeStates = new Set(this.config.activeStates.map(normalizeState));
    const results: Issue[] = [];

    for (const id of taskIds) {
      const issue = backlog.get(id.toUpperCase());
      if (!issue) {
        logger.warn({ id }, "Task ID from TASKS not found in backlog");
        continue;
      }
      if (activeStates.has(normalizeState(issue.state))) {
        results.push(issue);
      }
    }

    return results;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const taskIds = new Set(readTasksFile(this.tasksPath).map((id) => id.toUpperCase()));
    if (taskIds.size === 0) return [];

    const backlog = parseBacklog(this.backlogPath);
    const targetStates = new Set(states.map(normalizeState));
    const results: Issue[] = [];

    for (const [id, issue] of backlog) {
      if (taskIds.has(id) && targetStates.has(normalizeState(issue.state))) {
        results.push(issue);
      }
    }

    return results;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const backlog = parseBacklog(this.backlogPath);
    const results: Issue[] = [];

    for (const id of ids) {
      const issue = backlog.get(id.toUpperCase());
      if (issue) results.push(issue);
    }

    return results;
  }
}

// --- TASKS file parser ---

function readTasksFile(path: string): string[] {
  if (!existsSync(path)) {
    logger.debug({ path }, "TASKS file not found");
    return [];
  }

  const content = readFileSync(path, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// --- Backlog markdown parser ---

const HEADING_RE = /^###\s+\[([^\]]+)\]\s+([\w-]+):\s+(.+)$/;
const PRIORITY_RE = /^>\s*Priority:\s*(P\d)/i;
const DEPENDS_RE = /^>\s*Depends\s+on:\s*(.+)/i;

function parseBacklog(path: string): Map<string, Issue> {
  if (!existsSync(path)) {
    logger.error({ path }, "Backlog file not found");
    return new Map();
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const issues = new Map<string, Issue>();

  let current: {
    id: string;
    status: string;
    title: string;
    priority: number | null;
    blockedBy: BlockerRef[];
    descLines: string[];
  } | null = null;

  function flush() {
    if (!current) return;
    const description = current.descLines.join("\n").trim() || null;
    issues.set(current.id.toUpperCase(), {
      id: current.id,
      identifier: current.id,
      title: current.title,
      description,
      priority: current.priority,
      state: normalizeStatus(current.status),
      branchName: null,
      url: null,
      labels: [],
      blockedBy: current.blockedBy,
      createdAt: null,
      updatedAt: null,
    });
  }

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flush();
      current = {
        id: headingMatch[2]!,
        status: headingMatch[1]!,
        title: headingMatch[3]!,
        priority: null,
        blockedBy: [],
        descLines: [],
      };
      continue;
    }

    if (!current) continue;

    const priorityMatch = line.match(PRIORITY_RE);
    if (priorityMatch) {
      current.priority = parsePriority(priorityMatch[1]!);
      continue;
    }

    const dependsMatch = line.match(DEPENDS_RE);
    if (dependsMatch) {
      current.blockedBy = parseDependencies(dependsMatch[1]!);
      continue;
    }

    // Skip other blockquote metadata lines
    if (line.startsWith(">")) continue;

    current.descLines.push(line);
  }

  flush();
  return issues;
}

function normalizeStatus(raw: string): string {
  const map: Record<string, string> = {
    "IDEA": "Idea",
    "PLANNED": "Planned",
    "IN PROGRESS": "In Progress",
    "REVIEW": "Review",
    "VERIFIED": "Verified",
    "DONE": "Done",
    "BLOCKED": "Blocked",
    "ARCHIVED": "Archived",
    "SUPERSEDED": "Archived",
  };
  return map[raw.toUpperCase()] ?? raw;
}

function parsePriority(p: string): number {
  const map: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return map[p.toUpperCase()] ?? 3;
}

function parseDependencies(raw: string): BlockerRef[] {
  return raw
    .split(/[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((identifier) => ({ id: null, identifier, state: null }));
}
