"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireCurrentUser } from "@/lib/auth";
import {
  addProjectMember,
  createProject,
  createAgentConnection,
  createTask,
  configureAgentCredential,
  revokeAgentCredential,
  authorizeTaskAgentStart,
  authorizeIntegrationAgentStart,
  cancelAgentSession,
  queueProjectMergePlanAgentRun,
  queueProjectValidationRun,
  failProjectValidationRunLaunch,
  replaceProjectIntegrationQueue,
  cancelProjectIntegrationQueue,
  reviewChangeRequest,
  recoverTaskDependency,
  removeProjectMember,
  resolveAgentPermission,
  startTaskPreview,
  stopTaskPreview,
  updateTaskDependencies,
} from "@/lib/services";
import {
  durableCancelTask,
  durableFinalizeIntegration,
  durableProvisionTaskWorkspace,
  durableRunTaskAgent,
  durableRunIntegrationAgent,
  durableRunProjectMergePlanAgent,
  durableRunProjectValidation,
  durableStartIntegration,
  durableStartTaskRunner,
  durableSubmitTaskChange,
} from "@/temporal/client";

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createProjectAction(formData: FormData) {
  const actor = await requireCurrentUser();
  const project = await createProject(
    { name: formData.get("name"), slug: formData.get("slug") },
    actor.id,
  );
  redirect(`/projects/${project.id}`);
}

export async function createAgentConnectionAction(formData: FormData) {
  const actor = await requireCurrentUser();
  await createAgentConnection(
    {
      displayName: formData.get("displayName"),
      provider: formData.get("provider"),
      protocol: formData.get("protocol"),
      model: formData.get("model") || undefined,
      apiBaseUrl: formData.get("apiBaseUrl") || undefined,
      maxToolRounds: formData.get("maxToolRounds") || undefined,
      launcherCommand: formData.get("launcherCommand"),
      launcherArguments: lines(formData.get("launcherArguments")),
      credentialEnvironmentVariable: formData.get("credentialEnvironmentVariable"),
      apiKey: formData.get("apiKey"),
    },
    actor.id,
  );
  redirect("/#agents");
}

export async function configureAgentCredentialAction(
  connectionId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  await configureAgentCredential(
    connectionId,
    { apiKey: formData.get("apiKey"), model: formData.get("model") || undefined },
    actor.id,
  );
  redirect("/#agents");
}

export async function revokeAgentCredentialAction(connectionId: string) {
  const actor = await requireCurrentUser();
  await revokeAgentCredential(connectionId, actor.id);
  redirect("/#agents");
}

export async function createTaskAction(projectId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  const agentConnection = String(formData.get("agentConnectionId") ?? "");
  const task = await createTask(
    projectId,
    {
      title: formData.get("title"),
      description: formData.get("description"),
      acceptanceCriteria: formData.get("acceptanceCriteria"),
      assignedUserId: formData.get("assignedUserId"),
      agentConnectionId: agentConnection || null,
      verificationCommands: lines(formData.get("verificationCommands")),
      expectedChangeScopes: lines(formData.get("expectedChangeScopes")),
      dependsOnTaskIds: formData.getAll("dependsOnTaskIds").map(String),
    },
    actor.id,
  );
  redirect(`/tasks/${task.id}`);
}

export async function addProjectMemberAction(projectId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await addProjectMember(projectId, { userId: formData.get("userId") }, actor.id);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}#members`);
}

export async function removeProjectMemberAction(projectId: string, userId: string) {
  const actor = await requireCurrentUser();
  await removeProjectMember(projectId, userId, actor.id);
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}#members`);
}

export async function provisionWorkspaceAction(taskId: string) {
  const actor = await requireCurrentUser();
  await durableProvisionTaskWorkspace({ taskId, actorId: actor.id });
  redirect(`/tasks/${taskId}`);
}

export async function startTaskRunnerAction(taskId: string) {
  const actor = await requireCurrentUser();
  await durableStartTaskRunner({ taskId, actorId: actor.id });
  redirect(`/tasks/${taskId}`);
}

export async function cancelTaskAction(taskId: string) {
  const actor = await requireCurrentUser();
  await durableCancelTask({ taskId, actorId: actor.id });
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}`);
}

export async function updateTaskDependenciesAction(taskId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await updateTaskDependencies(
    taskId,
    { dependsOnTaskIds: formData.getAll("dependsOnTaskIds").map(String) },
    actor.id,
  );
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}#dependencies`);
}

export async function recoverTaskDependencyAction(taskId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  const replacementTaskId = String(formData.get("replacementTaskId") ?? "");
  await recoverTaskDependency(
    taskId,
    {
      failedDependencyTaskId: formData.get("failedDependencyTaskId"),
      replacementTaskId: replacementTaskId || null,
      reason: formData.get("reason"),
    },
    actor.id,
  );
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}#dependency-history`);
}

export async function startTaskPreviewAction(taskId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await startTaskPreview(
    taskId,
    {
      command: formData.get("command"),
      port: formData.get("port"),
    },
    actor.id,
  );
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}#preview`);
}

export async function stopTaskPreviewAction(
  taskId: string,
  previewId: string,
) {
  const actor = await requireCurrentUser();
  await stopTaskPreview(previewId, actor.id);
  revalidatePath(`/tasks/${taskId}`);
  redirect(`/tasks/${taskId}#preview`);
}

export async function submitTaskAction(taskId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await durableSubmitTaskChange({
    taskId,
    actorId: actor.id,
    summary: String(formData.get("summary") ?? ""),
    risks: lines(formData.get("risks")),
  });
  redirect("/reviews");
}

export async function runTaskAgentAction(taskId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  const authorized = await authorizeTaskAgentStart(
    taskId,
    {
      prompt: formData.get("prompt"),
      resumeSessionId: formData.get("resumeSessionId") || undefined,
    },
    actor.id,
  );
  await durableRunTaskAgent({
    taskId,
    prompt: authorized.prompt,
    resumeSessionId: authorized.resumeSessionId,
    actorId: actor.id,
  });
  redirect(`/tasks/${taskId}`);
}

export async function cancelAgentSessionAction(sessionId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await cancelAgentSession(sessionId, actor.id);
  redirect(String(formData.get("returnTo") ?? "/"));
}

export async function runIntegrationAgentAction(
  integrationId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  const authorized = await authorizeIntegrationAgentStart(
    integrationId,
    {
      agentConnectionId: formData.get("agentConnectionId"),
      prompt: formData.get("prompt"),
      resumeSessionId: formData.get("resumeSessionId") || undefined,
    },
    actor.id,
  );
  await durableRunIntegrationAgent({
    integrationId,
    agentConnectionId: authorized.agentConnectionId,
    prompt: authorized.prompt,
    resumeSessionId: authorized.resumeSessionId,
    actorId: actor.id,
  });
  redirect("/reviews");
}

export async function runProjectMergePlanAgentAction(
  projectId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  const run = await queueProjectMergePlanAgentRun(
    projectId,
    {
      agentConnectionId: formData.get("agentConnectionId"),
      instruction: formData.get("instruction"),
    },
    actor.id,
  );
  await durableRunProjectMergePlanAgent({ runId: run.id, actorId: actor.id });
  redirect(`/projects/${projectId}#merge-plan`);
}

export async function replaceProjectIntegrationQueueAction(
  projectId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  await replaceProjectIntegrationQueue(
    projectId,
    {
      source: formData.get("source"),
      selectedTaskIds: formData.getAll("selectedTaskIds").map(String),
    },
    actor.id,
  );
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/reviews");
  redirect(`/projects/${projectId}#integration-queue`);
}

export async function cancelProjectIntegrationQueueAction(
  projectId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  await cancelProjectIntegrationQueue(
    projectId,
    { reason: formData.get("reason") },
    actor.id,
  );
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/reviews");
  redirect(`/projects/${projectId}#integration-queue`);
}

export async function runProjectValidationAction(
  projectId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  const run = await queueProjectValidationRun(
    projectId,
    {
      integrationQueueId: formData.get("integrationQueueId"),
      commands: lines(formData.get("commands")),
    },
    actor.id,
  );
  try {
    await durableRunProjectValidation({ runId: run.id, actorId: actor.id });
  } catch (error) {
    await failProjectValidationRunLaunch(run.id, error, actor.id);
    throw error;
  }
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}#joint-validation`);
}

export async function resolveAgentPermissionAction(
  permissionRequestId: string,
  formData: FormData,
) {
  const actor = await requireCurrentUser();
  const selectedOptionId = String(formData.get("selectedOptionId") ?? "");
  await resolveAgentPermission(
    permissionRequestId,
    { selectedOptionId: selectedOptionId || null },
    actor.id,
  );
  redirect(String(formData.get("returnTo") ?? "/"));
}

export async function reviewAction(changeRequestId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await reviewChangeRequest(
    changeRequestId,
    {
      decision: formData.get("decision"),
      comment: formData.get("comment"),
    },
    actor.id,
  );
  redirect("/reviews");
}

export async function integrateAction(changeRequestId: string) {
  const actor = await requireCurrentUser();
  await durableStartIntegration({ changeRequestId, actorId: actor.id });
  redirect("/reviews");
}

export async function finalizeIntegrationAction(integrationId: string, formData: FormData) {
  const actor = await requireCurrentUser();
  await durableFinalizeIntegration({
    integrationId,
    actorId: actor.id,
    comment: String(formData.get("comment") ?? ""),
  });
  redirect("/reviews");
}
