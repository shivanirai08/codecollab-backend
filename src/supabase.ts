const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

type NodeInsertPayload = {
  project_id: string;
  parent_id: string | null;
  name: string;
  type: "file" | "folder";
  content: string;
  language?: string | null;
};

type NodeRow = {
  id: string;
};

export type ProjectRepositoryRow = {
  id: string;
  project_id: string;
  provider: string;
  github_repo_id: number | null;
  repo_name: string;
  repo_full_name: string;
  repo_url: string;
  clone_url: string | null;
  default_branch: string | null;
  current_branch: string;
  is_private: boolean;
  is_connected: boolean;
  last_synced_at: string | null;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  last_commit_sha: string | null;
  working_tree_path: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  install_status: string;
  sync_state: string;
  sync_error: string | null;
  remote_head_sha: string | null;
};

type ProjectRepositoryInsertPayload = {
  project_id: string;
  provider?: string;
  github_repo_id?: number | null;
  repo_name: string;
  repo_full_name: string;
  repo_url: string;
  clone_url?: string | null;
  default_branch?: string | null;
  current_branch: string;
  is_private?: boolean;
  is_connected?: boolean;
  last_synced_at?: string | null;
  last_pulled_at?: string | null;
  last_pushed_at?: string | null;
  last_commit_sha?: string | null;
  working_tree_path: string;
  created_by: string;
  install_status?: string;
  sync_state?: string;
  sync_error?: string | null;
  remote_head_sha?: string | null;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isMissingLanguageColumnError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return (
    message.includes("PGRST204") &&
    message.includes("language") &&
    message.includes("nodes")
  );
}

function getRestUrl(tableName: string): string {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are not configured.");
  }

  return `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${tableName}`;
}

async function supabaseRequest<T>(
  tableName: string,
  {
    method = "GET",
    body,
    query = "",
  }: { method?: string; body?: unknown; query?: string } = {}
): Promise<T | null> {
  const response = await fetch(`${getRestUrl(tableName)}${query}`, {
    method,
    headers: {
      apikey: serviceRoleKey as string,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Supabase request failed for ${tableName}.`);
  }

  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as T;
}

export async function createNodeRecord(payload: NodeInsertPayload): Promise<NodeRow> {
  try {
    const result = await supabaseRequest<NodeRow[]>("nodes", {
      method: "POST",
      body: payload,
    });

    if (!result?.[0]) {
      throw new Error("Failed to create node.");
    }

    return result[0];
  } catch (error) {
    if (isMissingLanguageColumnError(error)) {
      const { language, ...fallbackPayload } = payload;
      const result = await supabaseRequest<NodeRow[]>("nodes", {
        method: "POST",
        body: fallbackPayload,
      });

      if (!result?.[0]) {
        throw new Error("Failed to create node.");
      }

      return result[0];
    }

    throw error;
  }
}

export async function deleteProjectTree(projectId: string): Promise<void> {
  const encodedProjectId = encodeURIComponent(`eq.${projectId}`);

  await supabaseRequest("nodes", {
    method: "DELETE",
    query: `?project_id=${encodedProjectId}`,
  }).catch(() => {});

  await supabaseRequest("project_members", {
    method: "DELETE",
    query: `?project_id=${encodedProjectId}`,
  }).catch(() => {});

  await supabaseRequest("projects", {
    method: "DELETE",
    query: `?id=${encodedProjectId}`,
  }).catch(() => {});
}

export async function deleteProjectNodes(projectId: string): Promise<void> {
  const encodedProjectId = encodeURIComponent(`eq.${projectId}`);
  await supabaseRequest("nodes", {
    method: "DELETE",
    query: `?project_id=${encodedProjectId}`,
  });
}

export async function createProjectRepositoryRecord(
  payload: ProjectRepositoryInsertPayload
): Promise<ProjectRepositoryRow> {
  const result = await supabaseRequest<ProjectRepositoryRow[]>("project_repositories", {
    method: "POST",
    body: payload,
  });

  if (!result?.[0]) {
    throw new Error("Failed to create project repository record.");
  }

  return result[0];
}

export async function getProjectRepositoryRecord(
  projectId: string
): Promise<ProjectRepositoryRow | null> {
  const encodedProjectId = encodeURIComponent(`eq.${projectId}`);
  const result = await supabaseRequest<ProjectRepositoryRow[]>("project_repositories", {
    query: `?project_id=${encodedProjectId}&limit=1`,
  });

  return result?.[0] || null;
}

export async function updateProjectRepositoryRecord(
  projectId: string,
  updates: Partial<ProjectRepositoryRow>
): Promise<ProjectRepositoryRow | null> {
  const encodedProjectId = encodeURIComponent(`eq.${projectId}`);
  const result = await supabaseRequest<ProjectRepositoryRow[]>("project_repositories", {
    method: "PATCH",
    body: updates,
    query: `?project_id=${encodedProjectId}`,
  });

  return result?.[0] || null;
}

export async function deleteProjectRepositoryRecord(projectId: string): Promise<void> {
  const encodedProjectId = encodeURIComponent(`eq.${projectId}`);
  await supabaseRequest("project_repositories", {
    method: "DELETE",
    query: `?project_id=${encodedProjectId}`,
  }).catch(() => {});
}
