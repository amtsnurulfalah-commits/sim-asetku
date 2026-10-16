import { z } from 'zod';
export const kinds = ['assets', 'kib', 'kir', 'transactions', 'stock', 'stock_usage', 'depreciation', 'minutes'] as const;
export const labels: Record<typeof kinds[number], string> = { assets: 'Daftar aset', kib: 'Kartu Inventaris Barang (KIB)', kir: 'Kartu Inventaris Ruangan (KIR)', transactions: 'Laporan transaksi', stock: 'Saldo persediaan', stock_usage: 'Penggunaan persediaan', depreciation: 'Penyusutan dan nilai buku', minutes: 'Berita acara' };
const uuid = z.string().uuid().nullable().default(null), month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/).refine(v => v >= '1900-01-01');
export const filters = z.object({ kind: z.enum(kinds).default('assets'), period: month, from: z.iso.date().nullable().default(null), to: z.iso.date().nullable().default(null), buildingId: uuid, roomId: uuid, categoryId: uuid, conditionId: uuid, fundingId: uuid, year: z.coerce.number().int().min(1900).max(9999).nullable().default(null), query: z.string().trim().max(180).default(''), status: z.enum(['all', 'available', 'reserved', 'on_loan', 'maintenance', 'draft', 'disposed', 'archived']).default('all'), transactionType: z.enum(['all', 'supply:request', 'supply:order', 'supply:receipt', 'supply:receipt_stock', 'supply:issue', 'supply:adjustment', 'asset:placement', 'asset:movement', 'asset:loan', 'asset:return', 'asset:maintenance', 'asset:maintenance_finish', 'asset:opname', 'asset:disposal', 'finance:depreciation', 'finance:depreciation_correction']).default('all'), documentStatus: z.enum(['all', 'draft', 'pending', 'partially_approved', 'approved', 'posted', 'rejected', 'revision_required', 'cancelled']).default('all'), group: z.string().max(24).default('all'), documentId: uuid, postedBefore: z.string().datetime({ offset: true }).nullable().default(null) }).strict().superRefine((v, c) => { if (v.from && v.to && v.from > v.to)
    c.addIssue({ code: 'custom', message: 'Rentang tanggal terbalik' }); if (v.kind === 'kir' && !v.roomId)
    c.addIssue({ code: 'custom', message: 'Pilih ruangan untuk KIR' }); if (v.kind === 'minutes' && !v.documentId)
    c.addIssue({ code: 'custom', message: 'Pilih dokumen sumber' }); });
export type Filters = z.infer<typeof filters>;
export const columnLabels = { code: 'Kode inventaris', name: 'Nama aset', category: 'Kategori', kind: 'Kelompok aset', building: 'Gedung', room: 'Ruangan', condition: 'Kondisi', date: 'Tanggal perolehan', year: 'Tahun', funding: 'Sumber dana', cost: 'Nilai perolehan', residual: 'Residu', accumulated: 'Akumulasi', book: 'Nilai buku', area: 'Luas (m²)', brand: 'Merek', model: 'Model', serial: 'Nomor seri', notes: 'Keterangan' };
export const columns = Object.keys(columnLabels) as [
    keyof typeof columnLabels,
    ...(keyof typeof columnLabels)[]
];
const group = z.object({ code: z.string().regex(/^[A-Z0-9_-]{1,24}$/), name: z.string().trim().min(1).max(100), kinds: z.array(z.enum(['land', 'building', 'vehicle', 'equipment', 'collection', 'other'])).min(1).max(6) }).strict();
export const configuration = z.object({ letterhead: z.string().trim().max(500), footer: z.string().trim().max(500), signers: z.array(z.object({ role: z.string().trim().min(1).max(80), name: z.string().trim().max(120) }).strict()).min(1).max(3), logoFileId: uuid, columnTitles: z.record(z.string(), z.string().trim().min(1).max(80)).default({}).refine(x => Object.keys(x).every(k => columns.includes(k as typeof columns[number])), 'Judul kolom tidak dikenal'), assetColumns: z.array(z.enum(columns)).min(2).max(8), kibGroups: z.array(group).min(1).max(6) }).strict().superRefine((x, c) => { if (new Set(x.assetColumns).size !== x.assetColumns.length || new Set(x.kibGroups.map(g => g.code)).size !== x.kibGroups.length || new Set(x.kibGroups.flatMap(g => g.kinds)).size !== 6 || x.kibGroups.flatMap(g => g.kinds).length !== 6)
    c.addIssue({ code: 'custom', message: 'Kolom unik dan keenam jenis KIB harus dipetakan tepat sekali' }); });
export type Configuration = z.infer<typeof configuration>;
export const defaultConfig: Configuration = { letterhead: '', footer: 'Dokumen dari aplikasi inventaris. Tanda tangan dilengkapi oleh pihak berwenang.', logoFileId: null, columnTitles: {}, signers: [{ role: 'Mengetahui / Kepala lembaga', name: '' }, { role: 'Petugas inventaris', name: '' }], assetColumns: ['code', 'name', 'category', 'room', 'condition', 'cost', 'accumulated', 'book'], kibGroups: [{ code: 'A', name: 'Tanah', kinds: ['land'] }, { code: 'B', name: 'Peralatan dan mesin', kinds: ['equipment', 'vehicle'] }, { code: 'C', name: 'Gedung dan bangunan', kinds: ['building'] }, { code: 'D', name: 'Koleksi dan aset lainnya', kinds: ['collection', 'other'] }] };
export type Ref = {
    id: string;
    code: string;
    name: string;
};
export type Options = {
    permissions: string[];
    rooms: Ref[];
    buildings: Ref[];
    categories: Ref[];
    conditions: Ref[];
    funding: Ref[];
    logos: (Ref & {
        size: string;
    })[];
    config: Configuration;
    version: string | null;
    templateVersion: number;
    tenant: {
        name: string;
        code: string;
        timezone: string;
        profile: Record<string, string>;
    };
};
export type Row = Record<string, string | null>;
export type Table = {
    title: string;
    columns: {
        key: string;
        label: string;
        money?: boolean;
    }[];
    rows: Row[];
    count: number;
    totals: Record<string, string>;
    notes: string[];
    number: string;
    status?: string;
    approval?: string[];
    meta: Options;
    generatedAt: string;
    filters: Filters;
};
