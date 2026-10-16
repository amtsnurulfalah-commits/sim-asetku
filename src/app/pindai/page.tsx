import { pageSession } from "@/features/auth/server";
import { Scanner } from "@/features/assets/scanner";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(true, "assets.view");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return <Scanner tenantId={t.tenant_id} tenantName={t.tenant_name} />;
}
