/**
 * Writes a human-readable STATUS.md next to the WORKFLOW.md.
 * Updated on every meaningful orchestrator event.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";

export interface StatusIssue {
  issueId: string;
  issueIdentifier: string;
  title: string;
  status: "queued" | "running" | "retrying" | "done" | "failed";
  turn?: number;
  maxTurns?: number;
  costUsd?: number;
  elapsed?: string;
  error?: string | null;
  attempt?: number;
  retryAt?: string;
}

export interface StatusSnapshot {
  issues: StatusIssue[];
  totals: {
    costUsd: number;
    secondsRunning: number;
  };
}

const STATUS_ICON: Record<string, string> = {
  queued: "⏳",
  running: "🔄",
  retrying: "🔁",
  done: "✅",
  failed: "❌",
};

export class StatusWriter {
  private filePath: string;
  private lastContent = "";

  constructor(workflowDir: string) {
    this.filePath = join(workflowDir, "STATUS.md");
  }

  write(snapshot: StatusSnapshot): void {
    const lines: string[] = [];

    lines.push("# Sympho Status");
    lines.push("");
    lines.push(`> Updated: ${new Date().toLocaleTimeString()}`);
    lines.push("");

    if (snapshot.issues.length === 0) {
      lines.push("No tasks in queue.");
    } else {
      lines.push("| Status | Task | Progress | Cost | Time | Note |");
      lines.push("|--------|------|----------|------|------|------|");

      for (const issue of snapshot.issues) {
        const icon = STATUS_ICON[issue.status] ?? "❓";
        const id = issue.issueIdentifier;
        const title = issue.title.length > 40 ? issue.title.slice(0, 37) + "..." : issue.title;
        const progress = issue.turn ? `turn ${issue.turn}/${issue.maxTurns ?? "?"}` : "—";
        const cost = issue.costUsd ? `$${issue.costUsd.toFixed(2)}` : "—";
        const time = issue.elapsed ?? "—";
        let note = "";
        if (issue.error) note = issue.error.slice(0, 30);
        if (issue.status === "retrying" && issue.retryAt) note = `retry at ${issue.retryAt}`;

        lines.push(`| ${icon} ${issue.status} | **${id}** ${title} | ${progress} | ${cost} | ${time} | ${note} |`);
      }
    }

    if (snapshot.totals.costUsd > 0) {
      lines.push("");
      lines.push(`**Total:** $${snapshot.totals.costUsd.toFixed(2)} · ${formatDuration(snapshot.totals.secondsRunning)}`);
    }

    lines.push("");

    const content = lines.join("\n");

    // Avoid unnecessary writes
    if (content === this.lastContent) return;
    this.lastContent = content;

    try {
      writeFileSync(this.filePath, content, "utf-8");
    } catch (err) {
      logger.warn({ error: (err as Error).message }, "Failed to write STATUS.md");
    }
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatElapsed(startedAt: Date): string {
  return formatDuration((Date.now() - startedAt.getTime()) / 1000);
}
