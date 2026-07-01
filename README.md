# CodeCollab Backend

Express + TypeScript backend powering Git repository import and Git operations for CodeCollab projects.

## Features

- GitHub repository import into an existing project
- Persistent repository worktree per project (not temporary clones)
- Project worktree sync operations for file create/update/delete/move
- Git status with branch, ahead/behind, conflicts, and file-level states
- File diff endpoint for staged and unstaged changes
- Stage and unstage endpoints (specific paths or all changes)
- Commit endpoint with validation for staged changes and conflict checks
- Push and pull endpoints with GitHub token auth support
- Git action error normalization with user-friendly error metadata
- Supabase REST integration for `nodes`, `projects`, `project_members`, and `project_repositories`
- Optional internal secret guard for backend endpoints

## Tech Stack

- Node.js
- Express 5
- TypeScript (runtime via `node --experimental-strip-types`)
- simple-git
- Supabase REST API

## API Endpoints

All routes are served from the backend root URL (for example `http://localhost:5000`).

### Health

- `GET /`

### GitHub Import

- `POST /github/import`

Imports a GitHub repository into an existing project, creates repository metadata, and persists nodes.

### Worktree Sync

- `POST /projects/:projectId/worktree/sync`

Applies one operation to the project worktree:

- create file/folder
- update file content
- delete file/folder
- move file/folder

### Git Operations

- `GET /projects/:projectId/git/status`
- `GET /projects/:projectId/git/diff?path=<relativePath>`
- `POST /projects/:projectId/git/stage`
- `POST /projects/:projectId/git/unstage`
- `POST /projects/:projectId/git/commit`
- `POST /projects/:projectId/git/push`
- `POST /projects/:projectId/git/pull`

## Environment Variables

Create a `.env` file in `backend/` (see `.env.example`).

Required:

- `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`

Recommended:

- `PORT=5000`
- `CODECOLLAB_INTERNAL_SECRET=<shared-secret-with-frontend>`

### Git worktree storage

| Environment | `CODECOLLAB_REPOS_ROOT` | On-disk path |
|-------------|-------------------------|--------------|
| **Local dev** | *(unset)* | `backend/.data/worktrees/<project-id>` (gitignored) |
| **Production (EC2 + EBS)** | `/var/lib/codecollab/worktrees` | EBS mount at same path |

Full setup guide: [`docs/worktree-storage-architecture.md`](../docs/worktree-storage-architecture.md)

## Install and Run

```bash
npm install
npm run dev
```

Production:

```bash
npm start
```

## Security Notes

- If `CODECOLLAB_INTERNAL_SECRET` is set, every protected request must send `x-codecollab-internal-secret`.
- GitHub tokens are used for authenticated Git operations but are not persisted in repository metadata.

## Project Structure

- `server.ts`: Express app and route wiring
- `src/githubImport.ts`: GitHub clone/import + node persistence
- `src/worktreePaths.ts`: Worktree path resolution (local `.data/worktrees` vs EC2 EBS)
- `src/gitRepositoryService.ts`: Git status/diff/stage/unstage/commit/push/pull + worktree sync
- `src/supabase.ts`: Supabase REST helpers for project/node/repository records
