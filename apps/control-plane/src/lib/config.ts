import { existsSync } from "node:fs";
import path from "node:path";

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);

  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = path.dirname(current);
  }

  throw new Error("Unable to locate the CloudAgent repository root");
}

const repositoryRoot = process.env.CLOUDAGENT_ROOT
  ? path.resolve(process.env.CLOUDAGENT_ROOT)
  : findRepositoryRoot(process.cwd());

const databaseUser = process.env.POSTGRES_USER ?? "cloudagent";
const databasePassword = process.env.POSTGRES_PASSWORD ?? "cloudagent-local-change-me";
const databasePort = process.env.POSTGRES_PORT ?? "5432";

export const config = {
  repositoryRoot,
  runtimeRoot: process.env.CLOUDAGENT_RUNTIME_ROOT
    ? path.resolve(process.env.CLOUDAGENT_RUNTIME_ROOT)
    : path.join(repositoryRoot, "runtime"),
  databaseUrl:
    process.env.DATABASE_URL ??
    `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@127.0.0.1:${databasePort}/${encodeURIComponent(databaseUser)}`,
  gitea: {
    baseUrl: process.env.GITEA_BASE_URL ?? "http://127.0.0.1:3100",
    owner: process.env.GITEA_ADMIN_USER ?? "cloudagent-admin",
    username: process.env.GITEA_ADMIN_USER ?? "cloudagent-admin",
    password: process.env.GITEA_ADMIN_PASSWORD ?? "cloudagent-admin-change-me",
  },
  openbao: {
    baseUrl: `http://127.0.0.1:${process.env.OPENBAO_PORT ?? "8200"}`,
    token: process.env.OPENBAO_DEV_ROOT_TOKEN ?? "cloudagent-local-root-token",
  },
  temporal: {
    address: process.env.TEMPORAL_ADDRESS ?? `127.0.0.1:${process.env.TEMPORAL_GRPC_PORT ?? "7233"}`,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "cloudagent-control-plane",
    disableHttpProxy: process.env.TEMPORAL_DISABLE_HTTP_PROXY !== "false",
  },
  runner: {
    image: process.env.SANDBOX_IMAGE ?? "ghcr.io/agent-infra/sandbox:1.11.0",
    memory: process.env.SANDBOX_MEMORY ?? "4g",
    cpus: process.env.SANDBOX_CPUS ?? "2",
    timezone: process.env.TZ ?? "Asia/Shanghai",
    containerWorkspacePath: "/home/gem/workspace",
    previewHostSuffix: process.env.RUNNER_PREVIEW_HOST_SUFFIX ?? "preview.localhost",
  },
  auth: {
    cookieName: process.env.AUTH_COOKIE_NAME ?? "cloudagent_session",
    sessionTtlSeconds: Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 7),
    secureCookies:
      process.env.AUTH_SECURE_COOKIES === "true" || process.env.NODE_ENV === "production",
  },
  credentials: {
    leaseTtlSeconds: Math.max(
      1,
      Number(process.env.CREDENTIAL_LEASE_TTL_SECONDS ?? 30 * 60),
    ),
  },
  organizationId: "00000000-0000-4000-8000-000000000001",
};
