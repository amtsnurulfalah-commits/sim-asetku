import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService, tokenDigest } from '@/lib/session/service';
import type { Snapshot } from '@/lib/session/repository';
import type { Sql } from '@/lib/db/types';
import { AppError } from '@/lib/security/errors';
import { mapSupplyError } from '@/features/supply/service';
import * as S from './schemas';
import { parseScan } from '@/features/assets/qr';
export function mapTransactionError(e: unknown) {
    if (e instanceof AppError)
        return e;
    const { code, message = '' } = (e ?? {}) as {
        code?: string;
        message?: string;
    };
    if (code === '23514')
        return new AppError('TRANSACTION_RULE_DENIED', 409, message.includes('Disposal evidence') ? 'Unggah dan tautkan bukti penghapusan yang sudah diverifikasi.' : message.includes('General approval') ? 'Workflow approval umum aktif. Kebijakan satu admin tidak dapat melewatinya.' : message.includes('Complete all inspections') ? 'Selesaikan pemeriksaan seluruh aset pada snapshot.' : message.includes('Idempotency') ? 'Kunci operasi sudah dipakai untuk isi berbeda. Buka formulir baru.' : 'Transaksi belum memenuhi aturan. Periksa ketersediaan aset, sumber transaksi, lokasi aktif, kondisi, dan tanggal.');
    if (code === '42501')
        return new AppError('PERMISSION_DENIED', 403, 'Tindakan tidak diizinkan. Periksa izin, pemilik draf, petugas pemeriksa, reviewer independen, dan kebijakan review.');
    if (code === '40001')
        return new AppError('VERSION_CONFLICT', 409, 'Data dokumen atau aset berubah. Muat ulang; minta reviewer mengembalikan dokumen approved untuk revisi snapshot sebelum posting.');
    return mapSupplyError(e);
}
const select = `SELECT d.id,d.document_number,x.kind,d.status,d.review_mode_snapshot,d.row_version::text,d.revision,d.business_date::text,d.requested_by,x.payload,x.parent_id FROM inventory.asset_transactions x JOIN inventory.business_documents d ON d.tenant_id=x.tenant_id AND d.id=x.id`;
const uuid = z.string().uuid();
const paging = z.coerce.number().int().min(1).max(10000).default(1);
export class TransactionService {
    constructor(public auth: AuthService) { }
    private parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> { const r = schema.safeParse(input); if (!r.success)
        throw new AppError('VALIDATION_ERROR', 400, 'Periksa kelengkapan isian dan tanggal transaksi.'); return r.data; }
    private scope(t: string | undefined, p = 'assets.view') { return this.auth.session(t, { permission: p, sensitive: true }); }
    private run<T>(x: Snapshot, t: string | undefined, p: string, fn: (q: Sql) => Promise<T>) { return this.auth.repo.db.run('runtime', { tenantId: x.session.active_tenant_id!, userId: x.user.id, membershipId: x.session.active_membership_id!, sessionDigest: tokenDigest(t!), correlationId: randomUUID() }, async (q) => { await q.query('SELECT inventory_security.assert_transaction_actor($1)', [p]); return fn(q); }); }
    async options(t: string | undefined): Promise<S.Options> {
        const x = await this.scope(t);
        const permissions = await this.auth.repo.permissions(x);
        return this.run(x, t, 'assets.view', async (q) => {
            const refs = async (table: string) => (await q.query<S.Ref>(`SELECT id,code,name FROM inventory.${table} WHERE status='active' ORDER BY name LIMIT 1000`)).rows;
            return { tenantId: x.session.active_tenant_id!, permissions, mode: (await q.query<{
                    asset_review_mode: string;
                }>('SELECT asset_review_mode FROM inventory.tenant_settings')).rows[0].asset_review_mode, rooms: await refs('rooms'), conditions: await refs('asset_conditions'), categories: await refs('asset_categories'), suppliers: await refs('suppliers'), members: (await q.query<S.Ref>(`SELECT * FROM inventory_security.asset_member_options('assets.view')`)).rows };
        });
    }
    async list(t: string | undefined, input: unknown): Promise<S.List> { const p = this.parse(z.object({ kind: z.enum(S.kinds).optional(), status: z.enum(['all', 'draft', 'submitted', 'pending', 'partially_approved', 'approved', 'posted', 'rejected', 'revision_required', 'cancelled']).default('all'), query: z.string().max(180).default(''), page: paging }), input), x = await this.scope(t); return this.run(x, t, 'assets.view', async (q) => { const rows = (await q.query<S.Doc>(select + ` WHERE ($1::text IS NULL OR x.kind=$1) AND ($2='all' OR d.status=$2) AND (d.document_number ILIKE $3 OR d.supply_reason ILIKE $3) ORDER BY d.created_at DESC,d.id LIMIT 21 OFFSET $4`, [p.kind ?? null, p.status, '%' + p.query + '%', (p.page - 1) * 20])).rows; return { rows: rows.slice(0, 20), page: p.page, hasMore: rows.length > 20 }; }); }
    async assets(t: string | undefined, input: unknown) { const p = this.parse(z.object({ query: z.string().max(180).default(''), page: paging, parentId: uuid.nullable().default(null) }), input), x = await this.scope(t); return this.run(x, t, 'assets.view', async (q) => { const rows = (await q.query<S.AssetChoice>(`SELECT a.id,a.inventory_code,a.name,a.lifecycle_status,r.name room_name FROM inventory.assets a LEFT JOIN inventory.rooms r ON r.tenant_id=a.tenant_id AND r.id=a.room_id WHERE (a.name ILIKE $1 OR a.inventory_code ILIKE $1) AND ($2::uuid IS NULL OR EXISTS(SELECT FROM inventory.asset_transaction_lines l WHERE l.tenant_id=a.tenant_id AND l.asset_id=a.id AND l.transaction_id=$2)) ORDER BY a.inventory_code LIMIT 21 OFFSET $3`, ['%' + p.query + '%', p.parentId, (p.page - 1) * 20])).rows; return { rows: rows.slice(0, 20), hasMore: rows.length > 20, page: p.page }; }); }
    async detail(t: string | undefined, id: string): Promise<S.Detail> { this.parse(uuid, id); const x = await this.scope(t), perms = await this.auth.repo.permissions(x); return this.run(x, t, 'assets.view', async (q) => { const d = (await q.query<S.Doc>(select + ' WHERE d.id=$1', [id])).rows[0]; if (!d)
        throw new AppError('NOT_FOUND', 404, 'Transaksi tidak ditemukan.'); return { unregistered:(await q.query<S.Detail['unregistered'][number]>("SELECT id,reason,created_at FROM inventory.asset_transaction_events WHERE transaction_id=$1 AND action='unregistered' ORDER BY created_at LIMIT 2000",[id])).rows, document: d, lines: (await q.query<S.Line>('SELECT * FROM inventory.asset_transaction_lines WHERE transaction_id=$1 ORDER BY snapshot->>\'code\' LIMIT 2000', [id])).rows, events: (await q.query<S.Detail['events'][number]>(`SELECT * FROM (SELECT e.id,e.action,e.reason,coalesce(m.name,'Anggota nonaktif') actor_name,e.created_at FROM inventory.asset_transaction_events e LEFT JOIN inventory_security.asset_member_options('assets.view') m ON m.id=e.actor_id WHERE e.transaction_id=$1 UNION ALL SELECT id,action,reason,actor_name,created_at FROM inventory_security.document_approval_trail($1)) history ORDER BY created_at DESC LIMIT 200`, [id])).rows, files: perms.includes('files.download') ? (await q.query<S.Detail['files'][number]>(`SELECT f.id,f.original_filename,f.sensitivity,f.file_size::text,f.mime_type,f.status FROM inventory.document_attachments a JOIN inventory.file_attachments f ON f.tenant_id=a.tenant_id AND f.id=a.file_id WHERE a.document_id=$1 AND (f.sensitivity='normal' OR $2) ORDER BY a.created_at DESC LIMIT 100`, [id, perms.includes('files.sensitive.download')])).rows : [], related: (await q.query<S.Detail['related'][number]>(`SELECT d.id,d.document_number,x.kind,d.status FROM inventory.asset_transactions x JOIN inventory.business_documents d ON d.tenant_id=x.tenant_id AND d.id=x.id WHERE x.parent_id=$1 OR x.id=$2 ORDER BY d.created_at DESC LIMIT 100`, [id, d.parent_id])).rows }; }); }
    async save(t: string | undefined, input: unknown) { const p = this.parse(S.save, input), permission = S.permission(p.data.kind), x = await this.scope(t, permission); return this.run(x, t, permission, async (q) => ({ id: (await q.query<{
            id: string;
        }>('SELECT inventory_security.transaction_save($1,$2,$3,$4) id', [p.id, p.version, p.key, p.data])).rows[0].id })); }
    async transition(t: string | undefined, input: unknown) { const p = this.parse(S.transition, input), x = await this.scope(t); return this.run(x, t, 'assets.view', async (q) => { await q.query('SELECT inventory_security.transaction_transition($1,$2,$3,$4)', [p.id, p.version, p.action, p.reason]); return { ok: true }; }); }
    async post(t: string | undefined, input: unknown) { const p = this.parse(z.object({ id: uuid }).strict(), input), x = await this.scope(t); return this.run(x, t, 'assets.view', async (q) => (await q.query<{
        data: unknown;
    }>('SELECT inventory_security.transaction_post($1) data', [p.id])).rows[0].data); }
    async observe(t: string | undefined, input: unknown) { const p = this.parse(S.observation, input), x = await this.scope(t, 'stockopname.execute'); return this.run(x, t, 'stockopname.execute', async (q) => { await q.query('SELECT inventory_security.transaction_observe($1,$2,$3,$4)', [p.id, p.version, p.assetId, p.data]); return { ok: true }; }); }
    async policy(t: string | undefined, input: unknown) { const p = this.parse(z.object({ mode: z.enum(['disabled', 'single_admin_v1']), reason: z.string().trim().min(3).max(2000) }).strict(), input), x = await this.scope(t, 'settings.manage'); return this.run(x, t, 'settings.manage', async (q) => { await q.query('SELECT inventory_security.transaction_policy($1,$2)', [p.mode, p.reason]); return { ok: true }; }); }
    async link(t: string | undefined, input: unknown) { const p = this.parse(z.object({ id: uuid, fileId: uuid, purpose: z.enum(['handover', 'before', 'after', 'evidence', 'report', 'decision']) }).strict(), input), x = await this.scope(t, 'files.upload'); return this.run(x, t, 'files.upload', async (q) => { await q.query('SELECT inventory_security.transaction_link($1,$2,$3)', [p.id, p.fileId, p.purpose]); return { ok: true }; }); }
    async fileChoices(t:string|undefined,input:unknown){const p=this.parse(z.object({query:z.string().max(180).default(''),page:paging}),input),x=await this.scope(t,'files.download'),permissions=await this.auth.repo.permissions(x);return this.run(x,t,'files.download',async q=>{const rows=(await q.query<{id:string;original_filename:string}>("SELECT id,original_filename FROM inventory.file_attachments WHERE status='ready' AND (sensitivity='normal' OR $1) AND original_filename ILIKE $2 ORDER BY created_at DESC,id LIMIT 21 OFFSET $3",[permissions.includes('files.sensitive.download'),'%'+p.query+'%',(p.page-1)*20])).rows;return {rows:rows.slice(0,20),hasMore:rows.length>20};});}
    async scan(t: string | undefined, value: string, origin: string) { let p:ReturnType<typeof parseScan>;try{p=parseScan(value,origin)}catch{throw new AppError('SCAN_INVALID',400,'Kode QR tidak valid atau bukan milik aplikasi ini.')}const x=await this.scope(t); return this.run(x, t, 'assets.view', async (q) => { const r = (await q.query<{
        id: string;
    }>(`SELECT id FROM inventory.assets WHERE ($1::uuid IS NOT NULL AND public_id=$1) OR ($2::text IS NOT NULL AND inventory_code=$2)`, [p.publicId ?? null, p.code ?? null])).rows[0]; if (!r)
        throw new AppError('NOT_FOUND', 404, 'Aset tidak ditemukan pada lembaga aktif.'); return r; }); }
    async alerts(t: string | undefined) { const x = await this.scope(t); return this.run(x, t, 'assets.view', async (q) => ({ overdue: (await q.query<{
            id: string;
            document_number: string;
            borrower_name: string;
            due_at: string;
            outstanding: string;
        }>(`SELECT x.id,l.document_number,l.borrower_name,l.due_at,count(*)::text outstanding FROM inventory.asset_loans l JOIN inventory.asset_transactions x ON x.tenant_id=l.tenant_id AND x.id=l.business_document_id JOIN inventory.asset_loan_items i ON i.tenant_id=l.tenant_id AND i.loan_id=l.id JOIN inventory.asset_reservations r ON r.tenant_id=i.tenant_id AND r.loan_item_id=i.id WHERE r.released_at IS NULL AND l.due_at<clock_timestamp() GROUP BY x.id,l.id ORDER BY l.due_at LIMIT 100`)).rows, maintenance: (await q.query<{
            id: string;
            name: string;
            next_due_at: string;
        }>(`SELECT s.id,a.name,s.next_due_at FROM inventory.maintenance_schedules s JOIN inventory.assets a ON a.tenant_id=s.tenant_id AND a.id=s.asset_id WHERE s.fulfilled_at IS NULL AND s.next_due_at<=clock_timestamp() AND a.lifecycle_status NOT IN ('disposed','archived') ORDER BY s.next_due_at LIMIT 100`)).rows })); }
}
