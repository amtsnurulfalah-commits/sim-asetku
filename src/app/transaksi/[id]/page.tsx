import { pageSession } from "@/features/auth/server";
import { TransactionDetail } from "@/features/transactions/detail";
export const dynamic = "force-dynamic";
export default async function Page({ params, }: {
    params: Promise<{
        id: string;
    }>;
}) {
    const { id } = await params;
    const x = await pageSession(true, "assets.view");
    const t = x.memberships.find((m) => m.tenant_id === x.session.active_tenant_id)!;
    return (<TransactionDetail tenantId={t.tenant_id} tenantName={t.tenant_name} id={id} membershipId={x.session.active_membership_id!}/>);
}
