import { adminPage } from "@/features/admin/server";
import { AdminShell } from "@/features/admin/ui-shared";
import { UsersPanel } from "@/features/admin/users-panel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const data = await adminPage();
  return (
    <AdminShell title="Manajemen Pengguna" tenant={data.tenant.name}>
      <UsersPanel initial={data} />
    </AdminShell>
  );
}
