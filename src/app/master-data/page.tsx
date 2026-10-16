import { pageSession } from "@/features/auth/server";
import { MasterPanel } from "@/features/assets/master-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(true, "settings.manage");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return <MasterPanel tenantId={t.tenant_id} tenantName={t.tenant_name} />;
}
