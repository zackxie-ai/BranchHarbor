import { randomUUID } from "node:crypto";

import {
  hashInvitationToken,
  hashSessionToken,
  verifyPassword,
} from "../apps/control-plane/src/lib/auth-crypto";
import { config } from "../apps/control-plane/src/lib/config";
import { query } from "../apps/control-plane/src/lib/db";
import { AppError } from "../apps/control-plane/src/lib/errors";
import {
  insertAuthSession,
  insertMembershipInvitation,
  findUserCredentialByEmail,
} from "../apps/control-plane/src/lib/repositories";
import {
  acceptMembershipInvitation,
  changeOwnPassword,
  createMembershipInvitation,
  getMembershipInvitation,
  revokeMembershipInvitation,
} from "../apps/control-plane/src/lib/services";

const adminId = "00000000-0000-4000-8000-000000000101";
const memberId = "00000000-0000-4000-8000-000000000102";
const suffix = randomUUID().slice(0, 8);
const acceptedEmail = `invite-smoke-${suffix}@cloudagent.local`;
const revokedEmail = `invite-revoked-${suffix}@cloudagent.local`;
const expiredEmail = `invite-expired-${suffix}@cloudagent.local`;
const initialPassword = "cloudagent-smoke-initial-password";
const updatedPassword = "cloudagent-smoke-updated-password";
const invitationIds: string[] = [];
let acceptedUserId: string | null = null;

async function verifyStoredPassword(email: string, password: string): Promise<void> {
  const credential = await findUserCredentialByEmail(email);
  if (!credential || !(await verifyPassword(password, credential.passwordHash))) {
    throw new Error(`Stored password verification failed for ${email}`);
  }
}

async function expectAppError(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AppError && error.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function main() {
  try {
    await expectAppError(
      () =>
        createMembershipInvitation(
          {
            email: acceptedEmail,
            name: "Invitation Smoke Member",
            role: "member",
            expiresInHours: 24,
          },
          memberId,
        ),
      "ADMIN_REQUIRED",
    );

    const created = await createMembershipInvitation(
      {
        email: acceptedEmail,
        name: "Invitation Smoke Member",
        role: "member",
        expiresInHours: 24,
      },
      adminId,
    );
    invitationIds.push(created.invitation.id);
    const token = created.invitePath.split("/").at(-1);
    if (!token) {
      throw new Error("Invitation token was not returned");
    }
    const [storedToken] = await query<{ token_hash: string }>(
      "SELECT token_hash FROM membership_invitations WHERE id = $1",
      [created.invitation.id],
    );
    if (!storedToken || storedToken.token_hash !== hashInvitationToken(token)) {
      throw new Error("Invitation token digest was not persisted correctly");
    }
    if (storedToken.token_hash === token) {
      throw new Error("Plain invitation token leaked into PostgreSQL");
    }

    const publicInvitation = await getMembershipInvitation(token);
    if (!publicInvitation || publicInvitation.status !== "pending") {
      throw new Error("Pending invitation could not be resolved");
    }

    const acceptedUser = await acceptMembershipInvitation({
      token,
      password: initialPassword,
      passwordConfirmation: initialPassword,
    });
    acceptedUserId = acceptedUser.id;
    if (acceptedUser.email !== acceptedEmail || acceptedUser.role !== "member") {
      throw new Error("Accepted user does not match the invitation");
    }
    await verifyStoredPassword(acceptedEmail, initialPassword);
    await expectAppError(
      () =>
        acceptMembershipInvitation({
          token,
          password: initialPassword,
          passwordConfirmation: initialPassword,
        }),
      "INVITATION_ALREADY_ACCEPTED",
    );
    await expectAppError(
      () =>
        createMembershipInvitation(
          {
            email: acceptedEmail,
            name: "Duplicate Member",
            role: "member",
            expiresInHours: 24,
          },
          adminId,
        ),
      "MEMBER_ALREADY_EXISTS",
    );

    const sessionToken = `membership-smoke-${randomUUID()}`;
    await insertAuthSession({
      userId: acceptedUser.id,
      tokenHash: hashSessionToken(sessionToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await changeOwnPassword(
      {
        currentPassword: initialPassword,
        newPassword: updatedPassword,
        passwordConfirmation: updatedPassword,
      },
      acceptedUser.id,
    );
    const [revokedSession] = await query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE token_hash = $1",
      [hashSessionToken(sessionToken)],
    );
    if (!revokedSession?.revoked_at) {
      throw new Error("Password change did not revoke existing sessions");
    }
    await verifyStoredPassword(acceptedEmail, updatedPassword);

    const revoked = await createMembershipInvitation(
      {
        email: revokedEmail,
        name: "Revoked Invitation",
        role: "member",
        expiresInHours: 24,
      },
      adminId,
    );
    invitationIds.push(revoked.invitation.id);
    const revokedToken = revoked.invitePath.split("/").at(-1)!;
    await revokeMembershipInvitation(revoked.invitation.id, adminId);
    await expectAppError(
      () =>
        acceptMembershipInvitation({
          token: revokedToken,
          password: initialPassword,
          passwordConfirmation: initialPassword,
        }),
      "INVITATION_REVOKED",
    );

    const expiredToken = `expired-${randomUUID()}-${randomUUID()}`;
    const expired = await insertMembershipInvitation({
      organizationId: config.organizationId,
      email: expiredEmail,
      name: "Expired Invitation",
      role: "member",
      tokenHash: hashInvitationToken(expiredToken),
      expiresAt: new Date(Date.now() - 60_000),
      invitedBy: adminId,
    });
    invitationIds.push(expired.id);
    const expiredPublicInvitation = await getMembershipInvitation(expiredToken);
    if (!expiredPublicInvitation || expiredPublicInvitation.status !== "expired") {
      throw new Error("Expired invitation status was not calculated correctly");
    }
    await expectAppError(
      () =>
        acceptMembershipInvitation({
          token: expiredToken,
          password: initialPassword,
          passwordConfirmation: initialPassword,
        }),
      "INVITATION_EXPIRED",
    );

    console.log(
      JSON.stringify({
        invitationId: created.invitation.id,
        acceptedUserId: acceptedUser.id,
        memberPermissionRejected: true,
        plainTokenStored: false,
        repeatAcceptanceRejected: true,
        revokedInvitationRejected: true,
        expiredInvitationRejected: true,
        passwordChangeRevokedSessions: true,
      }),
    );
  } finally {
    for (const invitationId of invitationIds) {
      await query(
        "DELETE FROM audit_events WHERE payload->>'invitationId' = $1",
        [invitationId],
      ).catch(() => undefined);
    }
    if (acceptedUserId) {
      await query("DELETE FROM audit_events WHERE actor_id = $1", [acceptedUserId]).catch(
        () => undefined,
      );
    }
    if (invitationIds.length > 0) {
      await query("DELETE FROM membership_invitations WHERE id = ANY($1::UUID[])", [
        invitationIds,
      ]).catch(() => undefined);
    }
    if (acceptedUserId) {
      await query("DELETE FROM users WHERE id = $1", [acceptedUserId]).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
