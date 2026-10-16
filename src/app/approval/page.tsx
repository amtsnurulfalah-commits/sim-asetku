import { pageSession } from '@/features/auth/server';
import { ApprovalInbox } from '@/features/approval/inbox';
export const dynamic = 'force-dynamic';
export default async function Page() { const x = await pageSession(true, 'approval.access'); const t = x.memberships.find(m => m.tenant_id === x.session.active_tenant_id)!; return <ApprovalInbox tenantId={t.tenant_id} tenantName={t.tenant_name}/>; }
