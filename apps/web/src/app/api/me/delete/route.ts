import { deleteUserData } from "@tokengrid/db";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

/** Typed, not clicked: deleting usage history cannot be undone. */
const CONFIRMATION = "delete my usage data";

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== CONFIRMATION) {
    return NextResponse.json({ error: { code: "confirmation_required", message: `Send {"confirm": "${CONFIRMATION}"}.` } }, { status: 400 });
  }
  const deleted = await deleteUserData(db(), session.userId, session.userId);
  return NextResponse.json({ deleted });
}
