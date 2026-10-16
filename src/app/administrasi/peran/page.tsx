import { adminPage } from "@/features/admin/server";
import { AdminShell } from "@/features/admin/ui-shared";
import { RolesPanel } from "@/features/admin/roles-panel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const data = await adminPage();
  return (
    <AdminShell title="Role dan Izin" tenant={data.tenant.name}>
      <RolesPanel initial={data} />
    </AdminShell>
  );
}
