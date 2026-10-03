import { schema, exportUserData } from "@tokengrid/db";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams everything held about the signed-in person as NDJSON, one record per line. */
export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in first." } }, { status: 401 });
  const database = db();
  await database.insert(schema.auditLog).values({ orgId: session.orgId, actorUserId: session.userId, subjectUserId: session.userId, action: "data.exported", detail: {} });
  const records = exportUserData(database, session.userId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await records.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="tokengrid-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      "cache-control": "no-store",
    },
  });
}
