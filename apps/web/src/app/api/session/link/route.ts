import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { schema } from "@tokengrid/db";
import { verifyLoginLink } from "@tokengrid/shared";
import { db } from "@/lib/db";
import { setSessionCookie } from "@/lib/session-cookie";
import { sessionSecret } from "@/lib/session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redeems a one-time sign-in link from the admin CLI. The signature proves
 * TokenGrid issued it; claiming the row (used_at is null, not expired) in a
 * single UPDATE is what makes a forwarded or replayed link useless.
 */
export async function GET(req: NextRequest) {
  const fail = NextResponse.redirect(new URL("/login?error=link", req.url), 303);
  const claims = verifyLoginLink(req.nextUrl.searchParams.get("token") ?? "", sessionSecret());
  if (!claims) return fail;
  const t = schema.loginLinks;
  const [claimed] = await db()
    .update(t)
    .set({ usedAt: new Date() })
    .where(and(eq(t.nonce, claims.nonce), eq(t.userId, claims.userId), isNull(t.usedAt), gt(t.expiresAt, new Date())))
    .returning({ userId: t.userId });
  if (!claimed) return fail;
  return setSessionCookie(NextResponse.redirect(new URL("/usage", req.url), 303), { userId: claims.userId, orgId: claims.orgId }, req);
}
