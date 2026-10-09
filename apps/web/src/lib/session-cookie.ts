import type { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession, type Session } from "./session-token";

/** One place that decides how the session cookie is set, for every way of signing in. */
export function setSessionCookie(res: NextResponse, session: Session, req: NextRequest): NextResponse {
  res.cookies.set(SESSION_COOKIE, signSession(session, sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return res;
}
