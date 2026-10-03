import { redirect } from "next/navigation";
import { UsagePanel } from "@/components/UsagePanel";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function UsagePage() {
  if (!getSession()) redirect("/login");
  return <UsagePanel />;
}
