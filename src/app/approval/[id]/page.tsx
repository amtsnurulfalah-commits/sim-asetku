import { pageSession } from '@/features/auth/server';
import { ApprovalDetail } from '@/features/approval/detail-panel';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: {
    params: Promise<{
        id: string;
    }>;
}) { const { id } = await params; const x = await pageSession(true, 'approval.access'); const t = x.memberships.find(m => m.tenant_id === x.session.active_tenant_id)!; return <ApprovalDetail id={id} tenantId={t.tenant_id} tenantName={t.tenant_name}/>; }
