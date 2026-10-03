import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { setConsent, UsageAccessError } from "@/lib/usage";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const grant = typeof body === "object" && body !== null ? (body as { grant?: unknown }).grant : undefined;
  if (typeof grant !== "boolean") {
    return NextResponse.json({ error: { code: "bad_request", message: "Body must be {\"grant\": true|false}." } }, { status: 400 });
  }
  try {
    return NextResponse.json({ consented: await setConsent(db(), session, grant) });
  } catch (err) {
    if (err instanceof UsageAccessError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: { code: "internal", message: "Consent could not be saved." } }, { status: 500 });
  }
}
