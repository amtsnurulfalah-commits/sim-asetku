import { pageSession } from "@/features/auth/server";
import { AssetDetailPanel } from "@/features/assets/detail-panel";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const p = await params;
  const x = await pageSession(true, "assets.view");
  const t = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  return (
    <AssetDetailPanel
      tenantId={t.tenant_id}
      tenantName={t.tenant_name}
      assetKey={p.publicId}
      publicId={true}
    />
  );
}
