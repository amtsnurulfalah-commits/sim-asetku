import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AuthService, tokenDigest } from '@/lib/session/service';
import type { Snapshot } from '@/lib/session/repository';
import type { Sql } from '@/lib/db/types';
import { AppError } from '@/lib/security/errors';
import { mapAssetError } from '@/features/assets/service';
import { driveService } from '@/features/drive/service';
import { labels as transactionLabels } from '@/features/approval/schemas';
import { statusText } from '@/features/supply/schemas';
import * as S from './schemas';
export function reportError(e: unknown) { return mapAssetError(e); }
const fail = (s: string) => { throw new AppError('REPORT_INVALID', 400, s); };
export class ReportService {
    constructor(public auth: AuthService, private readLogo?: (t: string | undefined, id: string, size: number) => Promise<Uint8Array>) { }
    parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> { const x = s.safeParse(v); if (!x.success)
        fail(x.error.issues[0]?.code === 'custom' ? x.error.issues[0].message : 'Periksa filter, format, tanggal dan referensi laporan.'); return x.data!; }
    async scope(t: string | undefined, p = 'reports.view') { return this.auth.session(t, { permission: p, sensitive: true }); }
    private run<T>(x: Snapshot, t: string | undefined, p: string, fn: (q: Sql) => Promise<T>) { return this.auth.repo.db.run('runtime', { tenantId: x.session.active_tenant_id!, userId: x.user.id, membershipId: x.session.active_membership_id!, sessionDigest: tokenDigest(t!), correlationId: randomUUID() }, async (q) => { await q.query('SELECT inventory_security.report_assert($1)', [p]); return fn(q); }, { isolation: 'repeatable read' }); }
    private async metadata(q: Sql, permissions: string[]): Promise<S.Options> { const refs = async (table: string) => (await q.query<S.Ref>(`SELECT id,code,name FROM inventory.${table} ORDER BY name,id LIMIT 1000`)).rows; const tenant = (await q.query<S.Options['tenant']>("SELECT t.name,t.code,t.timezone,coalesce(s.settings->'profile','{}') profile FROM inventory.tenants t LEFT JOIN inventory.tenant_settings s ON s.tenant_id=t.id WHERE t.id=inventory_security.tenant_id()")).rows[0]; const r = (await q.query<{
        configuration: S.Configuration;
        row_version: string;
        version: number;
    }>("SELECT configuration,row_version::text,version FROM inventory.report_templates WHERE code='REPORTING_MAIN'")).rows[0]; const config = r ? this.parse(S.configuration, r.configuration) : structuredClone(S.defaultConfig); if (!config.signers[0].name)
        config.signers[0].name = tenant.profile.principal_name ?? ''; return { permissions, tenant, rooms: await refs('rooms'), buildings: await refs('buildings'), categories: await refs('asset_categories'), conditions: await refs('asset_conditions'), funding: await refs('funding_sources'), logos: permissions.includes('settings.manage') ? (await q.query<S.Options['logos'][number]>("SELECT id,'' code,original_filename name,file_size::text size FROM inventory.file_attachments WHERE status='ready' AND sensitivity='normal' AND mime_type IN ('image/png','image/jpeg') AND file_size<=262144 ORDER BY original_filename LIMIT 1000")).rows : [], config, version: r?.row_version ?? null, templateVersion: r?.version ?? 0 }; }
    async options(t: string | undefined) { const x = await this.scope(t), p = await this.auth.repo.permissions(x); return this.run(x, t, 'reports.view', q => this.metadata(q, p)); }
    async configure(t: string | undefined, v: unknown) { const p = this.parse(z.object({ version: z.string().regex(/^[1-9]\d*$/).nullable(), data: S.configuration }).strict(), v), x = await this.scope(t, 'settings.manage'); return this.run(x, t, 'settings.manage', async (q) => { await q.query('SELECT inventory_security.report_config($1,$2)', [p.version, p.data]); return { saved: true }; }); }
    private assertDomain(p: string[], f: S.Filters) { const need = ['stock', 'stock_usage'].includes(f.kind) ? 'inventory.view' : 'assets.view'; if (f.kind !== 'transactions' && f.kind !== 'minutes' && !p.includes(need))
        throw new AppError('PERMISSION_DENIED', 403, 'Izin membaca domain laporan diperlukan.'); }
    async table(t: string | undefined, raw: unknown): Promise<S.Table> {
        const f = this.parse(S.filters, raw), x = await this.scope(t), permissions = await this.auth.repo.permissions(x);
        this.assertDomain(permissions, f);
        return this.run(x, t, 'reports.view', async (q) => {
            const meta = await this.metadata(q, permissions);
            const table: S.Table = { title: S.labels[f.kind], columns: [], rows: [], count: 0, totals: {}, notes: [], number: 'LAP-' + randomUUID(), meta, generatedAt: new Date().toISOString(), filters: f };
            if (f.kind === 'minutes')
                return this.minutes(q, table, permissions);
            let query = '', args: unknown[] = [];
            if (['assets', 'kib', 'kir', 'depreciation'].includes(f.kind)) {
                const group = meta.config.kibGroups.find(g => g.code === f.group);
                if (f.kind === 'kib' && f.group !== 'all' && !group)
                    fail('Kelompok KIB tidak tersedia.');
                args = [f.period, f.buildingId, f.roomId, f.categoryId, f.conditionId, f.fundingId, f.year, '%' + f.query + '%', f.status, f.kind === 'kib' ? group?.kinds ?? null : null, f.postedBefore];
                query = `SELECT a.id,a.inventory_code code,a.name,c.name category,c.asset_kind kind,b.name building,r.name room,k.name condition,a.acquisition_date::text date,extract(year from a.acquisition_date)::text AS "year",fs.name funding,a.acquisition_cost::text cost,a.residual_value::text residual,s.accumulated::text accumulated,(a.acquisition_cost-s.accumulated)::text book,s.expense::text expense,(a.acquisition_cost-s.prior)::text bookBefore,s.prior::text prior,coalesce(l.area_sqm,g.area_sqm)::text area,a.brand,a.model,a.serial_number serial,a.notes,CASE WHEN g.construction_status='in_progress' THEN 'Dalam pengerjaan' ELSE '' END construction FROM inventory.assets a JOIN inventory.asset_categories c ON c.tenant_id=a.tenant_id AND c.id=a.category_id JOIN inventory.asset_conditions k ON k.tenant_id=a.tenant_id AND k.id=a.condition_id LEFT JOIN inventory.rooms r ON r.tenant_id=a.tenant_id AND r.id=a.room_id LEFT JOIN inventory.buildings b ON b.tenant_id=r.tenant_id AND b.id=r.building_id LEFT JOIN inventory.funding_sources fs ON fs.tenant_id=a.tenant_id AND fs.id=a.funding_source_id LEFT JOIN inventory.asset_land_details l ON l.tenant_id=a.tenant_id AND l.asset_id=a.id LEFT JOIN inventory.asset_building_details g ON g.tenant_id=a.tenant_id AND g.asset_id=a.id LEFT JOIN LATERAL(SELECT coalesce(sum(amount),0) accumulated,coalesce(sum(amount) FILTER(WHERE period<$1::date),0) prior,coalesce(sum(amount) FILTER(WHERE period=$1::date),0) expense FROM inventory.depreciation_entries WHERE asset_id=a.id AND period<=$1::date AND ($11::timestamptz IS NULL OR created_at<=$11)) s ON true WHERE c.asset_kind<>'inventory' AND a.acquisition_date<($1::date+interval '1 month') AND ($2::uuid IS NULL OR b.id=$2) AND ($3::uuid IS NULL OR r.id=$3) AND ($4::uuid IS NULL OR c.id=$4) AND ($5::uuid IS NULL OR k.id=$5) AND ($6::uuid IS NULL OR fs.id=$6) AND ($7::int IS NULL OR extract(year from a.acquisition_date)=$7) AND (a.inventory_code ILIKE $8 OR a.name ILIKE $8) AND ($9='all' OR a.lifecycle_status=$9) AND ($10::text[] IS NULL OR c.asset_kind=ANY($10)) AND ($11::timestamptz IS NULL OR a.created_at<=$11)`;
                const selected = f.kind === 'depreciation' ? ['code', 'name', 'cost', 'prior', 'expense', 'accumulated', 'book'] : meta.config.assetColumns;
                table.columns = selected.map(key => ({ key, label: meta.config.columnTitles[key] ?? ({ prior: 'Akumulasi awal', expense: 'Beban periode', ...S.columnLabels } as Record<string, string>)[key] ?? key, money: ['cost', 'residual', 'prior', 'expense', 'accumulated', 'book'].includes(key) }));
                table.notes.push('Nilai akhir periode efektif; nama, lokasi, kondisi dan dasar aset tanpa jurnal mengikuti master terkini. Bukan snapshot lengkap seluruh master historis.', 'Aset disposed/archived tetap tercakup bila filter status Semua; angka ini bukan otomatis nilai aset aktif.');
                if (f.kind === 'kib') {
                    if (group)
                        table.title += ' - ' + group.code + ' ' + group.name;
                    table.notes.push('KIB memakai pemetaan kelompok dan kolom tenant; bukan sertifikasi format resmi. Persediaan tidak dimasukkan sebagai aset tetap.');
                }
                const data = (await q.query<{
                    rows: S.Row[];
                    count: string;
                    totals: Record<string, string>;
                }>(`WITH data AS (${query}) SELECT (SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]') FROM (SELECT * FROM data ORDER BY code,id LIMIT 5001) v) rows,count(*)::text count,jsonb_build_object('cost',coalesce(sum(cost::numeric),0)::text,'expense',coalesce(sum(expense::numeric),0)::text,'accumulated',coalesce(sum(accumulated::numeric),0)::text,'book',coalesce(sum(book::numeric),0)::text) totals FROM data`, args)).rows[0];
                table.rows = data.rows;
                table.count = Number(data.count);
                table.totals = data.totals;
            }
            else if (f.kind === 'transactions') {
                args = [f.from, f.to, '%' + f.query + '%', f.transactionType, f.documentStatus, permissions.includes('assets.view'), permissions.includes('inventory.view'), permissions.includes('procurement.manage'), permissions.includes('depreciation.manage'), x.session.active_membership_id];
                query = `SELECT d.id,d.document_number code,d.business_date::text date,d.document_type type,d.status,d.revision::text revision,d.supply_reason reason FROM inventory.business_documents d WHERE ($1::date IS NULL OR d.business_date>=$1) AND ($2::date IS NULL OR d.business_date<=$2) AND (d.document_number ILIKE $3 OR d.supply_reason ILIKE $3) AND ($4='all' OR d.document_type=$4) AND ($5='all' OR d.status=$5) AND ((d.document_type LIKE 'asset:%' AND $6) OR (d.document_type LIKE 'supply:%' AND $7 AND (d.supply_kind NOT IN ('request','order') OR $8)) OR (d.document_type LIKE 'finance:%' AND $6 AND (d.status='posted' OR $9 OR d.requested_by=$10 OR EXISTS(SELECT FROM inventory.approval_instances i WHERE i.document_id=d.id AND inventory_security.approval_can_see(i.id)))))`;
                table.columns = [['code', 'Nomor'], ['date', 'Tanggal'], ['type', 'Jenis'], ['status', 'Status'], ['revision', 'Revisi'], ['reason', 'Alasan']].map(([key, label]) => ({ key, label }));
                table.notes.push('Tanggal adalah tanggal bisnis dokumen; tidak dibatasi bulan valuasi. Akses pengadaan dan draft penyusutan tetap mengikuti kewenangan domain.');
            }
            else if (f.kind === 'stock' || f.kind === 'stock_usage') {
                args = [f.roomId, f.buildingId, f.categoryId, '%' + f.query + '%', f.from, f.to];
                if (f.kind === 'stock')
                    query = `SELECT i.id,i.code,i.name,r.name room,u.name unit,coalesce(b.quantity,0)::text quantity,coalesce(b.stock_value,0)::text value,i.minimum_stock::text minimum FROM inventory.inventory_items i JOIN inventory.units u ON u.id=i.unit_id AND u.tenant_id=i.tenant_id LEFT JOIN inventory.inventory_stock_balances b ON b.item_id=i.id AND b.tenant_id=i.tenant_id LEFT JOIN inventory.rooms r ON r.id=b.room_id AND r.tenant_id=b.tenant_id WHERE ($1::uuid IS NULL OR r.id=$1) AND ($2::uuid IS NULL OR r.building_id=$2) AND ($3::uuid IS NULL OR i.category_id=$3) AND (i.code ILIKE $4 OR i.name ILIKE $4)`;
                else
                    query = `SELECT l.id,i.code,i.name,r.name room,l.kind type,l.quantity_delta::text quantity,l.value_delta::text value,d.document_number document,d.business_date::text date FROM inventory.inventory_stock_ledger l JOIN inventory.inventory_items i ON i.id=l.item_id AND i.tenant_id=l.tenant_id JOIN inventory.rooms r ON r.id=l.room_id AND r.tenant_id=l.tenant_id JOIN inventory.business_documents d ON d.id=l.source_document_id AND d.tenant_id=l.tenant_id WHERE l.kind='issue' AND ($1::uuid IS NULL OR r.id=$1) AND ($2::uuid IS NULL OR r.building_id=$2) AND ($3::uuid IS NULL OR i.category_id=$3) AND (i.code ILIKE $4 OR i.name ILIKE $4) AND ($5::date IS NULL OR d.business_date>=$5) AND ($6::date IS NULL OR d.business_date<=$6)`;
                if (f.kind === 'stock')
                    args = args.slice(0, 4);
                table.columns = (f.kind === 'stock' ? [['code', 'Kode'], ['name', 'Barang'], ['room', 'Ruangan'], ['unit', 'Satuan'], ['quantity', 'Jumlah'], ['minimum', 'Batas minimum per barang'], ['value', 'Nilai saldo']] : [['document', 'Dokumen'], ['date', 'Tanggal'], ['code', 'Kode'], ['name', 'Barang'], ['room', 'Ruangan'], ['quantity', 'Keluar (bertanda)'], ['value', 'Nilai keluar (bertanda)']]).map(([key, label]) => ({ key, label, money: key === 'value' }));
                table.notes.push(f.kind === 'stock' ? 'Saldo terkini per ruangan, termasuk barang tanpa saldo. Batas minimum berlaku pada total barang lintas ruangan, bukan per baris. Filter bulan/tanggal tidak diterapkan pada saldo terkini.' : 'Penggunaan berasal dari ledger kind issue, delta negatif. Koreksi/reversal terpisah tidak dianggap konsumsi baru.');
            }
            if (query && !['assets', 'kib', 'kir', 'depreciation'].includes(f.kind)) {
                const r = (await q.query<{
                    rows: S.Row[];
                    count: string;
                    total: string;
                }>(`WITH data AS (${query}) SELECT (SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]') FROM (SELECT * FROM data ORDER BY code,id LIMIT 5001) v) rows,count(*)::text count,${f.kind === 'transactions' ? "'0'" : "coalesce(sum(value::numeric),0)::text"} total FROM data`, args)).rows[0];
                table.rows = r.rows;
                table.count = Number(r.count);
                table.totals = f.kind === 'transactions' ? {} : { value: r.total };
            }
            table.rows = table.rows.map(r => ({ ...r, ...(r.type ? { rawType: r.type, type: transactionLabels[r.type as keyof typeof transactionLabels] ?? r.type } : {}), ...(r.status ? { status: statusText[r.status] ?? r.status } : {}) }));
            return table;
        });
    }
    private async minutes(q: Sql, table: S.Table, p: string[]) { const id = table.filters.documentId!; const d = (await q.query<{
        id: string;
        document_type: string;
        status: string;
        document_number: string;
        business_date: string;
        supply_reason: string;
        revision: number;
        input_snapshot: Record<string, unknown>;
    }>("SELECT id,document_type,status,document_number,business_date::text,supply_reason,revision,input_snapshot FROM inventory.business_documents WHERE id=$1", [id])).rows[0]; if (!d)
        throw new AppError('NOT_FOUND', 404, 'Dokumen sumber tidak ditemukan.'); const asset = d.document_type.startsWith('asset:'); if (!asset && d.document_type !== 'supply:receipt')
        fail('Berita acara tersedia untuk transaksi aset dan penerimaan pengadaan.'); if (!p.includes(asset ? 'assets.view' : 'inventory.view'))
        throw new AppError('PERMISSION_DENIED', 403, 'Izin membaca sumber diperlukan.'); table.number = d.document_number; table.status = d.status; table.title = 'Berita Acara ' + (d.document_type === 'asset:placement' ? 'Serah Terima / Penempatan Barang' : transactionLabels[d.document_type as keyof typeof transactionLabels] ?? d.document_type); table.notes.push('Tanggal sumber ' + d.business_date + ' · Revisi ' + d.revision, d.supply_reason ?? ''); if (d.status !== 'posted')
        table.notes.unshift('DRAF - Belum menjadi hasil transaksi final.'); if (asset) {
        const payload = (await q.query<{
            payload: Record<string, unknown>;
        }>('SELECT payload FROM inventory.asset_transactions WHERE id=$1', [id])).rows[0]?.payload ?? {};
        for (const [key, label] of [['borrower', 'Peminjam'], ['startAt', 'Mulai'], ['dueAt', 'Batas kembali'], ['completedAt', 'Selesai'], ['cost', 'Biaya'], ['costTreatment', 'Perlakuan biaya']]) {
            if (typeof payload[key] === 'string')
                table.notes.push(label + ': ' + payload[key]);
        }
        if (typeof payload.roomId === 'string')
            table.notes.push('Tujuan: ' + (table.meta.rooms.find(r => r.id === payload.roomId)?.name ?? 'Referensi ruangan tersimpan'));
        const raw = (await q.query<{
            snapshot: Record<string, string>;
            observation: Record<string, string> | null;
        }>("SELECT snapshot,observation FROM inventory.asset_transaction_lines WHERE transaction_id=$1 ORDER BY snapshot->>'code' LIMIT 5001", [id])).rows;
        table.columns = [{ key: 'code', label: 'Kode' }, { key: 'name', label: 'Aset' }, { key: 'room', label: 'Lokasi snapshot' }, { key: 'condition', label: 'Kondisi snapshot' }, { key: 'result', label: 'Hasil / catatan' }];
        table.rows = raw.map(l => ({ code: l.snapshot.code, name: l.snapshot.name, room: table.meta.rooms.find(r => r.id === l.snapshot.roomId)?.name ?? 'Tanpa ruangan', condition: table.meta.conditions.find(r => r.id === l.snapshot.conditionId)?.name ?? '—', result: l.observation ? [l.observation.finding, l.observation.notes].filter(Boolean).join(' · ') : 'Sesuai dokumen' }));
        const extras = (await q.query<{
            reason: string;
        }>("SELECT reason FROM inventory.asset_transaction_events WHERE transaction_id=$1 AND action='unregistered' ORDER BY created_at LIMIT 2001", [id])).rows;
        if (extras.length > 2000)
            fail('Terlalu banyak temuan untuk berita acara sinkron.');
        table.notes.push(...extras.map(e => 'Barang tidak terdaftar: ' + e.reason));
        if (d.document_type === 'asset:opname')
            table.notes.push('Temuan memerlukan tindak lanjut terpisah, tidak otomatis mengubah stok atau aset.');
    }
    else {
        table.rows = (await q.query<S.Row>(`SELECT p.description name,i.quantity::text quantity,i.accepted_quantity::text accepted,r.name room,i.inspection_notes inspection FROM inventory.goods_receipts g JOIN inventory.goods_receipt_items i ON i.receipt_id=g.id AND i.tenant_id=g.tenant_id JOIN inventory.procurement_items p ON p.id=i.procurement_item_id AND p.tenant_id=i.tenant_id JOIN inventory.rooms r ON r.id=i.room_id AND r.tenant_id=i.tenant_id WHERE g.business_document_id=$1 ORDER BY i.line_number LIMIT 5001`, [id])).rows;
        table.columns = [{ key: 'name', label: 'Barang' }, { key: 'quantity', label: 'Diterima' }, { key: 'accepted', label: 'Baik' }, { key: 'room', label: 'Ruangan' }, { key: 'inspection', label: 'Hasil pemeriksaan' }];
    } ; table.count = table.rows.length; table.approval = (await q.query<{
        action: string;
        actor_name: string;
        reason: string;
        created_at: string;
    }>('SELECT * FROM inventory_security.document_approval_trail($1)', [id])).rows.map(e => `${e.action} · ${e.actor_name} · ${e.created_at} · ${e.reason}`); table.notes.push('Identitas lokasi/kondisi ditampilkan dengan nama master terkini berdasarkan ID snapshot. Tanda tangan pada cetakan dilengkapi pihak berwenang.'); return table; }
    async preview(t: string | undefined, v: unknown, page = 1) { const n = this.parse(z.coerce.number().int().min(1).max(200), page), data = await this.table(t, v); return { ...data, rows: data.rows.slice((n - 1) * 25, n * 25), hasMore: n * 25 < Math.min(data.count, 5000), page: n }; }
    async export(t: string | undefined, v: unknown) {
        const b = this.parse(z.object({ format: z.enum(['pdf', 'xlsx']), filters: S.filters }).strict(), v);
        await this.scope(t, 'reports.export');
        const data = await this.table(t, b.filters);
        if (data.count > 5000)
            throw new AppError('REPORT_LIMIT', 409, 'Ekspor maksimal 5.000 baris. Persempit filter; hasil tidak dipotong otomatis.');
        const textSize=data.rows.reduce((n,row)=>n+data.columns.reduce((m,c)=>m+String(row[c.key]??'').length,0),0)+data.notes.join('').length+(data.approval??[]).join('').length;
        if(textSize>(b.format==='pdf'?120000:2000000))throw new AppError('REPORT_SIZE',409,'Isi laporan terlalu panjang untuk ekspor sinkron. Persempit filter atau kurangi kolom/catatan.');
        let logo: Uint8Array | undefined;
        if (data.meta.config.logoFileId) {
            const x = await this.scope(t, 'files.download');
            const size = await this.run(x, t, 'files.download', async (q) => (await q.query<{
                size: number;
            }>("SELECT file_size::int size FROM inventory.file_attachments WHERE id=$1 AND status='ready' AND sensitivity='normal' AND mime_type IN ('image/png','image/jpeg') AND file_size<=262144", [data.meta.config.logoFileId])).rows[0]?.size);
            if (!size)
                fail('Logo tidak tersedia; perbarui konfigurasi.');
            logo = this.readLogo ? await this.readLogo(t, data.meta.config.logoFileId, size) : (await driveService(this.auth).download(t, data.meta.config.logoFileId, 0, size - 1, true)).bytes;
        }
        const { reportPdf, reportXlsx } = await import('./export');
        const bytes = b.format === 'pdf' ? await reportPdf(data, logo) : await reportXlsx(data, logo);
        const hash = createHash('sha256').update(bytes).digest('hex'), id = randomUUID(), x = await this.scope(t, 'reports.export');
        await this.run(x, t, 'reports.export', q => q.query('SELECT inventory_security.report_record_export($1,$2,$3,$4,$5,$6,$7)', [id, b.format, b.filters.kind, b.filters, { config: data.meta.config, version: data.meta.templateVersion, number: data.number, generatedAt: data.generatedAt, totals: data.totals }, data.count, hash]));
        return { bytes, name: `laporan-${b.filters.kind}-${id}.${b.format}`, mime: b.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    async dashboard(t: string | undefined, raw: unknown) {
        const f = this.parse(S.filters, raw), x = await this.scope(t, 'dashboard.view'), p = await this.auth.repo.permissions(x);
        return this.run(x, t, 'dashboard.view', async (q) => {
            const cards: Record<string, string> = {}, charts: Record<string, {
                label: string;
                value: string;
            }[]> = {};
            if (p.includes('assets.view')) {
                const args = [f.period, f.buildingId, f.roomId, f.categoryId, f.conditionId, f.fundingId, f.year, '%' + f.query + '%'];
                const base = `FROM inventory.assets a JOIN inventory.asset_categories c ON c.id=a.category_id AND c.tenant_id=a.tenant_id JOIN inventory.asset_conditions k ON k.id=a.condition_id AND k.tenant_id=a.tenant_id LEFT JOIN inventory.rooms r ON r.id=a.room_id AND r.tenant_id=a.tenant_id LEFT JOIN LATERAL(SELECT coalesce(sum(amount),0) accumulated FROM inventory.depreciation_entries WHERE asset_id=a.id AND period<=$1::date) s ON true WHERE c.asset_kind<>'inventory' AND a.lifecycle_status NOT IN ('disposed','archived') AND a.acquisition_date<($1::date+interval '1 month') AND ($2::uuid IS NULL OR r.building_id=$2) AND ($3::uuid IS NULL OR a.room_id=$3) AND ($4::uuid IS NULL OR c.id=$4) AND ($5::uuid IS NULL OR k.id=$5) AND ($6::uuid IS NULL OR a.funding_source_id=$6) AND ($7::int IS NULL OR extract(year from a.acquisition_date)=$7) AND (a.inventory_code ILIKE $8 OR a.name ILIKE $8)`;
                const data = (await q.query<{
                    cards: Record<string, string>;
                    categories: {
                        label: string;
                        value: string;
                    }[];
                    conditions: {
                        label: string;
                        value: string;
                    }[];
                    rooms: {
                        label: string;
                        value: string;
                    }[];
                    values: {
                        label: string;
                        value: string;
                    }[];
                }>(`WITH data AS (SELECT a.*,c.name category,k.name condition_name,k.code condition_code,r.name room,s.accumulated ${base}) SELECT jsonb_build_object('assets',count(*)::text,'categories',count(DISTINCT category_id)::text,'cost',coalesce(sum(acquisition_cost),0)::text,'book',coalesce(sum(acquisition_cost-accumulated),0)::text,'good',count(*) FILTER(WHERE condition_code='BAIK')::text,'lightDamage',count(*) FILTER(WHERE condition_code='RUSAK_RINGAN')::text,'heavyDamage',count(*) FILTER(WHERE condition_code='RUSAK_BERAT')::text,'missing',count(*) FILTER(WHERE condition_code='HILANG')::text,'maintenance',count(*) FILTER(WHERE lifecycle_status='maintenance')::text,'loaned',count(*) FILTER(WHERE lifecycle_status='on_loan')::text) cards,(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT category label,count(*)::text value FROM data GROUP BY category ORDER BY count(*) DESC,category LIMIT 100) v) categories,(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT condition_name label,count(*)::text value FROM data GROUP BY condition_name ORDER BY count(*) DESC LIMIT 100) v) conditions,(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT coalesce(room,'Tanpa ruangan') label,count(*)::text value FROM data GROUP BY room ORDER BY count(*) DESC LIMIT 100) v) rooms,(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT category label,sum(acquisition_cost)::text value FROM data GROUP BY category ORDER BY sum(acquisition_cost) DESC LIMIT 100) v) values FROM data`, args)).rows[0];
                Object.assign(cards, data.cards);
                charts.categories = data.categories;
                charts.conditions = data.conditions;
                charts.rooms = data.rooms;
                charts.values = data.values;
                charts.bookTrend = (await q.query<{
                    label: string;
                    value: string;
                }>(`WITH scoped AS (SELECT a.id,a.acquisition_cost,a.acquisition_date ${base}) SELECT to_char(m,'YYYY-MM') label,coalesce(sum(a.acquisition_cost-(SELECT coalesce(sum(amount),0) FROM inventory.depreciation_entries WHERE asset_id=a.id AND period<=m::date)),0)::text value FROM generate_series($1::date-interval '11 months',$1::date,interval '1 month') m LEFT JOIN scoped a ON a.acquisition_date<(m+interval '1 month') GROUP BY m ORDER BY m`, args)).rows;
                cards.opname = (await q.query<{
                    n: string;
                }>("SELECT count(*)::text n FROM inventory.asset_transactions x JOIN inventory.business_documents d ON d.id=x.id AND d.tenant_id=x.tenant_id WHERE x.kind='opname' AND d.status IN ('draft','pending','partially_approved','approved','revision_required')")).rows[0].n;
                cards.overdue = (await q.query<{
                    n: string;
                }>("SELECT count(*)::text n FROM inventory.asset_reservations r JOIN inventory.asset_loan_items i ON i.id=r.loan_item_id AND i.tenant_id=r.tenant_id JOIN inventory.asset_loans l ON l.id=i.loan_id AND l.tenant_id=i.tenant_id WHERE r.released_at IS NULL AND l.due_at<clock_timestamp()")).rows[0].n;
                charts.maintenance = (await q.query<{
                    label: string;
                    value: string;
                }>("SELECT to_char(d.business_date,'YYYY-MM') label,count(*)::text value FROM inventory.asset_transactions x JOIN inventory.business_documents d ON d.id=x.id AND d.tenant_id=x.tenant_id WHERE x.kind IN ('maintenance','maintenance_finish') AND d.status='posted' AND d.business_date>=($1::date-interval '11 months') AND d.business_date<($1::date+interval '1 month') GROUP BY 1 ORDER BY 1", [f.period])).rows;
            }
            if (p.includes('inventory.view')) {
                cards.lowStock = (await q.query<{
                    n: string;
                }>("SELECT count(*)::text n FROM inventory.inventory_items i WHERE i.status='active' AND coalesce((SELECT sum(quantity) FROM inventory.inventory_stock_balances b WHERE b.item_id=i.id),0)<i.minimum_stock")).rows[0].n;
                charts.stock = (await q.query<{
                    label: string;
                    value: string;
                }>("SELECT r.name label,sum(b.stock_value)::text value FROM inventory.inventory_stock_balances b JOIN inventory.rooms r ON r.id=b.room_id AND r.tenant_id=b.tenant_id GROUP BY r.id ORDER BY sum(b.stock_value) DESC LIMIT 100")).rows;
            }
            if (p.includes('inventory.view') && p.includes('procurement.manage')) {
                cards.procurement = (await q.query<{
                    n: string;
                }>("SELECT count(*)::text n FROM inventory.business_documents d JOIN inventory.procurements p ON p.business_document_id=d.id AND p.tenant_id=d.tenant_id WHERE d.supply_kind='order' AND d.status IN ('draft','pending','partially_approved','approved','revision_required') AND EXISTS(SELECT FROM inventory.procurement_items i WHERE i.procurement_id=p.id AND i.tenant_id=p.tenant_id AND i.received_quantity<i.quantity)")).rows[0].n;
                charts.procurement = (await q.query<{
                    label: string;
                    value: string;
                }>("SELECT to_char(d.business_date,'YYYY-MM') label,count(*)::text value FROM inventory.business_documents d WHERE d.supply_kind='order' AND d.status IN ('approved','posted') AND d.business_date>=($1::date-interval '11 months') AND d.business_date<($1::date+interval '1 month') GROUP BY 1 ORDER BY 1", [f.period])).rows;
            }
            if (p.includes('approval.access'))
                cards.pending = (await q.query<{
                    n: string;
                }>("SELECT count(*)::text n FROM inventory.approval_instances i WHERE status IN ('pending','partially_approved') AND inventory_security.approval_can_see(i.id)")).rows[0].n;
            return { cards, charts, generatedAt: new Date().toISOString(), notes: ['Aset aktif memakai lingkup filter dan akumulasi sampai akhir bulan; status/kondisi/lokasi mengikuti master terkini.', 'Operasional opname, keterlambatan, stok rendah, pengadaan berjalan dan inbox menampilkan kondisi terkini seluruh tenant sesuai izin. Grafik pengadaan/pemeliharaan memakai 12 bulan sampai bulan terpilih.', 'Grafik kelompok dibatasi 100 kelompok teratas; nilai tabel/angka rinci tersedia melalui laporan.', 'Tren buku memakai dasar perolehan terkini serta jurnal periode efektif; bukan histori lengkap master atau valuasi aset aktif masa lampau.'] };
        });
    }
    async history(t: string | undefined, page: unknown) { const n = this.parse(z.coerce.number().int().min(1).max(10000), page), x = await this.scope(t); return this.run(x, t, 'reports.view', async (q) => { const rows = (await q.query<{
        id: string;
        format: string;
        report_type: string;
        row_count: number;
        sha256: string;
        created_at: string;
        actor_id: string;
    }>('SELECT id,format,report_type,row_count,sha256,created_at,actor_id FROM inventory.report_export_events ORDER BY created_at DESC,id LIMIT 21 OFFSET $1', [(n - 1) * 20])).rows; return { rows: rows.slice(0, 20), hasMore: rows.length > 20 }; }); }
}
