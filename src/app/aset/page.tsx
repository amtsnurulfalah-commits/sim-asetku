import { pageSession } from "@/features/auth/server";
import { AssetList } from "@/features/assets/list-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(true, "assets.view");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return <AssetList tenantId={t.tenant_id} tenantName={t.tenant_name} />;
}
