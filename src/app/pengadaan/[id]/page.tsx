import { pageSession } from "@/features/auth/server";
import { SupplyDetail } from "@/features/supply/detail-panel";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const x = await pageSession(true, "inventory.view");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return (
    <SupplyDetail
      tenantId={t.tenant_id}
      tenantName={t.tenant_name}
      id={id}
      membershipId={x.session.active_membership_id!}
    />
  );
}
