"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { requireCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  createMembershipInvitation,
  revokeMembershipInvitation,
} from "@/lib/services";

export interface CreateInvitationState {
  error: string | null;
  invitePath: string | null;
}

function actionError(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? "Invitation details are incomplete";
  }
  console.error(error);
  return "Invitation creation failed. Try again shortly.";
}

export async function createInvitationAction(
  _previousState: CreateInvitationState,
  formData: FormData,
): Promise<CreateInvitationState> {
  try {
    const actor = await requireCurrentUser();
    const result = await createMembershipInvitation(
      {
        email: formData.get("email"),
        name: formData.get("name"),
        role: formData.get("role"),
        expiresInHours: formData.get("expiresInHours"),
      },
      actor.id,
    );
    revalidatePath("/members");
    return { error: null, invitePath: result.invitePath };
  } catch (error) {
    return { error: actionError(error), invitePath: null };
  }
}

export async function revokeInvitationAction(invitationId: string) {
  const actor = await requireCurrentUser();
  await revokeMembershipInvitation(invitationId, actor.id);
  revalidatePath("/members");
}
