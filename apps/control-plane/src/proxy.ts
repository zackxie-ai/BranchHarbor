import { NextResponse, type NextRequest } from "next/server";

const cookieName = process.env.AUTH_COOKIE_NAME ?? "cloudagent_session";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/login" ||
    pathname.startsWith("/invite/") ||
    pathname === "/api/health"
  ) {
    return NextResponse.next();
  }

  if (request.cookies.has(cookieName)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return Response.json(
      { error: "Authentication is required", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set(
    "next",
    `${pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login|invite|api/health).*)",
  ],
};
