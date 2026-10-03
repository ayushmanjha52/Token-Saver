import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionSecret, verifySession, type Session } from "./session-token";

export type { Session };

/**
 * The session from the signed cookie. Login itself is a development stub
 * (see /api/session); this is the seam a real identity provider plugs into.
 */
export function getSession(): Session | null {
  return verifySession(cookies().get(SESSION_COOKIE)?.value, sessionSecret());
}
