import path from "path";
import { promises as fs } from "fs";
import { simpleGit } from "simple-git";
import {
  deleteProjectNodes,
  getProjectRepositoryRecord,
  updateProjectRepositoryRecord,
  type ProjectRepositoryRow,
} from "./supabase.ts";
import { persistRecords, walkRepositoryTree } from "./githubImport.ts";

type WorktreeOperation =
  | {
      type: "create";
      relativePath: string;
      nodeType: "file" | "folder";
      content?: string;
    }
  | {
      type: "update";
      relativePath: string;
      content: string;
    }
  | {
      type: "delete";
      relativePath: string;
    }
  | {
      type: "move";
      fromRelativePath: string;
      toRelativePath: string;
      nodeType: "file" | "folder";
    };

function nowIso(): string {
  return new Date().toISOString();
}

function getCleanCloneUrl(repository: ProjectRepositoryRow): string {
  return repository.clone_url || `https://github.com/${repository.repo_full_name}.git`;
}

function getAuthenticatedCloneUrl(
  repository: ProjectRepositoryRow,
  githubToken: string
): string {
  const cleanCloneUrl = getCleanCloneUrl(repository);

  if (!cleanCloneUrl.startsWith("https://github.com/")) {
    throw new Error("Only GitHub HTTPS repositories are supported.");
  }

  const encodedToken = encodeURIComponent(githubToken);
  return cleanCloneUrl.replace(
    "https://github.com/",
    `https://x-access-token:${encodedToken}@github.com/`
  );
}

function sanitizeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(String(relativePath || "").trim());

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Invalid relative path.");
  }

  return normalized.replace(/^\/+/, "");
}

function resolveWorktreePath(rootPath: string, relativePath: string): string {
  const safeRelativePath = sanitizeRelativePath(relativePath);
  const absolutePath = path.resolve(rootPath, safeRelativePath);
  const absoluteRootPath = path.resolve(rootPath);

  if (
    absolutePath !== absoluteRootPath &&
    !absolutePath.startsWith(`${absoluteRootPath}${path.sep}`)
  ) {
    throw new Error("Resolved path is outside the repository worktree.");
  }

  return absolutePath;
}

async function withRepositorySyncState<T>(
  projectId: string,
  fn: (repository: ProjectRepositoryRow) => Promise<T>
): Promise<T> {
  const repository = await getProjectRepositoryRecord(projectId);

  if (!repository?.is_connected) {
    throw new Error("Project repository is not connected.");
  }

  await updateProjectRepositoryRecord(projectId, {
    sync_state: "syncing",
    sync_error: null,
  });

  try {
    const result = await fn(repository);
    await updateProjectRepositoryRecord(projectId, {
      sync_state: "idle",
      sync_error: null,
      last_synced_at: nowIso(),
    });
    return result;
  } catch (error) {
    await updateProjectRepositoryRecord(projectId, {
      sync_state: "error",
      sync_error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

export async function ensureOriginRemote(repository: ProjectRepositoryRow): Promise<void> {
  const git = simpleGit(repository.working_tree_path);
  await git.remote(["set-url", "origin", getCleanCloneUrl(repository)]);
}

async function getSimpleGitForProject(projectId: string): Promise<{
  repository: ProjectRepositoryRow;
  git: ReturnType<typeof simpleGit>;
}> {
  const repository = await getProjectRepositoryRecord(projectId);

  if (!repository?.is_connected) {
    throw new Error("Project repository is not connected.");
  }

  const git = simpleGit(repository.working_tree_path);
  return { repository, git };
}

async function getLastCommitSha(git: ReturnType<typeof simpleGit>): Promise<string | null> {
  try {
    const rev = await git.revparse(["HEAD"]);
    return rev?.trim() || null;
  } catch {
    return null;
  }
}

export async function applyWorktreeOperation(
  projectId: string,
  operation: WorktreeOperation
): Promise<void> {
  await withRepositorySyncState(projectId, async (repository) => {
    const rootPath = repository.working_tree_path;

    if (operation.type === "create") {
      const absolutePath = resolveWorktreePath(rootPath, operation.relativePath);

      if (operation.nodeType === "folder") {
        await fs.mkdir(absolutePath, { recursive: true });
        return;
      }

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, operation.content || "", "utf8");
      return;
    }

    if (operation.type === "update") {
      const absolutePath = resolveWorktreePath(rootPath, operation.relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, operation.content, "utf8");
      return;
    }

    if (operation.type === "delete") {
      const absolutePath = resolveWorktreePath(rootPath, operation.relativePath);
      await fs.rm(absolutePath, { recursive: true, force: true });
      return;
    }

    const fromPath = resolveWorktreePath(rootPath, operation.fromRelativePath);
    const toPath = resolveWorktreePath(rootPath, operation.toRelativePath);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
  });
}

export async function getProjectGitStatus(projectId: string): Promise<{
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  hasConflicts: boolean;
  summary: {
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    untracked: number;
    conflicted: number;
  };
  files: Array<{
    path: string;
    indexStatus: string;
    workingTreeStatus: string;
    status: string;
    staged: boolean;
    unstaged: boolean;
  }>;
}> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const status = await git.status();
  const files = status.files.map((file) => {
    const indexStatus = file.index || " ";
    const workingTreeStatus = file.working_dir || " ";
    const code = `${indexStatus}${workingTreeStatus}`.trim() || "clean";
    const isUntracked = indexStatus === "?" || workingTreeStatus === "?";
    const isConflicted =
      indexStatus === "U" ||
      workingTreeStatus === "U" ||
      code.includes("AA") ||
      code.includes("DD");

    return {
      path: file.path,
      indexStatus,
      workingTreeStatus,
      status: isConflicted ? "conflicted" : isUntracked ? "untracked" : code,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged:
        workingTreeStatus !== " " ||
        indexStatus === "?" ||
        workingTreeStatus === "?",
    };
  });

  const summary = {
    modified: files.filter((file) => file.status.includes("M")).length,
    added: files.filter((file) => file.status.includes("A")).length,
    deleted: files.filter((file) => file.status.includes("D")).length,
    renamed: files.filter((file) => file.status.includes("R")).length,
    untracked: files.filter((file) => file.status === "untracked").length,
    conflicted: files.filter((file) => file.status === "conflicted").length,
  };

  const branch = status.current || repository.current_branch || null;

  await updateProjectRepositoryRecord(projectId, {
    current_branch: branch || repository.current_branch,
    last_commit_sha: await getLastCommitSha(git),
    remote_head_sha: status.tracking || repository.remote_head_sha,
    last_synced_at: nowIso(),
    sync_state: "idle",
    sync_error: null,
  }).catch(() => {});

  return {
    branch,
    tracking: status.tracking || null,
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    isClean: status.isClean(),
    hasConflicts: summary.conflicted > 0,
    summary,
    files,
  };
}

export async function getProjectGitStatusWithRemote(
  projectId: string,
  githubToken?: string
): Promise<{
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  hasConflicts: boolean;
  summary: {
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    untracked: number;
    conflicted: number;
  };
  files: Array<{
    path: string;
    indexStatus: string;
    workingTreeStatus: string;
    status: string;
    staged: boolean;
    unstaged: boolean;
  }>;
}> {
  const { git } = await getSimpleGitForProject(projectId);

  try {
    await git.raw(["fetch", "origin", "--prune"]);
    return getProjectGitStatus(projectId);
  } catch (error) {
    if (!githubToken) {
      return getProjectGitStatus(projectId);
    }

    try {
      return await withAuthenticatedRemote(projectId, githubToken, async (authGit) => {
        await authGit.raw(["fetch", "origin", "--prune"]);
        return getProjectGitStatus(projectId);
      });
    } catch {
      return getProjectGitStatus(projectId);
    }
  }
}

export async function commitProjectChanges(
  projectId: string,
  {
    message,
    authorName,
    authorEmail,
  }: {
    message: string;
    authorName: string;
    authorEmail: string;
  }
): Promise<{ commitSha: string | null }> {
  return withRepositorySyncState(projectId, async (repository) => {
    const git = simpleGit(repository.working_tree_path);
    await git.addConfig("user.name", authorName);
    await git.addConfig("user.email", authorEmail);
    await git.add(".");

    const status = await git.status();
    if (status.isClean()) {
      throw new Error("There are no changes to commit.");
    }

    const result = await git.commit(message);
    const commitSha = result.commit || (await getLastCommitSha(git));

    await updateProjectRepositoryRecord(projectId, {
      last_commit_sha: commitSha,
      current_branch: status.current || repository.current_branch,
    });

    return { commitSha };
  });
}

async function withAuthenticatedRemote<T>(
  projectId: string,
  githubToken: string,
  fn: (git: ReturnType<typeof simpleGit>, repository: ProjectRepositoryRow) => Promise<T>
): Promise<T> {
  return withRepositorySyncState(projectId, async (repository) => {
    const git = simpleGit(repository.working_tree_path);
    const cleanCloneUrl = getCleanCloneUrl(repository);
    const authenticatedCloneUrl = getAuthenticatedCloneUrl(repository, githubToken);

    await git.remote(["set-url", "origin", authenticatedCloneUrl]);

    try {
      return await fn(git, repository);
    } finally {
      await git.remote(["set-url", "origin", cleanCloneUrl]).catch(() => {});
    }
  });
}

export async function pushProjectChanges(
  projectId: string,
  githubToken: string
): Promise<{ pushedAt: string }> {
  return withAuthenticatedRemote(projectId, githubToken, async (git, repository) => {
    const branch = (await git.branch()).current || repository.current_branch;
    await git.push("origin", branch);
    const pushedAt = nowIso();

    await updateProjectRepositoryRecord(projectId, {
      current_branch: branch,
      last_pushed_at: pushedAt,
      last_commit_sha: await getLastCommitSha(git),
    });

    return { pushedAt };
  });
}

export async function pullProjectChanges(
  projectId: string,
  githubToken: string
): Promise<{ pulledAt: string }> {
  return withAuthenticatedRemote(projectId, githubToken, async (git, repository) => {
    const branch = (await git.branch()).current || repository.current_branch;
    await git.pull("origin", branch, { "--rebase": null });
    const pulledAt = nowIso();
    const { records } = await walkRepositoryTree(repository.working_tree_path);
    await deleteProjectNodes(projectId);
    await persistRecords({ projectId, records });

    await updateProjectRepositoryRecord(projectId, {
      current_branch: branch,
      last_pulled_at: pulledAt,
      last_commit_sha: await getLastCommitSha(git),
    });

    return { pulledAt };
  });
}
