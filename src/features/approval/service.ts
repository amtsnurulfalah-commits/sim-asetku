import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService, tokenDigest } from '@/lib/session/service';
import type { Snapshot } from '@/lib/session/repository';
import type { Sql } from '@/lib/db/types';
import { AppError } from '@/lib/security/errors';
import { mapAssetError } from '@/features/assets/service';
import * as S from './schemas';
export function mapApprovalError(e: unknown) { if (e instanceof AppError)
    return e; const { code, message = '' } = (e ?? {}) as {
    code?: string;
    message?: string;
}; if (code === '23514')
    return new AppError('APPROVAL_RULE_DENIED', 409, message.includes('Overlapping') ? 'Rentang nominal atau periode delegasi bertumpang tindih.' : message.includes('matching workflow') ? 'Tidak ada tepat satu workflow yang cocok. Periksa nominal, lingkup koreksi, dan versi aktif.' : message.includes('approver') || message.includes('Approver') ? 'Setiap level memerlukan approver aktif dengan izin yang sesuai dan memenuhi aturan independensi.' : message.includes('increased') ? 'Nominal meningkat setelah persetujuan. Kembalikan dokumen untuk revisi dan persetujuan baru.' : message.includes('Idempotency') ? 'Kunci operasi sudah dipakai untuk isi berbeda. Muat ulang formulir.' : message.includes('disabled') ? 'Keputusan ini dinonaktifkan oleh kebijakan snapshot.' : 'Approval belum memenuhi aturan. Periksa urutan level, versi dokumen, bukti, dan kebijakan workflow.'); if (code === '42501')
    return new AppError('PERMISSION_DENIED', 403, 'Anda belum berwenang pada level ini atau aturan independensi belum terpenuhi.'); return mapAssetError(e); }
const page = z.coerce.number().int().min(1).max(10000).default(1);
export class ApprovalService {
    constructor(public auth: AuthService) { }
    private parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> { const r = schema.safeParse(input); if (!r.success)
        throw new AppError('VALIDATION_ERROR', 400, 'Periksa isian workflow, nominal, approver, tanggal, dan alasan.'); return r.data; }
    private scope(t: string | undefined, p = 'approval.access') { return this.auth.session(t, { permission: p, sensitive: true }); }
    private run<T>(x: Snapshot, t: string | undefined, p: string, fn: (q: Sql) => Promise<T>) { return this.auth.repo.db.run('runtime', { tenantId: x.session.active_tenant_id!, userId: x.user.id, membershipId: x.session.active_membership_id!, sessionDigest: tokenDigest(t!), correlationId: randomUUID() }, async (q) => { await q.query('SELECT inventory_security.assert_approval_actor($1)', [p]); return fn(q); }); }
    async options(t: string | undefined): Promise<S.Options> { const x = await this.scope(t), permissions = await this.auth.repo.permissions(x); return this.run(x, t, 'approval.access', async (q) => { const isAdmin = (await q.query<{
        v: boolean;
    }>("SELECT EXISTS(SELECT FROM inventory.tenant_memberships m JOIN inventory.roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id WHERE m.id=$1 AND r.code='admin') v", [x.session.active_membership_id])).rows[0].v; const canManage = isAdmin && permissions.includes('approval.manage'); return { permissions, canManage, members: canManage ? (await q.query<S.Member>('SELECT * FROM inventory_security.approval_directory()')).rows : [] }; }); }
    async workflows(t: string | undefined, input: unknown) { const p = this.parse(z.object({ page, query: z.string().max(180).default('') }), input), x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => { const rows = (await q.query<S.Workflow>(`WITH directory AS MATERIALIZED(SELECT * FROM inventory_security.approval_directory()) SELECT w.id,w.code,w.name,w.transaction_type,w.status,w.row_version::text,v.version,v.activation_conditions,v.allow_self_approval,coalesce((SELECT jsonb_agg(jsonb_build_object('level',s.level,'approverId',s.approver_id,'name',m.name,'permission',s.required_permission) ORDER BY s.level) FROM inventory.approval_workflow_steps s LEFT JOIN directory m ON m.id=s.approver_id WHERE s.workflow_version_id=v.id),'[]'::jsonb) steps FROM inventory.approval_workflows w LEFT JOIN LATERAL (SELECT * FROM inventory.approval_workflow_versions WHERE workflow_id=w.id AND published_at IS NOT NULL ORDER BY version DESC LIMIT 1) v ON true WHERE w.name ILIKE $1 OR w.code ILIKE $1 ORDER BY w.created_at DESC,w.id LIMIT 21 OFFSET $2`, ['%' + p.query + '%', (p.page - 1) * 20])).rows; return { rows: rows.slice(0, 20), hasMore: rows.length > 20 }; }); }
    async publish(t: string | undefined, input: unknown) { const p = this.parse(S.publish, input), x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => (await q.query<{
        id: string;
    }>('SELECT inventory_security.approval_publish($1,$2,$3,$4) id', [p.id, p.version, p.key, p.data])).rows[0]); }
    async state(t: string | undefined, input: unknown) { const p = this.parse(z.object({ id: S.id, version: S.version, reason: S.reason }).strict(), input), x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => { await q.query('SELECT inventory_security.approval_workflow_state($1,$2,false,$3)', [p.id, p.version, p.reason]); return { ok: true }; }); }
    async list(t: string | undefined, input: unknown) { const p = this.parse(z.object({ page, tab: z.enum(['inbox', 'mine', 'history']).default('inbox'), query: z.string().max(180).default(''), status: z.enum(['all', 'pending', 'partially_approved', 'approved', 'rejected', 'revision_required', 'cancelled']).default('all') }), input), x = await this.scope(t); return this.run(x, t, 'approval.access', async (q) => { const rows = (await q.query<S.InstanceRow>(`SELECT i.id,i.document_id,d.document_number,d.document_type,i.document_revision,i.status,i.current_level,i.row_version::text,i.workflow_snapshot->>'name' workflow_name,i.created_at,(i.status IN ('pending','partially_approved') AND d.status IN ('pending','partially_approved') AND inventory_security.approval_authorized($1,s,i)) can_decide FROM inventory.approval_instances i JOIN inventory.business_documents d ON d.tenant_id=i.tenant_id AND d.id=i.document_id JOIN inventory.approval_instance_steps s ON s.tenant_id=i.tenant_id AND s.instance_id=i.id AND s.level=i.current_level WHERE inventory_security.approval_can_see(i.id) AND ($2='history' OR $2='mine' AND i.requested_by=$1 OR $2='inbox' AND i.status IN ('pending','partially_approved') AND d.status IN ('pending','partially_approved') AND inventory_security.approval_authorized($1,s,i)) AND ($3='all' OR i.status=$3) AND d.document_number ILIKE $4 ORDER BY i.created_at DESC,i.id LIMIT 21 OFFSET $5`, [x.session.active_membership_id, p.tab, p.status, '%' + p.query + '%', (p.page - 1) * 20])).rows; return { rows: rows.slice(0, 20), hasMore: rows.length > 20 }; }); }
    async detail(t: string | undefined, id: string): Promise<S.Detail> { this.parse(S.id, id); const x = await this.scope(t); return this.run(x, t, 'approval.access', async (q) => (await q.query<{
        data: S.Detail;
    }>('SELECT inventory_security.approval_read($1) data', [id])).rows[0].data); }
    async forDocument(t: string | undefined, id: string) { this.parse(S.id, id); const x = await this.scope(t), perms = await this.auth.repo.permissions(x); return this.run(x, t, 'approval.access', async (q) => { const d = (await q.query<{
        requested_by: string;
        review_mode_snapshot: string;
        status: string;
    }>('SELECT requested_by,review_mode_snapshot,status FROM inventory.business_documents WHERE id=$1', [id])).rows[0]; if (!d)
        throw new AppError('NOT_FOUND', 404, 'Dokumen tidak ditemukan.'); const rows = (await q.query<{
        id: string;
        document_revision: number;
        status: string;
        current_level: number;
    }>('SELECT id,document_revision,status,current_level FROM inventory.approval_instances WHERE document_id=$1 AND inventory_security.approval_can_see(id) ORDER BY document_revision DESC LIMIT 100', [id])).rows; return { instances: rows, engine: d.review_mode_snapshot === 'engine_v1', configured: (await q.query<{
            v: boolean;
        }>('SELECT inventory_security.approval_has_workflow($1) v', [id])).rows[0].v, owner: d.requested_by === x.session.active_membership_id, canReturn: perms.includes('approval.manage') && d.requested_by !== x.session.active_membership_id }; }); }
    async decide(t: string | undefined, input: unknown) { const p = this.parse(S.decision, input), x = await this.scope(t); return this.run(x, t, 'approval.access', async (q) => (await q.query<{
        data: unknown;
    }>('SELECT inventory_security.approval_decide($1,$2,$3,$4,$5,$6) data', [p.instanceId, p.version, p.level, p.decision, p.reason, p.key])).rows[0].data); }
    async submit(t: string | undefined, input: unknown) { const p = this.parse(S.documentAction, input), x = await this.scope(t); return this.run(x, t, 'approval.access', async (q) => (await q.query<{
        id: string;
    }>('SELECT inventory_security.approval_submit($1,$2,$3) id', [p.documentId, p.version, p.reason])).rows[0]); }
    async cancel(t: string | undefined, input: unknown) { return this.docAction(t, input, 'cancel'); }
    async returnForRevision(t: string | undefined, input: unknown) { return this.docAction(t, input, 'return'); }
    private async docAction(t: string | undefined, input: unknown, kind: 'cancel' | 'return') { const p = this.parse(S.documentAction, input), x = await this.scope(t); return this.run(x, t, 'approval.access', async (q) => { await q.query(`SELECT inventory_security.approval_${kind}($1,$2,$3)`, [p.documentId, p.version, p.reason]); return { ok: true }; }); }
    async history(t: string | undefined, id: string) { this.parse(S.id, id); const x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => ({ versions: (await q.query<{
            version: number;
            activation_conditions: Record<string, unknown>;
            allow_self_approval: boolean;
            published_at: string;
            steps: {
                level: number;
                name: string;
                permission: string;
            }[];
        }>(`SELECT v.version,v.activation_conditions,v.allow_self_approval,v.published_at,coalesce((SELECT jsonb_agg(jsonb_build_object('level',s.level,'name',coalesce(m.name,'Anggota nonaktif'),'permission',s.required_permission) ORDER BY s.level) FROM inventory.approval_workflow_steps s LEFT JOIN inventory_security.approval_directory() m ON m.id=s.approver_id WHERE s.workflow_version_id=v.id),'[]'::jsonb) steps FROM inventory.approval_workflow_versions v WHERE v.workflow_id=$1 ORDER BY v.version DESC LIMIT 100`, [id])).rows, events: (await q.query<{
            id: string;
            action: string;
            reason: string;
            created_at: string;
            actor_name: string;
        }>(`SELECT e.id,e.action,e.reason,e.created_at,coalesce(m.name,'Anggota nonaktif') actor_name FROM inventory.approval_events e LEFT JOIN inventory_security.approval_directory() m ON m.id=e.actor_id WHERE e.workflow_id=$1 ORDER BY e.created_at DESC LIMIT 200`, [id])).rows })); }
    async delegates(t: string | undefined, input: unknown) { const p = this.parse(z.object({ page }), input), x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => { const rows = (await q.query<S.Delegation>('SELECT d.*,d.row_version::text,w.name workflow_name FROM inventory.approval_delegations d JOIN inventory.approval_workflows w ON w.tenant_id=d.tenant_id AND w.id=d.workflow_id ORDER BY d.created_at DESC,d.id LIMIT 21 OFFSET $1', [(p.page - 1) * 20])).rows; return { rows: rows.slice(0, 20), hasMore: rows.length > 20 }; }); }
    async delegate(t: string | undefined, input: unknown) { const p = this.parse(S.delegate, input), x = await this.scope(t, 'approval.manage'); return this.run(x, t, 'approval.manage', async (q) => (await q.query<{
        id: string;
    }>('SELECT inventory_security.approval_delegate($1,$2,$3,$4,$5,$6,$7,$8) id', [p.id, p.version, p.fromId, p.toId, p.workflowId, p.startAt, p.endAt, p.reason])).rows[0]); }
}
