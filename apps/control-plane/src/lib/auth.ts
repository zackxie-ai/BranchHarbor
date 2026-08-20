import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createSessionToken, hashSessionToken, verifyPassword } from "./auth-crypto";
import { config } from "./config";
import { AppError } from "./errors";
import {
  findAuthenticatedUserBySessionHash,
  findUserCredentialByEmail,
  insertAuthSession,
  recordAudit,
  recordLoginFailure,
  resetLoginFailures,
  revokeAuthSession,
} from "./repositories";
import type { AuthenticatedUser } from "./types";

const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect";

export async function authenticateWithPassword(
  email: string,
  password: string,
): Promise<AuthenticatedUser> {
  const credential = await findUserCredentialByEmail(email.trim().toLowerCase());
  if (!credential) {
    throw new AppError(INVALID_CREDENTIALS_MESSAGE, 401, "INVALID_CREDENTIALS");
  }

  if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
    throw new AppError(
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
      "ACCOUNT_TEMPORARILY_LOCKED",
    );
  }

  const passwordMatches = await verifyPassword(password, credential.passwordHash);
  if (!passwordMatches) {
    await recordLoginFailure(credential.user.id);
    throw new AppError(INVALID_CREDENTIALS_MESSAGE, 401, "INVALID_CREDENTIALS");
  }

  await resetLoginFailures(credential.user.id);
  await recordAudit({
    actorId: credential.user.id,
    eventType: "auth.login_succeeded",
  });
  return credential.user;
}

export async function createBrowserSession(userId: string): Promise<void> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlSeconds * 1000);
  await insertAuthSession({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });

  const cookieStore = await cookies();
  cookieStore.set(config.auth.cookieName, token, {
    httpOnly: true,
    secure: config.auth.secureCookies,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(config.auth.cookieName)?.value;
  if (!token) {
    return null;
  }
  return findAuthenticatedUserBySessionHash(hashSessionToken(token));
}

export async function requireCurrentUser(options: {
  allowPasswordChangeRequired?: boolean;
} = {}): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AppError("Authentication is required", 401, "UNAUTHENTICATED");
  }
  if (user.mustChangePassword && !options.allowPasswordChangeRequired) {
    throw new AppError("Password change is required", 403, "PASSWORD_CHANGE_REQUIRED");
  }
  return user;
}

export async function requirePageUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  if (user.mustChangePassword) {
    redirect("/change-password");
  }
  return user;
}

export async function destroyBrowserSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(config.auth.cookieName)?.value;
  if (token) {
    await revokeAuthSession(hashSessionToken(token));
  }
  cookieStore.delete(config.auth.cookieName);
}
