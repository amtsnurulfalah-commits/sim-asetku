import { pageSession } from '@/features/auth/server';
import { TransactionPanel } from '@/features/transactions/panel';
export const dynamic = 'force-dynamic';
export default async function Page() { const x = await pageSession(true, 'assets.view'); const t = x.memberships.find(m => m.tenant_id === x.session.active_tenant_id)!; return <TransactionPanel tenantId={t.tenant_id} tenantName={t.tenant_name}/>; }
