import { redirect } from "next/navigation";

import { loginAction } from "../auth-actions";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams]);
  if (user) {
    redirect("/");
  }

  return (
    <section className="auth-shell">
      <div className="panel auth-panel">
        <span className="eyebrow">BranchHarbor Control Plane</span>
        <h1>Sign in to your workspace</h1>
        <p>Use your BranchHarbor account to access cloud projects. Agent credentials and task permissions remain isolated by user.</p>

        {params.error && <div className="auth-error" role="alert">{params.error}</div>}

        <form className="form" action={loginAction}>
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required autoFocus />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button className="button" type="submit">Sign in</button>
        </form>

        <div className="divider" />
        <p className="muted auth-note">
          Local fixture accounts: <code>admin@branchharbor.local</code> and <code>member@branchharbor.local</code>.
          Their initial passwords are <code>branchharbor-admin-change-me</code> and <code>branchharbor-member-change-me</code>.
        </p>
      </div>
    </section>
  );
}
