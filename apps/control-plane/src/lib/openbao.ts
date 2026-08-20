import { config } from "./config";
import { AppError } from "./errors";

function secretApiPath(reference: string): string {
  if (!reference.startsWith("openbao://secret/")) {
    throw new AppError("Invalid OpenBao secret reference", 500, "INVALID_SECRET_REFERENCE");
  }
  return `/v1/secret/data/${reference.slice("openbao://secret/".length)}`;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${config.openbao.baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Token": config.openbao.token,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new AppError(
      `OpenBao request failed (${response.status}): ${await response.text()}`,
      502,
      "OPENBAO_REQUEST_FAILED",
    );
  }
  return response;
}

export async function writeSecret(
  reference: string,
  values: Record<string, string>,
): Promise<void> {
  await request(secretApiPath(reference), {
    method: "POST",
    body: JSON.stringify({ data: values }),
  });
}

export async function readSecret(reference: string): Promise<Record<string, string>> {
  const response = await request(secretApiPath(reference));
  const body = (await response.json()) as { data?: { data?: Record<string, string> } };
  if (!body.data?.data) {
    throw new AppError("OpenBao secret is empty", 500, "SECRET_NOT_FOUND");
  }
  return body.data.data;
}

export async function deleteSecret(reference: string): Promise<void> {
  await request(secretApiPath(reference), { method: "DELETE" });
}
