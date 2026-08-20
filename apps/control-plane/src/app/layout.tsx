import type { Metadata } from "next";
import Link from "next/link";

import { logoutAction } from "./auth-actions";
import { getCurrentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudAgent Control Plane",
  description: "Multi-user orchestration for bring-your-own coding agents",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const actor = await getCurrentUser();
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link className="brand" href="/">
            <span className="brand-mark">CA</span>
            <span>
              <strong>CloudAgent</strong>
              <small>Control Plane</small>
            </span>
          </Link>
          {actor && (
            <>
              <nav>
                <Link href="/">Projects</Link>
                <Link href="/reviews">Review and integration</Link>
                {actor.role === "admin" && <Link href="/members">Members</Link>}
                {actor.role === "admin" && <Link href="/audit">Audit</Link>}
                <Link href="/change-password">Account security</Link>
                <a href="http://localhost:3100" target="_blank" rel="noreferrer">Gitea</a>
              </nav>
              <div className="actor-chip">
                <span className="actor-dot" />
                <span>{actor.name}<small>{actor.role}</small></span>
                <form action={logoutAction}>
                  <button className="logout-button" type="submit">Sign out</button>
                </form>
              </div>
            </>
          )}
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
