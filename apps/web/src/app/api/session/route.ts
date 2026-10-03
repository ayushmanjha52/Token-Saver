import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { schema } from "@tokengrid/db";
import { db } from "@/lib/db";
import { DevLoginDisabledError, SESSION_COOKIE, SESSION_TTL_S, sessionSecret, signSession } from "@/lib/session-token";

export const runtime = "nodejs";

/**
 * Development login: anyone who knows an email in the database becomes that
 * person. Refuses to run in production rather than relying on deployment
 * config to keep it unreachable.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    const err = new DevLoginDisabledError();
    return NextResponse.json({ error: { code: err.name, message: err.message } }, { status: 404 });
  }
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const [user] = await db()
    .select({ id: schema.users.id, orgId: schema.users.orgId })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!user) return NextResponse.redirect(new URL("/login?error=unknown", req.url), 303);
  const res = NextResponse.redirect(new URL("/usage", req.url), 303);
  res.cookies.set(SESSION_COOKIE, signSession({ userId: user.id, orgId: user.orgId }, sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:" });
  return res;
}
