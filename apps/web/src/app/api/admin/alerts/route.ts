import { NextResponse, type NextRequest } from "next/server";
import { acknowledgeAlert } from "@/lib/admin";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { UsageAccessError } from "@/lib/usage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string") return NextResponse.json({ error: { code: "bad_request", message: "Body must be {\"id\": \"<alert id>\"}." } }, { status: 400 });
  try {
    await acknowledgeAlert(db(), session, body.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UsageAccessError) return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    throw err;
  }
}
