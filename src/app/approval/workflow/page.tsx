import { pageSession } from '@/features/auth/server';
import { WorkflowPanel } from '@/features/approval/config-panel';
export const dynamic = 'force-dynamic';
export default async function Page() { const x = await pageSession(true, 'approval.manage'); const t = x.memberships.find(m => m.tenant_id === x.session.active_tenant_id)!; return <WorkflowPanel tenantId={t.tenant_id} tenantName={t.tenant_name}/>; }
