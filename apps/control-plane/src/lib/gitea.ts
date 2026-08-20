import { config } from "./config";
import { AppError } from "./errors";

interface GiteaRepository {
  name: string;
  clone_url: string;
  default_branch: string;
  owner: { login: string };
}

function authorizationHeader(): string {
  return `Basic ${Buffer.from(`${config.gitea.username}:${config.gitea.password}`).toString("base64")}`;
}

async function giteaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.gitea.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: authorizationHeader(),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AppError(
      `Gitea request failed (${response.status}): ${body || response.statusText}`,
      response.status >= 500 ? 502 : 400,
      "GITEA_REQUEST_FAILED",
    );
  }

  return (await response.json()) as T;
}

export async function createGiteaRepository(input: {
  name: string;
  description: string;
}): Promise<GiteaRepository> {
  return giteaRequest<GiteaRepository>("/api/v1/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      private: true,
      auto_init: true,
      default_branch: "main",
      readme: "Default",
    }),
  });
}

export async function ensureMainBranchProtection(input: {
  owner: string;
  repository: string;
  branch?: string;
}): Promise<void> {
  const branch = input.branch ?? "main";
  const path = `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/branch_protections`;
  const protectionPath = `${path}/${encodeURIComponent(branch)}`;
  const protection = {
    rule_name: branch,
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_usernames: [config.gitea.username],
    enable_force_push: false,
    required_approvals: 1,
    dismiss_stale_approvals: true,
    block_on_rejected_reviews: true,
    block_on_outdated_branch: true,
    block_admin_merge_override: false,
  };
  const existing = await fetch(`${config.gitea.baseUrl}${protectionPath}`, {
    headers: { Accept: "application/json", Authorization: authorizationHeader() },
  });
  if (existing.ok) {
    await giteaRequest(protectionPath, {
      method: "PATCH",
      body: JSON.stringify(protection),
    });
    return;
  }
  if (existing.status !== 404) {
    throw new AppError(
      `Unable to inspect Gitea branch protection (${existing.status})`,
      502,
      "GITEA_PROTECTION_FAILED",
    );
  }
  await giteaRequest(path, {
    method: "POST",
    body: JSON.stringify(protection),
  });
}

export function gitAuthenticationArguments(): string[] {
  return ["-c", `http.extraHeader=Authorization: ${authorizationHeader()}`];
}
