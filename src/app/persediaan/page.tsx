import { pageSession } from "@/features/auth/server";
import { StockPanel } from "@/features/supply/stock-panel";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(true, "inventory.view");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return <StockPanel tenantId={t.tenant_id} tenantName={t.tenant_name} />;
}
