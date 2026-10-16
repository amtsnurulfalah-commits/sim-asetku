import { pageSession } from '@/features/auth/server';
import { TransactionReport } from '@/features/transactions/report';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: {
    params: Promise<{
        id: string;
    }>;
}) { const { id } = await params; const x = await pageSession(true, 'assets.view'); const t = x.memberships.find(m => m.tenant_id === x.session.active_tenant_id)!; return <TransactionReport id={id} tenantId={t.tenant_id} tenantName={t.tenant_name}/>; }
