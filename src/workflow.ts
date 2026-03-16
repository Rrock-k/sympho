/**
 * Workflow loader — reads and parses WORKFLOW.md (YAML front matter + prompt template).
 */

import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "./types.js";
import { logger } from "./logger.js";

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FRONT_MATTER_EMPTY_RE = /^---\r?\n---\r?\n?([\s\S]*)$/;

export function parseWorkflowFile(content: string): WorkflowDefinition {
  const emptyMatch = content.match(FRONT_MATTER_EMPTY_RE);
  if (emptyMatch) {
    return { config: {}, promptTemplate: emptyMatch[1]!.trim() };
  }

  const match = content.match(FRONT_MATTER_RE);
  if (!match) {
    return { config: {}, promptTemplate: content.trim() };
  }

  const yamlStr = match[1]!;
  const promptTemplate = match[2]!.trim();
  const config = parseYaml(yamlStr);

  if (config === null || config === undefined) {
    return { config: {}, promptTemplate };
  }

  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("WORKFLOW.md front matter must decode to an object");
  }

  return { config: config as Record<string, unknown>, promptTemplate };
}

export function loadWorkflowFile(filePath: string): WorkflowDefinition {
  const absPath = resolve(filePath);
  const content = readFileSync(absPath, "utf-8");
  return parseWorkflowFile(content);
}

export class WorkflowStore {
  private current: WorkflowDefinition | null = null;
  private lastError: Error | null = null;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.reload();
  }

  reload(): void {
    try {
      this.current = loadWorkflowFile(this.filePath);
      this.lastError = null;
      logger.info({ path: this.filePath }, "Workflow loaded");
    } catch (err) {
      this.lastError = err as Error;
      logger.error({ path: this.filePath, error: (err as Error).message }, "Workflow load failed");
    }
  }

  get(): WorkflowDefinition {
    if (!this.current) {
      throw this.lastError ?? new Error(`Workflow not loaded from ${this.filePath}`);
    }
    return this.current;
  }

  getOrNull(): WorkflowDefinition | null {
    return this.current;
  }

  getError(): Error | null {
    return this.lastError;
  }

  watch(): void {
    watchFile(this.filePath, { interval: 2000 }, () => {
      logger.info({ path: this.filePath }, "WORKFLOW.md changed, reloading");
      this.reload();
    });
  }

  unwatch(): void {
    unwatchFile(this.filePath);
  }
}
