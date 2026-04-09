import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import {
  applyWorktreeOperation,
  commitProjectChanges,
  getProjectFileDiff,
  getProjectGitStatus,
  getProjectGitStatusWithRemote,
  pullProjectChanges,
  pushProjectChanges,
  stageProjectChanges,
  unstageProjectChanges,
} from "./src/gitRepositoryService.ts";
import {
  importGitHubRepositoryIntoProject as importGitHubRepositoryIntoProjectLegacy,
  ImportValidationError as ImportValidationErrorLegacy,
} from "./src/githubImport.ts";

const app = express();
const port = Number(process.env.PORT) || 5000;
const internalSecret = process.env.CODECOLLAB_INTERNAL_SECRET || "";
type ProjectParams = { projectId: string };

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!internalSecret) {
    next();
    return;
  }

  const providedSecret = req.header("x-codecollab-internal-secret");

  if (!providedSecret || providedSecret !== internalSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

app.get("/", (_req: Request, res: Response) => {
  res.send("Backend running");
});

app.post("/github/import", requireInternalSecret, async (req: Request, res: Response) => {
  try {
    const result = await importGitHubRepositoryIntoProjectLegacy(req.body);
    res.status(201).json({
      message: "Repository imported successfully.",
      ...result,
    });
  } catch (error) {
    if (error instanceof ImportValidationErrorLegacy) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    const message =
      error instanceof Error ? error.message : "Failed to import repository.";

    console.error("GitHub import failed:", error);
    res.status(500).json({ error: message });
  }
});

app.post("/projects/:projectId/worktree/sync", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const projectId = req.params.projectId;
    await applyWorktreeOperation(projectId, req.body);
    res.status(200).json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to sync worktree.";
    res.status(400).json({ error: message });
  }
});

app.get("/projects/:projectId/git/status", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const githubToken = req.header("x-github-token") || undefined;
    const result = await getProjectGitStatusWithRemote(req.params.projectId, githubToken);
    res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load git status.";
    res.status(400).json({ error: message });
  }
});

app.get("/projects/:projectId/git/diff", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const relativePath = String(req.query.path || "").trim();

    if (!relativePath) {
      res.status(400).json({ error: "Query parameter 'path' is required." });
      return;
    }

    const result = await getProjectFileDiff(req.params.projectId, {
      relativePath,
      includeStaged: true,
      includeUnstaged: true,
    });

    res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load diff.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/commit", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await commitProjectChanges(req.params.projectId, req.body);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to commit changes.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/stage", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await stageProjectChanges(req.params.projectId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to stage changes.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/unstage", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await unstageProjectChanges(req.params.projectId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to unstage changes.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/push", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { githubToken } = req.body || {};
    const result = await pushProjectChanges(req.params.projectId, githubToken);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to push changes.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/pull", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { githubToken } = req.body || {};
    const result = await pullProjectChanges(req.params.projectId, githubToken);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to pull changes.";
    res.status(400).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
