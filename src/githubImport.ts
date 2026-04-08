import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { simpleGit } from "simple-git";
import { createNodeRecord, deleteProjectTree } from "./supabase.ts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const MAX_TOTAL_FILES = 2000;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

type NodeType = "file" | "folder";

type RepositoryPayload = {
  name: string;
  fullName: string;
  private?: boolean;
  defaultBranch?: string | null;
  cloneUrl?: string | null;
};

type ImportPayload = {
  projectId?: string;
  githubToken?: string;
  repo?: RepositoryPayload;
};

type NodeRecordInput = {
  relativePath: string;
  parentRelativePath: string | null;
  name: string;
  type: NodeType;
  content?: string;
  language?: string | null;
};

type ImportStats = {
  totalFiles: number;
  importedNodes: number;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
};

export class ImportValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ImportValidationError";
    this.statusCode = statusCode;
  }
}

function sanitizeProjectId(projectId: string): string {
  return String(projectId || "").replace(/[^a-zA-Z0-9-_]/g, "");
}

function buildCloneUrl({
  fullName,
  cloneUrl,
  githubToken,
}: {
  fullName: string;
  cloneUrl?: string | null;
  githubToken: string;
}): string {
  const repoCloneUrl = cloneUrl || `https://github.com/${fullName}.git`;

  if (!repoCloneUrl.startsWith("https://github.com/")) {
    throw new ImportValidationError("Only GitHub repositories are supported.");
  }

  const encodedToken = encodeURIComponent(githubToken);
  return repoCloneUrl.replace(
    "https://github.com/",
    `https://x-access-token:${encodedToken}@github.com/`
  );
}

function inferLanguage(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();

  switch (ext) {
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".html":
      return "html";
    case ".md":
      return "markdown";
    case ".py":
      return "python";
    case ".java":
      return "java";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    case ".sh":
      return "shell";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".xml":
      return "xml";
    case ".sql":
      return "sql";
    default:
      return "plaintext";
  }
}

function isBinaryFile(buffer: Buffer): boolean {
  const bytesToCheck = Math.min(buffer.length, 8000);
  for (let index = 0; index < bytesToCheck; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function walkRepositoryTree(
  rootDirectory: string
): Promise<{ records: NodeRecordInput[]; stats: ImportStats }> {
  const records: NodeRecordInput[] = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;

  async function visitDirectory(
    currentDirectory: string,
    parentRelativePath: string | null = null
  ): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(rootDirectory, absolutePath);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }

        records.push({
          relativePath,
          parentRelativePath,
          name: entry.name,
          type: "folder",
        });

        await visitDirectory(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      totalFiles += 1;
      if (totalFiles > MAX_TOTAL_FILES) {
        throw new ImportValidationError(
          `Repository exceeds the ${MAX_TOTAL_FILES} file import limit.`
        );
      }

      const fileStat = await fs.stat(absolutePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        skippedLargeFiles += 1;
        continue;
      }

      const fileBuffer = await fs.readFile(absolutePath);
      if (isBinaryFile(fileBuffer)) {
        skippedBinaryFiles += 1;
        continue;
      }

      totalBytes += fileBuffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ImportValidationError(
          "Repository text content is too large to import into a project."
        );
      }

      records.push({
        relativePath,
        parentRelativePath,
        name: entry.name,
        type: "file",
        content: fileBuffer.toString("utf8"),
        language: inferLanguage(entry.name),
      });
    }
  }

  await visitDirectory(rootDirectory);

  return {
    records,
    stats: {
      totalFiles,
      importedNodes: records.length,
      skippedBinaryFiles,
      skippedLargeFiles,
    },
  };
}

async function persistRecords({
  projectId,
  records,
}: {
  projectId: string;
  records: NodeRecordInput[];
}): Promise<void> {
  const insertedNodeIdsByPath = new Map<string, string>();

  for (const record of records) {
    const parentId = record.parentRelativePath
      ? insertedNodeIdsByPath.get(record.parentRelativePath) || null
      : null;

    const createdNode = await createNodeRecord({
      project_id: projectId,
      parent_id: parentId,
      name: record.name,
      type: record.type,
      content: record.type === "file" ? record.content || "" : "",
    });

    insertedNodeIdsByPath.set(record.relativePath, createdNode.id);
  }
}

export async function importGitHubRepositoryIntoProject(payload: ImportPayload): Promise<{
  projectId: string;
  repository: {
    name: string;
    fullName: string;
    defaultBranch: string | null;
  };
  stats: ImportStats;
}> {
  const projectId = payload?.projectId;
  const githubToken = payload?.githubToken;
  const repo = payload?.repo;

  if (!projectId) {
    throw new ImportValidationError("Project id is required.");
  }

  if (!githubToken) {
    throw new ImportValidationError("GitHub token is required.", 401);
  }

  if (!repo?.name || !repo?.fullName) {
    throw new ImportValidationError("Repository details are incomplete.");
  }

  const safeProjectId = sanitizeProjectId(projectId);
  if (!safeProjectId) {
    throw new ImportValidationError("Invalid project id.");
  }

  const checkoutDirectory = path.join(
    os.tmpdir(),
    "codecollab-imports",
    `${safeProjectId}-${Date.now()}`
  );

  await fs.mkdir(checkoutDirectory, { recursive: true });

  try {
    const cloneUrl = buildCloneUrl({
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      githubToken,
    });

    const git = simpleGit();
    await git.clone(cloneUrl, checkoutDirectory, [
      "--depth",
      "1",
      "--single-branch",
      ...(repo.defaultBranch ? ["--branch", repo.defaultBranch] : []),
    ]);

    const { records, stats } = await walkRepositoryTree(checkoutDirectory);

    if (records.length === 0) {
      throw new ImportValidationError(
        "Repository does not contain importable text files."
      );
    }

    await persistRecords({ projectId, records });

    return {
      projectId,
      repository: {
        name: repo.name,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch || null,
      },
      stats,
    };
  } catch (error) {
    await deleteProjectTree(projectId).catch(() => {});
    throw error;
  } finally {
    await fs.rm(checkoutDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
