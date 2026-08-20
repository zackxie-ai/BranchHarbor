"use client";

import { useActionState, useState } from "react";

import {
  createInvitationAction,
} from "./actions";
import type { CreateInvitationState } from "./actions";

const initialCreateInvitationState: CreateInvitationState = {
  error: null,
  invitePath: null,
};

export function InvitationForm() {
  const [state, formAction, pending] = useActionState(
    createInvitationAction,
    initialCreateInvitationState,
  );
  const [copied, setCopied] = useState(false);

  async function copyInvitation() {
    if (!state.invitePath) {
      return;
    }
    const invitationUrl = new URL(state.invitePath, window.location.origin).toString();
    await navigator.clipboard.writeText(invitationUrl);
    setCopied(true);
  }

  return (
    <div className="panel">
      <h3>Invite a member</h3>
      <p className="muted">The invitation URL is shown only once. The database stores only its token hash.</p>
      {state.error && <div className="auth-error" role="alert">{state.error}</div>}
      {state.invitePath && (
        <div className="invite-result" role="status">
          <strong>One-time invitation URL created</strong>
          <code>{state.invitePath}</code>
          <div className="button-row">
            <button className="button secondary" type="button" onClick={copyInvitation}>
              {copied ? "Copied" : "Copy full URL"}
            </button>
            <a className="button secondary" href={state.invitePath} target="_blank" rel="noreferrer">
              Open invitation page
            </a>
          </div>
        </div>
      )}
      <form className="form" action={formAction}>
        <div className="form-row">
          <label>
            Name
            <input name="name" required minLength={2} maxLength={100} />
          </label>
          <label>
            Email
            <input name="email" type="email" required maxLength={320} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Organization role
            <select name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>
            Valid for
            <select name="expiresInHours" defaultValue="72">
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
            </select>
          </label>
        </div>
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create invitation"}
        </button>
      </form>
    </div>
  );
}
