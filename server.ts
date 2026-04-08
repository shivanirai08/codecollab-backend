import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import {
  importGitHubRepositoryIntoProject,
  ImportValidationError,
} from "./src/githubImport.ts";

const app = express();
const port = Number(process.env.PORT) || 5000;
const internalSecret = process.env.CODECOLLAB_INTERNAL_SECRET || "";

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
    const result = await importGitHubRepositoryIntoProject(req.body);
    res.status(201).json({
      message: "Repository imported successfully.",
      ...result,
    });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    const message =
      error instanceof Error ? error.message : "Failed to import repository.";

    console.error("GitHub import failed:", error);
    res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
