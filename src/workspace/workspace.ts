/**
 * Per-issue workspace isolation with lifecycle hooks and path safety.
 */

import { existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import type { ServiceConfig } from "../config.js";
import { logger } from "../logger.js";

const SAFE_CHAR_RE = /[^A-Za-z0-9._-]/g;

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(SAFE_CHAR_RE, "_");
}

export function workspacePath(root: string, identifier: string): string {
  return join(resolve(root), sanitizeIdentifier(identifier));
}

/** Validate workspace path is strictly inside root. */
export function validateWorkspacePath(wsPath: string, root: string): void {
  const canonicalWs = realpathSync(resolve(wsPath));
  const canonicalRoot = realpathSync(resolve(root));

  if (canonicalWs === canonicalRoot) {
    throw new Error(`Workspace path equals root: ${canonicalWs}`);
  }

  if (!canonicalWs.startsWith(canonicalRoot + "/")) {
    throw new Error(`Workspace ${canonicalWs} is outside root ${canonicalRoot}`);
  }
}

export interface CreateWorkspaceResult {
  path: string;
  createdNow: boolean;
}

export function createWorkspace(root: string, identifier: string): CreateWorkspaceResult {
  const wsRoot = resolve(root);
  if (!existsSync(wsRoot)) {
    mkdirSync(wsRoot, { recursive: true });
  }

  const wsPath = workspacePath(root, identifier);

  if (existsSync(wsPath)) {
    validateWorkspacePath(wsPath, root);
    return { path: wsPath, createdNow: false };
  }

  mkdirSync(wsPath, { recursive: true });
  validateWorkspacePath(wsPath, root);
  return { path: wsPath, createdNow: true };
}

export function removeWorkspace(root: string, identifier: string): void {
  const wsPath = workspacePath(root, identifier);
  if (!existsSync(wsPath)) return;

  try {
    validateWorkspacePath(wsPath, root);
  } catch {
    logger.warn({ wsPath, root }, "Refusing to remove workspace outside root");
    return;
  }

  rmSync(wsPath, { recursive: true, force: true });
}

/** Run a shell hook in the workspace directory. */
export function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
  hookName: string,
  context: { issueId?: string; issueIdentifier?: string } = {}
): Promise<void> {
  const log = logger.child({ hook: hookName, cwd, ...context });
  log.info("Running workspace hook");

  return new Promise((resolve, reject) => {
    const proc = execFile("sh", ["-lc", script], { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const msg = `Hook ${hookName} failed: ${error.message}`;
        log.warn({ stdout: stdout.slice(0, 2048), stderr: stderr.slice(0, 2048) }, msg);
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });
}

/** Run workspace lifecycle hooks for a given phase. Returns true if hooks succeeded. */
export async function runLifecycleHook(
  config: ServiceConfig,
  hookName: "after_create" | "before_run" | "after_run" | "before_remove",
  wsPath: string,
  context: { issueId?: string; issueIdentifier?: string } = {}
): Promise<boolean> {
  const script = config.hooks[hookName];
  if (!script) return true;

  try {
    await runHook(script, wsPath, config.hooks.timeout_ms, hookName, context);
    return true;
  } catch (err) {
    // after_run and before_remove failures are non-fatal
    if (hookName === "after_run" || hookName === "before_remove") {
      return true;
    }
    return false;
  }
}

/** Full workspace preparation: create + after_create hook. */
export async function prepareWorkspace(
  config: ServiceConfig,
  identifier: string,
  context: { issueId?: string; issueIdentifier?: string } = {}
): Promise<string> {
  const result = createWorkspace(config.workspace.root, identifier);

  if (result.createdNow) {
    const hookOk = await runLifecycleHook(config, "after_create", result.path, context);
    if (!hookOk) {
      // Cleanup partially created workspace
      try {
        rmSync(result.path, { recursive: true, force: true });
      } catch { /* ignore */ }
      throw new Error(`after_create hook failed for workspace ${result.path}`);
    }
  }

  return result.path;
}
