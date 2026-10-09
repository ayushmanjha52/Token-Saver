import { NextResponse, type NextRequest } from "next/server";
import { AuthError, sameOrigin, setPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  if (!sameOrigin(req)) return NextResponse.json({ error: { code: "origin", message: "Cross-site request refused." } }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { current?: unknown; next?: unknown } | null;
  try {
    await setPassword(db(), session, body?.current, body?.next);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.code === "wrong_password" ? 403 : 400 });
    }
    console.error(err);
    return NextResponse.json({ error: { code: "internal", message: "The password could not be saved." } }, { status: 500 });
  }
}
