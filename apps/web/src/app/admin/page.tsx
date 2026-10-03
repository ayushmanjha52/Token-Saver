import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/AdminPanel";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  if (!getSession()) redirect("/login");
  return <AdminPanel />;
}
