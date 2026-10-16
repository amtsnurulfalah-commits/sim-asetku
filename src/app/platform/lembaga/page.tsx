import { adminPage } from "@/features/admin/server";
import { AdminShell } from "@/features/admin/ui-shared";
import { PlatformPanel } from "@/features/admin/platform-panel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const data = await adminPage(true);
  return (
    <AdminShell title="Pengelolaan Lembaga" platform>
      <PlatformPanel initial={data} />
    </AdminShell>
  );
}
