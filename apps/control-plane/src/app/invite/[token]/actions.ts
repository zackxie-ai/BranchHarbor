"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { createBrowserSession, destroyBrowserSession } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { acceptMembershipInvitation } from "@/lib/services";

function invitationError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Check the password fields";
  console.error(error);
  return "Invitation acceptance failed. Try again shortly.";
}

export async function acceptInvitationAction(token: string, formData: FormData) {
  let errorMessage: string | null = null;
  let userId: string | null = null;
  try {
    const user = await acceptMembershipInvitation({
      token,
      password: formData.get("password"),
      passwordConfirmation: formData.get("passwordConfirmation"),
    });
    userId = user.id;
  } catch (error) {
    errorMessage = invitationError(error);
  }

  if (errorMessage || !userId) {
    redirect(`/invite/${encodeURIComponent(token)}?error=${encodeURIComponent(errorMessage ?? "Invitation acceptance failed")}`);
  }
  await destroyBrowserSession();
  await createBrowserSession(userId);
  redirect("/");
}
