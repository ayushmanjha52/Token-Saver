import { NextResponse, type NextRequest } from "next/server";
import { AuthError, clientIp, sameOrigin, signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { setSessionCookie } from "@/lib/session-cookie";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const back = (code: string) => NextResponse.redirect(new URL(`/login?error=${code}`, req.url), 303);
  if (!sameOrigin(req)) return back("origin");
  const form = await req.formData();
  try {
    const session = await signIn(db(), form.get("email"), form.get("password"), clientIp(req));
    return setSessionCookie(NextResponse.redirect(new URL("/usage", req.url), 303), session, req);
  } catch (err) {
    if (err instanceof AuthError) return back(err.code);
    console.error(err);
    return back("internal");
  }
}
