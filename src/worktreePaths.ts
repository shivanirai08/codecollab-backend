import path from "path";
import { promises as fs } from "fs";

/**
 * Git worktree storage layout:
 *   ${CODECOLLAB_REPOS_ROOT}/${projectId}/
 *
 * Local dev default: backend/.data/worktrees/<projectId>  (gitignored)
 * Production (EC2):  EBS mount e.g. /var/lib/codecollab/worktrees/<projectId>
 */

const LOCAL_WORKTREES_ROOT = path.resolve(process.cwd(), ".data", "worktrees");
const PRODUCTION_ROOT_PREFIXES = ["/var/lib/codecollab", "/mnt/"];

export function sanitizeProjectId(projectId: string): string {
  return String(projectId || "").replace(/[^a-zA-Z0-9-_]/g, "");
}

function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}

function isProductionAbsolutePath(candidatePath: string): boolean {
  const resolved = path.resolve(candidatePath);
  return PRODUCTION_ROOT_PREFIXES.some(
    (prefix) => resolved === prefix || resolved.startsWith(`${prefix}/`)
  );
}

function getLocalWorktreesRoot(): string {
  return LOCAL_WORKTREES_ROOT;
}

export function getWorktreesRoot(): string {
  if (isLocalDevelopment()) {
    const configuredRoot = process.env.CODECOLLAB_REPOS_ROOT?.trim();
    if (configuredRoot && !isProductionAbsolutePath(path.resolve(configuredRoot))) {
      return path.resolve(configuredRoot);
    }

    return getLocalWorktreesRoot();
  }

  const configuredRoot = process.env.CODECOLLAB_REPOS_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return getLocalWorktreesRoot();
}

export function getProjectWorktreePath(projectId: string): string {
  const safeProjectId = sanitizeProjectId(projectId);
  if (!safeProjectId) {
    throw new Error("Invalid project id.");
  }

  return path.join(getWorktreesRoot(), safeProjectId);
}

async function directoryExists(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the on-disk worktree for a project.
 * Prefers the canonical path derived from CODECOLLAB_REPOS_ROOT so the same
 * Supabase row works across local dev and production without path rewrites.
 */
export async function resolveExistingWorktreePath(
  projectId: string,
  storedPath?: string | null
): Promise<string | null> {
  const canonicalPath = getProjectWorktreePath(projectId);

  if (await directoryExists(canonicalPath)) {
    return canonicalPath;
  }

  if (storedPath) {
    const canUseStoredPath =
      !isLocalDevelopment() || !isProductionAbsolutePath(storedPath);

    if (canUseStoredPath && (await directoryExists(storedPath))) {
      return storedPath;
    }
  }

  return null;
}

export async function ensureWorktreesRoot(): Promise<string> {
  const root = getWorktreesRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}
