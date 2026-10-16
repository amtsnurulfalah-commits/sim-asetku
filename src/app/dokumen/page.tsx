import { pageSession } from "@/features/auth/server";
import { DrivePanel } from "@/features/drive/panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(true, "files.download");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  );
  return (
    <DrivePanel
      tenantId={x.session.active_tenant_id!}
      tenantName={t?.tenant_name ?? "Lembaga"}
      filesOnly={true}
    />
  );
}
