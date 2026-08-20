"use server";

import { redirect } from "next/navigation";

import {
  authenticateWithPassword,
  createBrowserSession,
  destroyBrowserSession,
  requireCurrentUser,
} from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { changeOwnPassword } from "@/lib/services";
import { ZodError } from "zod";

function safeDestination(value: FormDataEntryValue | null): string {
  const destination = String(value ?? "/");
  return destination.startsWith("/") && !destination.startsWith("//") ? destination : "/";
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const destination = safeDestination(formData.get("next"));

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent("Enter an email address and password")}`);
  }

  let authenticatedDestination = destination;
  try {
    const user = await authenticateWithPassword(email, password);
    await createBrowserSession(user.id);
    if (user.mustChangePassword) {
      authenticatedDestination = "/change-password";
    }
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Sign-in failed. Try again shortly.";
    redirect(`/login?error=${encodeURIComponent(message)}&next=${encodeURIComponent(destination)}`);
  }

  redirect(authenticatedDestination);
}

export async function logoutAction() {
  await destroyBrowserSession();
  redirect("/login");
}

export async function changePasswordAction(formData: FormData) {
  const actor = await requireCurrentUser({ allowPasswordChangeRequired: true });
  let errorMessage: string | null = null;
  try {
    await changeOwnPassword(
      {
        currentPassword: formData.get("currentPassword"),
        newPassword: formData.get("newPassword"),
        passwordConfirmation: formData.get("passwordConfirmation"),
      },
      actor.id,
    );
  } catch (error) {
    if (error instanceof AppError) {
      errorMessage = error.message;
    } else if (error instanceof ZodError) {
      errorMessage = error.issues[0]?.message ?? "Check the password fields";
    } else {
      console.error(error);
      errorMessage = "Password update failed. Try again shortly.";
    }
  }

  if (errorMessage) {
    redirect(`/change-password?error=${encodeURIComponent(errorMessage)}`);
  }
  await createBrowserSession(actor.id);
  redirect("/");
}
