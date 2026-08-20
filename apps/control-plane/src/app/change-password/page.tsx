import { redirect } from "next/navigation";

import { changePasswordAction } from "../auth-actions";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [actor, query] = await Promise.all([getCurrentUser(), searchParams]);
  if (!actor) {
    redirect("/login?next=/change-password");
  }

  return (
    <section className="auth-shell">
      <div className="panel auth-panel">
        <span className="eyebrow">Account security</span>
        <h1>{actor.mustChangePassword ? "Change your initial password" : "Change password"}</h1>
        <p>A successful password change revokes BranchHarbor sessions on every other browser and device.</p>
        {query.error && <div className="auth-error" role="alert">{query.error}</div>}
        <form className="form" action={changePasswordAction}>
          <label>
            Current password
            <input name="currentPassword" type="password" autoComplete="current-password" required />
          </label>
          <label>
            New password
            <input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
          </label>
          <label>
            Confirm new password
            <input name="passwordConfirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={200} />
          </label>
          <button className="button" type="submit">Save new password</button>
        </form>
      </div>
    </section>
  );
}
