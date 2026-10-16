import {pageSession} from '@/features/auth/server';
import {DepreciationDetail} from '@/features/depreciation/detail-panel';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){const x=await pageSession(true,'assets.view'),t=x.memberships.find(m=>m.tenant_id===x.session.active_tenant_id)!,{id}=await params;return <DepreciationDetail tenantId={t.tenant_id} tenantName={t.tenant_name} membershipId={x.session.active_membership_id!} id={id}/>}
