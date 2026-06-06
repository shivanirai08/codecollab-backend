import path from "path";
import { promises as fs } from "fs";
import { simpleGit } from "simple-git";
import {
  deleteProjectNodes,
  getProjectRepositoryRecord,
  updateProjectRepositoryRecord,
  getAllProjectNodes,
  updateNodeContent,
  deleteNodeById,
  createNodeRecord,
  type ProjectRepositoryRow,
} from "./supabase.ts";
import { persistRecords, walkRepositoryTree } from "./githubImport.ts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

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

export type GitActionSuggestion =
  | "pull"
  | "push"
  | "commit"
  | "stage"
  | "resolve-conflicts"
  | "connect-github"
  | "retry";

export type GitActionErrorResponse = {
  error: string;
  code: string;
  title: string;
  hint?: string;
  suggestedAction?: GitActionSuggestion;
  details?: string;
};

type GitActionErrorOptions = GitActionErrorResponse & {
  statusCode?: number;
};

export class GitActionError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly title: string;
  readonly hint?: string;
  readonly suggestedAction?: GitActionSuggestion;
  readonly details?: string;

  constructor(options: GitActionErrorOptions) {
    super(options.error);
    this.name = "GitActionError";
    this.statusCode = options.statusCode || 400;
    this.code = options.code;
    this.title = options.title;
    this.hint = options.hint;
    this.suggestedAction = options.suggestedAction;
    this.details = options.details;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeGitDetails(value: string): string | undefined {
  const sanitized = String(value || "").trim();
  return sanitized ? sanitized : undefined;
}

export function toGitActionErrorResponse(
  error: unknown,
  fallbackMessage: string,
  fallbackTitle = "Git action failed"
): GitActionErrorResponse {
  if (error instanceof GitActionError) {
    return {
      error: error.message,
      code: error.code,
      title: error.title,
      hint: error.hint,
      suggestedAction: error.suggestedAction,
      details: error.details,
    };
  }

  const rawMessage =
    error instanceof Error ? error.message : String(error || fallbackMessage);
  const message = collapseWhitespace(rawMessage);
  const details = sanitizeGitDetails(rawMessage);

  if (
    /non-fast-forward|failed to push some refs|updates were rejected because|tip of your current branch is behind/i.test(
      rawMessage
    )
  ) {
    return {
      error: "Pull the latest changes before pushing.",
      code: "remote-ahead",
      title: "Remote branch has new commits",
      hint: "Your branch is behind the remote branch. Pull, review any incoming changes, then push again.",
      suggestedAction: "pull",
      details,
    };
  }

  if (
    /authentication failed|could not read username|permission to .* denied|repository not found/i.test(
      rawMessage
    )
  ) {
    return {
      error: "GitHub rejected the request.",
      code: "github-auth-failed",
      title: "GitHub authorization needs attention",
      hint: "Reconnect your GitHub account or verify that you still have permission to this repository.",
      suggestedAction: "connect-github",
      details,
    };
  }

  if (
    /conflict|automatic merge failed|could not apply|merge conflict/i.test(
      rawMessage
    )
  ) {
    return {
      error: "Resolve the conflicting files before continuing.",
      code: "merge-conflict",
      title: "Git found conflicting changes",
      hint: "Open the conflicted files, remove the conflict markers, stage the files, and try again.",
      suggestedAction: "resolve-conflicts",
      details,
    };
  }

  if (/timed out|connection reset|network|econnrefused|unable to access/i.test(rawMessage)) {
    return {
      error: "The repository could not be reached right now.",
      code: "network-error",
      title: "Network request failed",
      hint: "Check your connection and try again in a moment.",
      suggestedAction: "retry",
      details,
    };
  }

  return {
    error: message || fallbackMessage,
    code: "git-operation-failed",
    title: fallbackTitle,
    hint: "Try again after refreshing the repository status.",
    suggestedAction: "retry",
    details,
  };
}

export function getGitActionErrorStatus(error: unknown): number {
  if (error instanceof GitActionError) {
    return error.statusCode;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  if (
    /non-fast-forward|failed to push some refs|updates were rejected because|conflict|automatic merge failed/i.test(
      message
    )
  ) {
    return 409;
  }

  if (/authentication failed|permission to .* denied|repository not found/i.test(message)) {
    return 401;
  }

  return 400;
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

  const configuredWorktreeRoot =
    process.env.CODECOLLAB_REPOS_ROOT ||
    path.join(process.cwd(), ".data", "worktrees");

  const pathExists = async (candidatePath: string): Promise<boolean> => {
    try {
      const stat = await fs.stat(candidatePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  let workingTreePath = repository.working_tree_path;
  const hasStoredWorktree = await pathExists(workingTreePath);

  if (!hasStoredWorktree) {
    const fallbackWorktreePath = path.join(configuredWorktreeRoot, projectId);
    const hasFallbackWorktree = await pathExists(fallbackWorktreePath);

    if (hasFallbackWorktree) {
      workingTreePath = fallbackWorktreePath;
      await updateProjectRepositoryRecord(projectId, {
        working_tree_path: fallbackWorktreePath,
      }).catch(() => {});
    } else {
      await updateProjectRepositoryRecord(projectId, {
        sync_state: "error",
        sync_error: `Repository worktree is missing at '${repository.working_tree_path}'.`,
      }).catch(() => {});

      throw new GitActionError({
        statusCode: 409,
        code: "repository-worktree-missing",
        title: "Repository worktree is unavailable",
        error: "Repository files are not available on this backend instance.",
        hint: "Re-import this repository from GitHub, or use the backend instance that originally imported it.",
        suggestedAction: "connect-github",
        details: `Missing path: ${repository.working_tree_path}`,
      });
    }
  }

  const git = simpleGit(workingTreePath);
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

type ConflictType =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "added-by-us"
  | "added-by-them"
  | "deleted-by-us"
  | "deleted-by-them"
  | "unmerged";

function resolveConflictType(code: string): ConflictType {
  switch (code) {
    case "UU": return "both-modified";
    case "AA": return "both-added";
    case "DD": return "both-deleted";
    case "AU": return "added-by-us";
    case "UA": return "added-by-them";
    case "DU": return "deleted-by-us";
    case "UD": return "deleted-by-them";
    default:   return "unmerged";
  }
}

export async function getProjectGitStatus(projectId: string): Promise<{
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  hasConflicts: boolean;
  conflictedPaths: string[];
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
    conflictType: ConflictType | null;
    staged: boolean;
    unstaged: boolean;
  }>;
}> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const status = await git.status();

  // simple-git parses the porcelain output and provides an authoritative set
  // of unmerged (conflicted) paths.  We use this as the primary source of truth
  // and fall back to the XY status-code analysis for any file that the array
  // might miss in edge cases.
  const conflictedPathSet = new Set(status.conflicted);

  const files = status.files.map((file) => {
    const indexStatus = file.index || " ";
    const workingTreeStatus = file.working_dir || " ";
    const code = `${indexStatus}${workingTreeStatus}`.trim() || "clean";
    const isUntracked = indexStatus === "?" || workingTreeStatus === "?";

    // Authoritative conflict check: simple-git's own conflicted list
    // PLUS the XY two-char codes that indicate an unmerged state.
    const isConflicted =
      conflictedPathSet.has(file.path) ||
      indexStatus === "U" ||
      workingTreeStatus === "U" ||
      code === "AA" ||
      code === "DD";

    const conflictType: ConflictType | null = isConflicted
      ? resolveConflictType(code)
      : null;

    return {
      path: file.path,
      indexStatus,
      workingTreeStatus,
      status: isConflicted ? "conflicted" : isUntracked ? "untracked" : code,
      conflictType,
      // Conflicted files must not appear as staged/unstaged – they need
      // conflict resolution before they can participate in staging.
      staged: !isConflicted && indexStatus !== " " && indexStatus !== "?",
      unstaged: !isConflicted && (workingTreeStatus !== " " || indexStatus === "?"),
    };
  });

  // For any file that simple-git placed in conflicted[] but that did not appear
  // in files[] (rare), add a synthetic sparse entry so the panel always shows it.
  for (const conflictedPath of status.conflicted) {
    if (!files.some((f) => f.path === conflictedPath)) {
      files.push({
        path: conflictedPath,
        indexStatus: "U",
        workingTreeStatus: "U",
        status: "conflicted",
        conflictType: "both-modified",
        staged: false,
        unstaged: false,
      });
    }
  }

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
    conflictedPaths: Array.from(conflictedPathSet),
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

export async function getProjectFileDiff(
  projectId: string,
  options: {
    relativePath: string;
    includeStaged?: boolean;
    includeUnstaged?: boolean;
  }
): Promise<{ path: string; diff: string; isConflicted?: boolean }> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const safePath = sanitizeRelativePath(options.relativePath);
  const includeStaged = options.includeStaged !== false;
  const includeUnstaged = options.includeUnstaged !== false;

  // Detect whether this file is currently unmerged BEFORE attempting a diff.
  // Unmerged files don't produce output from `git diff` – the working-tree
  // file itself holds the conflict markers (<<<<<<<, =======, >>>>>>>).
  // Reading the file directly is the only reliable way to surface them.
  const status = await git.status();
  const isConflicted = status.conflicted.includes(safePath);

  if (isConflicted) {
    const absolutePath = resolveWorktreePath(repository.working_tree_path, safePath);
    const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
    return { path: safePath, diff: content, isConflicted: true };
  }

  const chunks: string[] = [];

  if (includeStaged) {
    const stagedDiff = await git.diff(["--cached", "--", safePath]);
    if (stagedDiff.trim()) {
      chunks.push(stagedDiff.trimEnd());
    }
  }

  if (includeUnstaged) {
    const unstagedDiff = await git.diff(["--", safePath]);
    if (unstagedDiff.trim()) {
      chunks.push(unstagedDiff.trimEnd());
    }
  }

  if (chunks.length === 0) {
    const status = await git.status();
    const fileEntry = status.files.find((file) => file.path === safePath);
    const isUntracked =
      fileEntry?.index === "?" || fileEntry?.working_dir === "?";

    if (isUntracked) {
      const absolutePath = resolveWorktreePath(repository.working_tree_path, safePath);
      const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
      const contentLines = content.split("\n");
      const previewLines = contentLines.slice(0, 400);
      const addedLines = previewLines.map((line) => `+${line}`).join("\n");
      const lineCount = Math.max(previewLines.length, 1);

      const syntheticDiff = [
        `diff --git a/${safePath} b/${safePath}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${safePath}`,
        `@@ -0,0 +1,${lineCount} @@`,
        addedLines || "+",
      ].join("\n");

      chunks.push(syntheticDiff.trimEnd());
    }
  }

  return {
    path: safePath,
    diff: chunks.join("\n\n").trim(),
    isConflicted: false,
  };
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

    const status = await git.status();
    if (status.conflicted.length > 0) {
      throw new GitActionError({
        error: "Resolve merge conflicts before committing.",
        code: "commit-conflicts",
        title: "Conflicts need attention",
        hint: "Fix the conflicted files, stage them again, then commit.",
        suggestedAction: "resolve-conflicts",
        statusCode: 409,
      });
    }

    const hasStagedChanges = status.files.some(
      (file) => file.index && file.index !== " " && file.index !== "?"
    );

    if (!hasStagedChanges) {
      throw new GitActionError({
        error: "Stage at least one change before committing.",
        code: "nothing-staged",
        title: "Nothing is staged",
        hint: "Choose one or more changed files from the list, stage them, then commit.",
        suggestedAction: "stage",
        statusCode: 400,
      });
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

export async function stageProjectChanges(
  projectId: string,
  options: {
    paths?: string[];
    stageAll?: boolean;
  } = {}
): Promise<{ status: Awaited<ReturnType<typeof getProjectGitStatus>> }> {
  return withRepositorySyncState(projectId, async (repository) => {
    const git = simpleGit(repository.working_tree_path);
    const paths = (options.paths || [])
      .map((relativePath) => sanitizeRelativePath(relativePath))
      .filter(Boolean);

    if (!options.stageAll && paths.length === 0) {
      throw new GitActionError({
        error: "Select at least one file to stage.",
        code: "no-stage-selection",
        title: "No files selected",
        hint: "Pick one or more files from the changes list, then stage them.",
        suggestedAction: "stage",
        statusCode: 400,
      });
    }

    if (options.stageAll) {
      await git.add(".");
    } else {
      await git.add(paths);
    }

    return {
      status: await getProjectGitStatus(projectId),
    };
  });
}

export async function unstageProjectChanges(
  projectId: string,
  options: {
    paths?: string[];
    unstageAll?: boolean;
  } = {}
): Promise<{ status: Awaited<ReturnType<typeof getProjectGitStatus>> }> {
  return withRepositorySyncState(projectId, async (repository) => {
    const git = simpleGit(repository.working_tree_path);
    const paths = (options.paths || [])
      .map((relativePath) => sanitizeRelativePath(relativePath))
      .filter(Boolean);

    if (!options.unstageAll && paths.length === 0) {
      throw new GitActionError({
        error: "Select at least one file to unstage.",
        code: "no-unstage-selection",
        title: "No files selected",
        hint: "Pick one or more staged files before trying to unstage them.",
        suggestedAction: "stage",
        statusCode: 400,
      });
    }

    if (options.unstageAll) {
      await git.raw(["reset", "HEAD", "--", "."]);
    } else {
      await git.raw(["reset", "HEAD", "--", ...paths]);
    }

    return {
      status: await getProjectGitStatus(projectId),
    };
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
    const status = await git.status();

    if (status.conflicted.length > 0) {
      throw new GitActionError({
        error: "Resolve merge conflicts before pushing.",
        code: "push-conflicts",
        title: "Conflicts need attention",
        hint: "Finish resolving the conflicted files and commit the result before pushing.",
        suggestedAction: "resolve-conflicts",
        statusCode: 409,
      });
    }

    if (!status.isClean()) {
      throw new GitActionError({
        error: "Commit or discard local changes before pushing.",
        code: "push-dirty-worktree",
        title: "Finish local changes first",
        hint: "Push only sends committed work. Commit your changes or discard them, then try again.",
        suggestedAction: "commit",
        statusCode: 400,
      });
    }

    if ((status.ahead || 0) === 0) {
      throw new GitActionError({
        error: "There are no committed changes to push.",
        code: "nothing-to-push",
        title: "Nothing to push",
        hint: "Create a commit first, then push it to GitHub.",
        suggestedAction: "commit",
        statusCode: 400,
      });
    }

    if ((status.behind || 0) > 0) {
      throw new GitActionError({
        error: "Pull the latest changes before pushing.",
        code: "remote-ahead",
        title: "Remote branch has new commits",
        hint: "Your branch is behind the remote branch. Pull, review the updates, then push again.",
        suggestedAction: "pull",
        statusCode: 409,
      });
    }

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

type MergeResult = {
  updatedCount: number;
  createdCount: number;
  deletedCount: number;
  conflictedFiles: string[];
};

function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<<|^=======|^>>>>>>>/.test(content);
}

async function mergeWorktreeWithNodes(
  projectId: string,
  worktreePath: string
): Promise<MergeResult> {
  const currentNodes = await getAllProjectNodes(projectId);
  const { records: worktreeRecords } = await walkRepositoryTree(worktreePath);

  const currentNodesByPath = new Map(currentNodes.map((n) => [n.relativePath, n]));
  const worktreeByPath = new Map(worktreeRecords.map((r) => [r.relativePath, r]));

  let updatedCount = 0;
  let createdCount = 0;
  let deletedCount = 0;
  const conflictedFiles: string[] = [];

  // Build parent ID map for new nodes
  const insertedNodeIdsByPath = new Map<string, string>();
  for (const node of currentNodes) {
    insertedNodeIdsByPath.set(node.relativePath, node.id);
  }

  // Process worktree files: update existing or create new
  for (const [relativePath, worktreeRecord] of worktreeByPath) {
    const currentNode = currentNodesByPath.get(relativePath);

    if (currentNode) {
      // File exists in both: check if content changed
      if (worktreeRecord.type === "file" && currentNode.type === "file") {
        const newContent = worktreeRecord.content || "";
        if (newContent !== currentNode.content) {
          await updateNodeContent(currentNode.id, newContent);
          updatedCount++;

          if (hasConflictMarkers(newContent)) {
            conflictedFiles.push(relativePath);
          }
        }
      }
    } else {
      // New file in worktree: create node
      const parentRelativePath = worktreeRecord.parentRelativePath;
      const parentId = parentRelativePath
        ? insertedNodeIdsByPath.get(parentRelativePath) || null
        : null;

      const createdNode = await createNodeRecord({
        project_id: projectId,
        parent_id: parentId,
        name: worktreeRecord.name,
        type: worktreeRecord.type,
        content: worktreeRecord.type === "file" ? worktreeRecord.content || "" : "",
        language: worktreeRecord.language,
      });

      insertedNodeIdsByPath.set(relativePath, createdNode.id);
      createdCount++;

      if (
        worktreeRecord.type === "file" &&
        hasConflictMarkers(worktreeRecord.content || "")
      ) {
        conflictedFiles.push(relativePath);
      }
    }
  }

  // Process deleted files: remove nodes that no longer exist in worktree
  for (const [relativePath, currentNode] of currentNodesByPath) {
    if (!worktreeByPath.has(relativePath)) {
      // File deleted from worktree
      // Option: soft delete by marking, or hard delete
      // For now, hard delete to keep nodes in sync
      await deleteNodeById(currentNode.id);
      deletedCount++;
    }
  }

  return {
    updatedCount,
    createdCount,
    deletedCount,
    conflictedFiles,
  };
}

export async function pullProjectChanges(
  projectId: string,
  githubToken: string
): Promise<{ pulledAt: string; mergeResult?: MergeResult }> {
  return withAuthenticatedRemote(projectId, githubToken, async (git, repository) => {
    const status = await git.status();

    if (status.conflicted.length > 0) {
      throw new GitActionError({
        error: "Resolve merge conflicts before pulling.",
        code: "pull-conflicts",
        title: "Conflicts need attention",
        hint: "Finish resolving the conflicted files before pulling new changes.",
        suggestedAction: "resolve-conflicts",
        statusCode: 409,
      });
    }

    if (!status.isClean()) {
      throw new GitActionError({
        error: "Commit or discard local changes before pulling.",
        code: "pull-dirty-worktree",
        title: "Finish local changes first",
        hint: "Pull can reapply your branch on top of remote changes. Commit or discard local edits first.",
        suggestedAction: "commit",
        statusCode: 400,
      });
    }

    const branch = (await git.branch()).current || repository.current_branch;
    await git.pull("origin", branch, { "--rebase": null });
    const pulledAt = nowIso();
    
    // Smart merge: update existing nodes with new content, create new ones, delete removed ones
    const mergeResult = await mergeWorktreeWithNodes(projectId, repository.working_tree_path);

    await updateProjectRepositoryRecord(projectId, {
      current_branch: branch,
      last_pulled_at: pulledAt,
      last_commit_sha: await getLastCommitSha(git),
    });

    return { pulledAt, mergeResult };
  });
}

// File Query APIs for Phase 3

export async function getProjectFileTree(projectId: string): Promise<{
  tree: Array<{
    path: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    modified?: string;
  }>;
}> {
  const { repository } = await getSimpleGitForProject(projectId);
  const entries: Array<{
    path: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    modified?: string;
  }> = [];

  async function walkTree(dir: string, basePath = ""): Promise<void> {
    try {
      const entries_ = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries_) {
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;

          entries.push({
            path: relativePath,
            name: entry.name,
            type: "folder",
          });

          await walkTree(fullPath, relativePath);
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          entries.push({
            path: relativePath,
            name: entry.name,
            type: "file",
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      }
    } catch (error) {
      console.error(`Failed to walk tree: ${dir}`, error);
    }
  }

  await walkTree(repository.working_tree_path);

  return { tree: entries };
}

export async function getProjectFile(
  projectId: string,
  filePath: string
): Promise<{ content: string; path: string; size: number }> {
  const { repository } = await getSimpleGitForProject(projectId);
  const fullPath = path.join(repository.working_tree_path, filePath);

  // Security: prevent directory traversal
  const realPath = await fs.realpath(fullPath);
  const realRepoPath = await fs.realpath(repository.working_tree_path);
  if (!realPath.startsWith(realRepoPath)) {
    throw new GitActionError({
      error: "Access denied: path outside repository",
      code: "invalid-path",
      title: "Invalid file path",
      statusCode: 403,
    });
  }

  try {
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      throw new GitActionError({
        error: "Path is not a file",
        code: "not-a-file",
        title: "Invalid file",
        statusCode: 400,
      });
    }

    if (stat.size > 10 * 1024 * 1024) {
      throw new GitActionError({
        error: "File is too large (max 10 MB)",
        code: "file-too-large",
        title: "File too large",
        statusCode: 413,
      });
    }

    const buffer = await fs.readFile(realPath);
    const content = buffer.toString("utf8");

    return { content, path: filePath, size: stat.size };
  } catch (error) {
    if (error instanceof GitActionError) throw error;

    throw new GitActionError({
      error: `Failed to read file: ${String(error)}`,
      code: "file-read-error",
      title: "Could not read file",
      statusCode: 400,
    });
  }
}

export async function saveProjectFile(
  projectId: string,
  filePath: string,
  content: string
): Promise<{ saved: boolean; path: string }> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const fullPath = path.join(repository.working_tree_path, filePath);

  // Security: prevent directory traversal
  const realPath = await fs.realpath(fullPath).catch(async () => {
    // File doesn't exist yet, check parent
    const parentPath = path.dirname(fullPath);
    const realParent = await fs.realpath(parentPath);
    return path.join(realParent, path.basename(fullPath));
  });

  const realRepoPath = await fs.realpath(repository.working_tree_path);
  if (!realPath.startsWith(realRepoPath)) {
    throw new GitActionError({
      error: "Access denied: path outside repository",
      code: "invalid-path",
      title: "Invalid file path",
      statusCode: 403,
    });
  }

  try {
    // Create parent directories if needed
    const dir = path.dirname(realPath);
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(realPath, content, "utf8");

    // Update node content in DB
    const currentNodes = await getAllProjectNodes(projectId);
    const normalizedPath = filePath.replace(/\\/g, "/");
    const node = currentNodes.find((n) => n.relativePath === normalizedPath);

    if (node) {
      await updateNodeContent(node.id, content);
    }

    return { saved: true, path: filePath };
  } catch (error) {
    throw new GitActionError({
      error: `Failed to save file: ${String(error)}`,
      code: "file-write-error",
      title: "Could not save file",
      statusCode: 400,
    });
  }
}

// Branch Operations

export async function checkoutBranch(
  projectId: string,
  branch: string,
  githubToken: string
): Promise<{ branch: string; mergeResult: MergeResult }> {
  return withAuthenticatedRemote(projectId, githubToken, async (git, repository) => {
    const status = await git.status();

    if (!status.isClean() && status.conflicted.length === 0) {
      throw new GitActionError({
        error: "Commit or discard local changes before switching branches.",
        code: "dirty-worktree",
        title: "Finish local changes first",
        hint: "Stash or commit your changes, then try again.",
        suggestedAction: "commit",
        statusCode: 400,
      });
    }

    try {
      await git.checkout(branch);
      const checkoutBranch = (await git.branch()).current || branch;

      // Merge new branch tree with nodes
      const mergeResult = await mergeWorktreeWithNodes(projectId, repository.working_tree_path);

      await updateProjectRepositoryRecord(projectId, {
        current_branch: checkoutBranch,
        last_synced_at: nowIso(),
        last_commit_sha: await getLastCommitSha(git),
      });

      return { branch: checkoutBranch, mergeResult };
    } catch (error) {
      if (error instanceof GitActionError) throw error;

      throw new GitActionError({
        error: `Failed to checkout branch: ${String(error)}`,
        code: "checkout-failed",
        title: "Branch checkout failed",
        hint: "Make sure the branch exists and you have no uncommitted changes.",
        suggestedAction: "retry",
        statusCode: 400,
      });
    }
  });
}

export async function listBranches(projectId: string): Promise<{
  current: string;
  local: string[];
  remote: string[];
}> {
  const { repository, git } = await getSimpleGitForProject(projectId);

  try {
    const branchSummary = await git.branch(["-a"]);
    const current = branchSummary.current || repository.current_branch;

    const local = branchSummary.all
      .filter((b) => !b.startsWith("remotes/"))
      .sort();

    const remote = branchSummary.all
      .filter((b) => b.startsWith("remotes/origin/") && !b.endsWith("/HEAD"))
      .map((b) => b.replace("remotes/origin/", ""))
      .sort();

    return { current, local, remote };
  } catch (error) {
    throw new GitActionError({
      error: `Failed to list branches: ${String(error)}`,
      code: "list-branches-failed",
      title: "Could not list branches",
      statusCode: 500,
    });
  }
}

// Conflict Resolution Helpers

export async function resolveConflictTakeOurs(
  projectId: string,
  filePath: string
): Promise<{ resolved: boolean; path: string }> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const fullPath = path.join(repository.working_tree_path, filePath);

  try {
    // Read file with conflicts
    const content = await fs.readFile(fullPath, "utf8");

    // Extract "ours" section (before =======)
    const oursMatch = content.match(/^<<<<<<<[^\n]*\n([\s\S]*?)\n=======\n[\s\S]*?\n>>>>>>>[^\n]*$/m);
    if (!oursMatch) {
      throw new Error("No conflict markers found in file");
    }

    const resolved = oursMatch[1];
    await fs.writeFile(fullPath, resolved, "utf8");

    // Stage the resolved file
    await git.add(filePath);

    // Update node
    const currentNodes = await getAllProjectNodes(projectId);
    const normalizedPath = filePath.replace(/\\/g, "/");
    const node = currentNodes.find((n) => n.relativePath === normalizedPath);

    if (node) {
      await updateNodeContent(node.id, resolved);
    }

    return { resolved: true, path: filePath };
  } catch (error) {
    throw new GitActionError({
      error: `Failed to resolve conflict: ${String(error)}`,
      code: "resolve-failed",
      title: "Could not resolve conflict",
      statusCode: 400,
    });
  }
}

export async function resolveConflictTakeThem(
  projectId: string,
  filePath: string
): Promise<{ resolved: boolean; path: string }> {
  const { repository, git } = await getSimpleGitForProject(projectId);
  const fullPath = path.join(repository.working_tree_path, filePath);

  try {
    // Read file with conflicts
    const content = await fs.readFile(fullPath, "utf8");

    // Extract "theirs" section (after =======)
    const theirsMatch = content.match(/^<<<<<<<[^\n]*\n[\s\S]*?\n=======\n([\s\S]*?)\n>>>>>>>[^\n]*$/m);
    if (!theirsMatch) {
      throw new Error("No conflict markers found in file");
    }

    const resolved = theirsMatch[1];
    await fs.writeFile(fullPath, resolved, "utf8");

    // Stage the resolved file
    await git.add(filePath);

    // Update node
    const currentNodes = await getAllProjectNodes(projectId);
    const normalizedPath = filePath.replace(/\\/g, "/");
    const node = currentNodes.find((n) => n.relativePath === normalizedPath);

    if (node) {
      await updateNodeContent(node.id, resolved);
    }

    return { resolved: true, path: filePath };
  } catch (error) {
    throw new GitActionError({
      error: `Failed to resolve conflict: ${String(error)}`,
      code: "resolve-failed",
      title: "Could not resolve conflict",
      statusCode: 400,
    });
  }
}

