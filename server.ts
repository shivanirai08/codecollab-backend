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
  continuePendingGitOperation,
  getGitActionErrorStatus,
  getProjectFileDiff,
  getProjectFileCompare,
  getProjectGitStatus,
  getProjectGitStatusWithRemote,
  pullProjectChanges,
  pushProjectChanges,
  stageProjectChanges,
  toGitActionErrorResponse,
  unstageProjectChanges,
  discardProjectChanges,
  getProjectFileTree,
  getProjectFile,
  saveProjectFile,
  checkoutBranch,
  listBranches,
  resolveConflictTakeOurs,
  resolveConflictTakeThem,
} from "./src/gitRepositoryService.ts";
import {
  importGitHubRepositoryIntoProject as importGitHubRepositoryIntoProjectLegacy,
  ImportValidationError as ImportValidationErrorLegacy,
} from "./src/githubImport.ts";

const app = express();
const port = Number(process.env.PORT) || 5000;
const internalSecret = process.env.CODECOLLAB_INTERNAL_SECRET || "";
type ProjectParams = { projectId: string };

type ApiRouteDoc = {
  method: "GET" | "POST";
  path: string;
  access: "public" | "internal-secret";
  description: string;
};

const apiRouteDocs: ApiRouteDoc[] = [
  {
    method: "GET",
    path: "/",
    access: "public",
    description: "Basic backend status text response.",
  },
  {
    method: "GET",
    path: "/health",
    access: "public",
    description: "Health check payload for uptime and status monitoring.",
  },
  {
    method: "GET",
    path: "/healthz",
    access: "public",
    description: "Compatibility alias that redirects to /health.",
  },
  {
    method: "GET",
    path: "/docs",
    access: "public",
    description: "Human-friendly API documentation page.",
  },
  {
    method: "GET",
    path: "/docs.json",
    access: "public",
    description: "Machine-readable API endpoint documentation.",
  },
  {
    method: "POST",
    path: "/github/import",
    access: "internal-secret",
    description: "Imports a GitHub repository into a project workspace.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/worktree/sync",
    access: "internal-secret",
    description: "Applies worktree file operations for a project.",
  },
  {
    method: "GET",
    path: "/projects/:projectId/git/status",
    access: "internal-secret",
    description: "Returns local and remote git status for a project.",
  },
  {
    method: "GET",
    path: "/projects/:projectId/git/diff",
    access: "internal-secret",
    description: "Returns file diff for the provided project path query.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/commit",
    access: "internal-secret",
    description: "Creates a git commit and returns updated status.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/stage",
    access: "internal-secret",
    description: "Stages project file changes.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/unstage",
    access: "internal-secret",
    description: "Unstages project file changes.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/discard",
    access: "internal-secret",
    description: "Discards unstaged or staged file changes.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/continue",
    access: "internal-secret",
    description: "Continues an in-progress rebase after conflicts are resolved.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/push",
    access: "internal-secret",
    description: "Pushes local project commits to remote.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/pull",
    access: "internal-secret",
    description: "Pulls remote project changes into local workspace.",
  },
  {
    method: "GET",
    path: "/projects/:projectId/files",
    access: "internal-secret",
    description: "Returns live folder tree from repository worktree.",
  },
  {
    method: "GET",
    path: "/projects/:projectId/file",
    access: "internal-secret",
    description: "Returns file content from worktree (query: path=src/App.jsx).",
  },
  {
    method: "POST",
    path: "/projects/:projectId/file",
    access: "internal-secret",
    description: "Saves file content to worktree and syncs to nodes.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/checkout",
    access: "internal-secret",
    description: "Switches to a different git branch.",
  },
  {
    method: "GET",
    path: "/projects/:projectId/git/branches",
    access: "internal-secret",
    description: "Lists local and remote branches.",
  },
  {
    method: "POST",
    path: "/projects/:projectId/git/resolve-conflict",
    access: "internal-secret",
    description: "Resolves merge conflict by taking ours or theirs.",
  },
];

function renderApiDocsHtml(baseUrl: string): string {
  const endpointRows = apiRouteDocs
    .map((route) => {
      const accessBadge =
        route.access === "public"
          ? '<span class="badge badge-public">public</span>'
          : '<span class="badge badge-internal">internal-secret</span>';

      return `
        <tr>
          <td><span class="method ${route.method.toLowerCase()}">${route.method}</span></td>
          <td><code>${route.path}</code></td>
          <td>${accessBadge}</td>
          <td>${route.description}</td>
        </tr>
      `;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeCollab Backend API Docs</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --line: #e5e7eb;
      --green: #047857;
      --blue: #1d4ed8;
      --orange: #b45309;
      --pink: #9d174d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Noto Sans", sans-serif;
      background: radial-gradient(circle at top right, #e8ecff, var(--bg));
      color: var(--text);
      padding: 32px 16px;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(31, 41, 55, 0.08);
    }
    header {
      padding: 24px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, #f8faff 0%, #fdf2f8 100%);
    }
    h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: -0.02em;
    }
    p { margin: 10px 0 0; color: var(--muted); }
    .content { padding: 24px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 18px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      background: #fff;
    }
    .card h2 {
      margin: 0 0 8px;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    .card code {
      display: block;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f9fafb;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      color: #111827;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
    }
    th {
      background: #f9fafb;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: 0; }
    .method {
      font-size: 12px;
      letter-spacing: 0.04em;
      font-weight: 700;
      border-radius: 999px;
      padding: 3px 8px;
      display: inline-block;
      min-width: 48px;
      text-align: center;
    }
    .method.get { background: #dbeafe; color: var(--blue); }
    .method.post { background: #ffe4e6; color: var(--pink); }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .badge-public { background: #d1fae5; color: var(--green); }
    .badge-internal { background: #ffedd5; color: var(--orange); }
    footer {
      margin-top: 16px;
      color: var(--muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="container">
    <header>
      <h1>CodeCollab Backend API Docs</h1>
      <p>Base URL: <code>${baseUrl}</code></p>
    </header>
    <section class="content">
      <div class="grid">
        <article class="card">
          <h2>Health Check</h2>
          <code>curl -sS ${baseUrl}/health</code>
        </article>
        <article class="card">
          <h2>Full Docs JSON</h2>
          <code>curl -sS ${baseUrl}/docs.json</code>
        </article>
        <article class="card">
          <h2>Protected Endpoint Example</h2>
          <code>curl -sS -X GET '${baseUrl}/projects/PROJECT_ID/git/status' -H 'x-codecollab-internal-secret: YOUR_SECRET'</code>
        </article>
      </div>

      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Access</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          ${endpointRows}
        </tbody>
      </table>

      <footer>
        Protected endpoints require the header x-codecollab-internal-secret when CODECOLLAB_INTERNAL_SECRET is configured.
      </footer>
    </section>
  </main>
</body>
</html>`;
}

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

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "codecollab-backend",
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.redirect(302, "/health");
});

app.get("/docs", (req: Request, res: Response) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.status(200).type("html").send(renderApiDocsHtml(baseUrl));
});

app.get("/docs.json", (req: Request, res: Response) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.status(200).json({
    service: "codecollab-backend",
    generatedAt: new Date().toISOString(),
    baseUrl,
    auth: {
      type: "header",
      headerName: "x-codecollab-internal-secret",
      requiredWhenConfigured: true,
    },
    endpoints: apiRouteDocs,
  });
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
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to load git status.", "Git status failed"));
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

app.get("/projects/:projectId/git/compare", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const relativePath = String(req.query.path || "").trim();

    if (!relativePath) {
      res.status(400).json({ error: "Query parameter 'path' is required." });
      return;
    }

    const result = await getProjectFileCompare(req.params.projectId, relativePath);
    res.status(200).json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load file comparison.";
    res.status(400).json({ error: message });
  }
});

app.post("/projects/:projectId/git/commit", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await commitProjectChanges(req.params.projectId, req.body);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to commit changes.", "Commit failed"));
  }
});

app.post("/projects/:projectId/git/stage", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await stageProjectChanges(req.params.projectId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to stage changes.", "Stage failed"));
  }
});

app.post("/projects/:projectId/git/unstage", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await unstageProjectChanges(req.params.projectId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to unstage changes.", "Unstage failed"));
  }
});

app.post("/projects/:projectId/git/discard", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await discardProjectChanges(req.params.projectId, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to discard changes.", "Discard failed"));
  }
});

app.post("/projects/:projectId/git/continue", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await continuePendingGitOperation(req.params.projectId);
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to continue git operation.", "Continue failed"));
  }
});

app.post("/projects/:projectId/git/push", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { githubToken } = req.body || {};
    const result = await pushProjectChanges(req.params.projectId, githubToken);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to push changes.", "Push failed"));
  }
});

app.post("/projects/:projectId/git/pull", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { githubToken } = req.body || {};
    const result = await pullProjectChanges(req.params.projectId, githubToken);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to pull changes.", "Pull failed"));
  }
});

// File Query APIs (Phase 3)

app.get("/projects/:projectId/files", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await getProjectFileTree(req.params.projectId);
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to get file tree.", "File tree query failed"));
  }
});

app.get("/projects/:projectId/file", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "Missing query parameter: path" });
      return;
    }
    const result = await getProjectFile(req.params.projectId, filePath);
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to get file.", "File read failed"));
  }
});

app.post("/projects/:projectId/file", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { filePath, content } = req.body || {};
    if (!filePath || typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid parameters: filePath, content" });
      return;
    }
    const result = await saveProjectFile(req.params.projectId, filePath, content);
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to save file.", "File write failed"));
  }
});

// Branch Operations

app.post("/projects/:projectId/git/checkout", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { branch, githubToken } = req.body || {};
    if (!branch) {
      res.status(400).json({ error: "Missing parameter: branch" });
      return;
    }
    const result = await checkoutBranch(req.params.projectId, branch, githubToken);
    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to checkout branch.", "Checkout failed"));
  }
});

app.get("/projects/:projectId/git/branches", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const result = await listBranches(req.params.projectId);
    res.status(200).json(result);
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to list branches.", "Branches query failed"));
  }
});

// Conflict Resolution

app.post("/projects/:projectId/git/resolve-conflict", requireInternalSecret, async (req: Request<ProjectParams>, res: Response) => {
  try {
    const { filePath, strategy } = req.body || {};
    if (!filePath || !strategy || !["ours", "theirs"].includes(strategy)) {
      res.status(400).json({ error: "Missing or invalid parameters: filePath, strategy (ours|theirs)" });
      return;
    }

    const result = strategy === "ours"
      ? await resolveConflictTakeOurs(req.params.projectId, filePath)
      : await resolveConflictTakeThem(req.params.projectId, filePath);

    const status = await getProjectGitStatus(req.params.projectId);
    res.status(200).json({ ...result, status });
  } catch (error) {
    res
      .status(getGitActionErrorStatus(error))
      .json(toGitActionErrorResponse(error, "Failed to resolve conflict.", "Conflict resolution failed"));
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
