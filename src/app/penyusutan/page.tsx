import {pageSession} from '@/features/auth/server';
import {DepreciationPanel} from '@/features/depreciation/panel';
export const dynamic='force-dynamic';
export default async function Page(){const x=await pageSession(true,'assets.view'),t=x.memberships.find(m=>m.tenant_id===x.session.active_tenant_id)!;return <DepreciationPanel tenantId={t.tenant_id} tenantName={t.tenant_name}/>}
