import { NextResponse } from "next/server";
import { getReconciliation } from "@/lib/admin";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { UsageAccessError } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  try {
    return NextResponse.json(await getReconciliation(db(), session), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof UsageAccessError) return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: { code: "internal", message: "Reconciliation could not be loaded." } }, { status: 500 });
  }
}
