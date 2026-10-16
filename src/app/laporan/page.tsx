import {pageSession} from '@/features/auth/server';import {ReportsPanel} from '@/features/reports/panel';export const dynamic='force-dynamic';
export default async function Page(){const x=await pageSession(true,'reports.view'),t=x.memberships.find(m=>m.tenant_id===x.session.active_tenant_id)!;return <ReportsPanel tenantId={t.tenant_id} tenantName={t.tenant_name}/>}
