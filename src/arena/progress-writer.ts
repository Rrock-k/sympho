/**
 * Writes .arena/progress.json for the arena runner to pick up.
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface ArenaProgress {
  state: string;
  message?: string;
  iteration?: number;
  steps?: Array<{ id: string; label: string; status: string }>;
  custom?: Record<string, unknown>;
}

export class ProgressWriter {
  private progressFile: string;
  private doneFile: string;

  constructor(private workDir: string) {
    this.progressFile = join(workDir, ".arena", "progress.json");
    this.doneFile = join(workDir, ".arena", "done");
  }

  write(progress: ArenaProgress): void {
    mkdirSync(join(this.workDir, ".arena"), { recursive: true });
    writeFileSync(this.progressFile, JSON.stringify(progress));
  }

  markDone(): void {
    mkdirSync(join(this.workDir, ".arena"), { recursive: true });
    writeFileSync(this.doneFile, "");
  }

  clearDoneMarker(): void {
    try {
      if (existsSync(this.doneFile)) unlinkSync(this.doneFile);
    } catch { /* ignore */ }
  }

  isDone(): boolean {
    return existsSync(this.doneFile);
  }
}
