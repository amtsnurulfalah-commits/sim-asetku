import { adminPage } from "@/features/admin/server";
import { AdminShell } from "@/features/admin/ui-shared";
import { ProfilePanel } from "@/features/admin/profile-panel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const data = await adminPage();
  return (
    <AdminShell title="Profil Lembaga" tenant={data.tenant.name}>
      <ProfilePanel initial={data.tenant} />
    </AdminShell>
  );
}
