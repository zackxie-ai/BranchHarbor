import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "../../proxy";
import {
  assertCredentialOwner,
  assertOrganizationAdmin,
  assertOrganizationMember,
  assertTaskOperator,
} from "../authorization";
import {
  createInvitationToken,
  hashInvitationToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "../auth-crypto";
import {
  acceptMembershipInvitationSchema,
  changePasswordSchema,
  createMembershipInvitationSchema,
} from "../validation";

describe("BranchHarbor authentication primitives", () => {
  it("hashes passwords with a unique salt and verifies only the correct password", async () => {
    const firstHash = await hashPassword("correct horse battery staple");
    const secondHash = await hashPassword("correct horse battery staple");

    expect(firstHash).not.toBe(secondHash);
    await expect(verifyPassword("correct horse battery staple", firstHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", firstHash)).resolves.toBe(false);
  });

  it("stores only a deterministic SHA-256 digest for session lookup", () => {
    const digest = hashSessionToken("opaque-browser-token");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain("opaque-browser-token");
  });

  it("creates opaque invitation tokens and stores only their digest", () => {
    const token = createInvitationToken();
    const digest = hashInvitationToken(token);

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
  });

  it("redirects unauthenticated pages and rejects unauthenticated APIs", async () => {
    const pageResponse = proxy(new NextRequest("http://localhost/projects/project-1"));
    expect(pageResponse.status).toBe(307);
    expect(pageResponse.headers.get("location")).toContain("/login?next=%2Fprojects%2Fproject-1");

    const apiResponse = proxy(new NextRequest("http://localhost/api/projects"));
    expect(apiResponse.status).toBe(401);
    await expect(apiResponse.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("does not trust the removed x-branchharbor-user-id impersonation header", async () => {
    const request = new NextRequest("http://localhost/api/projects", {
      headers: { "x-branchharbor-user-id": "00000000-0000-4000-8000-000000000101" },
    });
    expect(proxy(request).status).toBe(401);
  });

  it("allows invitation pages without an existing browser session", () => {
    const response = proxy(new NextRequest("http://localhost/invite/opaque-token"));
    expect(response.status).toBe(200);
  });
});

describe("BranchHarbor account input policy", () => {
  it("normalizes invited emails and limits invitation lifetime", () => {
    const invitation = createMembershipInvitationSchema.parse({
      email: "  NEW.MEMBER@Example.com ",
      name: "New Member",
      role: "member",
      expiresInHours: "72",
    });
    expect(invitation.email).toBe("new.member@example.com");
    expect(invitation.expiresInHours).toBe(72);
    expect(() =>
      createMembershipInvitationSchema.parse({
        email: "member@example.com",
        name: "Member",
        role: "member",
        expiresInHours: 169,
      }),
    ).toThrow();
  });

  it("requires strong matching passwords for invitation acceptance", () => {
    expect(() =>
      acceptMembershipInvitationSchema.parse({
        token: "a".repeat(43),
        password: "short",
        passwordConfirmation: "short",
      }),
    ).toThrow();
    expect(() =>
      acceptMembershipInvitationSchema.parse({
        token: "a".repeat(43),
        password: "a-long-password",
        passwordConfirmation: "a-different-password",
      }),
    ).toThrow("The password confirmation does not match");
  });

  it("requires a distinct matching password when changing credentials", () => {
    expect(() =>
      changePasswordSchema.parse({
        currentPassword: "same-password",
        newPassword: "same-password",
        passwordConfirmation: "same-password",
      }),
    ).toThrow("The new password must differ from the current password");
  });
});

describe("BranchHarbor authorization policy", () => {
  it("rejects users without an organization membership", () => {
    expect(() => assertOrganizationMember(null)).toThrow("access");
  });

  it("prevents an Admin from replacing another user's Agent key", () => {
    expect(() => assertCredentialOwner("admin-user", "member-user")).toThrow(
      "another user's Agent",
    );
  });

  it("allows only the assignee or an Admin to operate a task", () => {
    expect(() =>
      assertTaskOperator({ actorId: "assignee", assignedUserId: "assignee", role: "member" }),
    ).not.toThrow();
    expect(() =>
      assertTaskOperator({ actorId: "admin", assignedUserId: "assignee", role: "admin" }),
    ).not.toThrow();
    expect(() =>
      assertTaskOperator({ actorId: "other-member", assignedUserId: "assignee", role: "member" }),
    ).toThrow("assigned member or an Admin");
  });

  it("prevents a regular member from reviewing or merging into main", () => {
    expect(() => assertOrganizationAdmin("member")).toThrow("Admin permission");
    expect(() => assertOrganizationAdmin("admin")).not.toThrow();
  });
});
