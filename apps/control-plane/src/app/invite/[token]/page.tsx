import Link from "next/link";

import { acceptInvitationAction } from "./actions";
import { getMembershipInvitation } from "@/lib/services";

export const dynamic = "force-dynamic";

const unavailableMessages = {
  expired: "This invitation has expired. Ask an Admin to send another one.",
  accepted: "This invitation has already been used.",
  revoked: "An Admin revoked this invitation.",
} as const;

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const invitation = await getMembershipInvitation(token);

  if (!invitation || invitation.status !== "pending") {
    const message = invitation
      ? unavailableMessages[invitation.status as keyof typeof unavailableMessages]
      : "This invitation link is invalid.";
    return (
      <section className="auth-shell">
        <div className="panel auth-panel">
          <span className="eyebrow">BranchHarbor invitation</span>
          <h1>Unable to accept invitation</h1>
          <div className="auth-error" role="alert">{message}</div>
          <Link className="button secondary" href="/login">Return to sign in</Link>
        </div>
      </section>
    );
  }

  const accept = acceptInvitationAction.bind(null, token);
  return (
    <section className="auth-shell">
      <div className="panel auth-panel">
        <span className="eyebrow">Invited by {invitation.invitedByName}</span>
        <h1>Create your BranchHarbor account</h1>
        <p><strong>{invitation.name}</strong>, you will join the team as a <code>{invitation.role}</code>.</p>
        <dl className="definition compact-definition">
          <dt>Account email</dt><dd>{invitation.email}</dd>
          <dt>Invitation expires</dt><dd>{invitation.expiresAt.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })}</dd>
        </dl>
        {query.error && <div className="auth-error" role="alert">{query.error}</div>}
        <form className="form" action={accept}>
          <label>
            Set password
            <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
          </label>
          <label>
            Confirm password
            <input name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
          </label>
          <p className="muted auth-note">Use at least 12 characters. The invitation expires immediately after acceptance and cannot be reused.</p>
          <button className="button" type="submit">Accept invitation and continue</button>
        </form>
      </div>
    </section>
  );
}
