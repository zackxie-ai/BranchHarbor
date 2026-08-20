import { redirect } from "next/navigation";

import { InvitationForm } from "./invitation-form";
import { revokeInvitationAction } from "./actions";
import { requirePageUser } from "@/lib/auth";
import { listMembershipInvitations, listUsers } from "@/lib/repositories";

export const dynamic = "force-dynamic";

const invitationLabels = {
  pending: "Pending",
  expired: "Expired",
  accepted: "Accepted",
  revoked: "Revoked",
} as const;

function statusClass(status: keyof typeof invitationLabels): string {
  if (status === "accepted") return "status-success";
  if (status === "pending") return "status-warning";
  if (status === "expired" || status === "revoked") return "status-danger";
  return "status-neutral";
}

function displayDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export default async function MembersPage() {
  const actor = await requirePageUser();
  if (actor.role !== "admin") {
    redirect("/");
  }
  const [members, invitations] = await Promise.all([
    listUsers(actor.organizationId),
    listMembershipInvitations(actor.organizationId),
  ]);

  return (
    <>
      <section className="section-head">
        <div>
          <span className="eyebrow">Organization management</span>
          <h1>Members and invitations</h1>
          <p>Admins create one-time invitations. Invitees set their own password before entering BranchHarbor.</p>
        </div>
      </section>

      <div className="detail-grid">
        <section className="panel">
          <h2>Current members</h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Member</th><th>Email</th><th>Role</th></tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.name}</td>
                    <td><code>{member.email}</code></td>
                    <td><span className="status status-neutral">{member.role}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <InvitationForm />
      </div>

      <section className="section-head">
        <div>
          <h2>Invitation history</h2>
          <p>Accepted, revoked, and expired invitations remain available for audit.</p>
        </div>
      </section>
      {invitations.length === 0 ? (
        <div className="empty">No member invitations have been created.</div>
      ) : (
        <div className="panel table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>Invitee</th><th>Role</th><th>Status</th><th>Expires</th><th>Invited by</th><th /></tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => {
                const revoke = revokeInvitationAction.bind(null, invitation.id);
                return (
                  <tr key={invitation.id}>
                    <td><strong>{invitation.name}</strong><small>{invitation.email}</small></td>
                    <td>{invitation.role}</td>
                    <td><span className={`status ${statusClass(invitation.status)}`}>{invitationLabels[invitation.status]}</span></td>
                    <td>{displayDate(invitation.expiresAt)}</td>
                    <td>{invitation.invitedByName ?? "-"}</td>
                    <td>
                      {invitation.status === "pending" && (
                        <form action={revoke}>
                          <button className="button danger" type="submit">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
