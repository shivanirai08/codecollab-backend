import path from "path";
import { promises as fs } from "fs";

/**
 * Git worktree storage layout:
 *   ${CODECOLLAB_REPOS_ROOT}/${projectId}/
 *
 * Local dev default: backend/.data/worktrees/<projectId>  (gitignored)
 * Production (EC2):  EBS mount e.g. /var/lib/codecollab/worktrees/<projectId>
 */
export function sanitizeProjectId(projectId: string): string {
  return String(projectId || "").replace(/[^a-zA-Z0-9-_]/g, "");
}

export function getWorktreesRoot(): string {
  const configuredRoot = process.env.CODECOLLAB_REPOS_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return path.resolve(process.cwd(), ".data", "worktrees");
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

  if (storedPath && (await directoryExists(storedPath))) {
    return storedPath;
  }

  return null;
}

export async function ensureWorktreesRoot(): Promise<string> {
  const root = getWorktreesRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}
