import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { sessionSecret } from "@/lib/session-token";
import { getUsage, parseUsageQuery, UsageAccessError } from "@/lib/usage";
import type { UsageError } from "@/lib/usage-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, code: string, message: string) {
  return NextResponse.json<UsageError>({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return fail(401, "unauthenticated", "Sign in to view usage.");
  try {
    const data = await getUsage(db(), session, parseUsageQuery(req.nextUrl.searchParams), sessionSecret());
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof UsageAccessError) return fail(err.status, err.code, err.message);
    console.error(err);
    return fail(500, "internal", "Usage could not be loaded.");
  }
}
