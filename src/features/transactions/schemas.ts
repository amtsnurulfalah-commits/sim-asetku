import { z } from 'zod';
const id = z.string().uuid();
const nullable = id.nullable().default(null);
export const kinds = ['placement', 'movement', 'loan', 'return', 'maintenance', 'maintenance_finish', 'opname', 'disposal'] as const;
export type Kind = typeof kinds[number];
export const labels: Record<Kind, string> = { placement: 'Penempatan', movement: 'Mutasi', loan: 'Peminjaman', return: 'Pengembalian', maintenance: 'Mulai pemeliharaan', maintenance_finish: 'Selesai pemeliharaan', opname: 'Stock opname', disposal: 'Penghapusan' };
export const permission = (k: Kind) => k === 'placement' || k === 'movement' ? 'movements.create' : k === 'loan' || k === 'return' ? 'loans.create' : k === 'maintenance' || k === 'maintenance_finish' ? 'maintenance.manage' : k === 'opname' ? 'stockopname.execute' : 'disposal.create';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(x => !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x);
const time = z.string().datetime({ offset: true }).nullable().default(null);
export const payload = z.object({ kind: z.enum(kinds), date, reason: z.string().trim().min(3).max(2000), assets: z.array(id).max(50).default([]), parentId: nullable, roomId: nullable, responsibleId: nullable, conditionId: nullable, borrower: z.string().trim().max(180).default(''), startAt: time, dueAt: time, maintenanceType: z.enum(['preventive', 'corrective']).default('preventive'), assigneeId: nullable, supplierId: nullable, nextDueAt: time, completedAt: time, costTreatment: z.enum(['expense', 'capitalization_review']).default('expense'), cost: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).default('0'), scopeRoomId: nullable, scopeCategoryId: nullable }).strict().superRefine((x, c) => {
    const bad = (message: string) => c.addIssue({ code: 'custom', message });
    if (x.kind !== 'opname' && (!x.assets.length || new Set(x.assets).size !== x.assets.length))
        bad('Pilih aset yang berbeda');
    if (['return', 'maintenance_finish'].includes(x.kind) && !x.parentId)
        bad('Pilih transaksi asal');
    if (['placement', 'movement', 'return', 'maintenance_finish'].includes(x.kind) && !x.roomId)
        bad('Pilih ruangan');
    if (['return', 'maintenance_finish'].includes(x.kind) && !x.conditionId)
        bad('Pilih kondisi');
    if (x.kind === 'loan' && (!x.startAt || !x.dueAt || Date.parse(x.dueAt) <= Date.parse(x.startAt) || x.borrower.length < 3))
        bad('Tanggal atau peminjam tidak valid');
    if (x.kind === 'maintenance' && (!x.assigneeId || !x.startAt || x.nextDueAt && Date.parse(x.nextDueAt) <= Date.parse(x.startAt)))
        bad('Lengkapi jadwal dan petugas');
    if (x.kind === 'maintenance_finish' && !x.completedAt)
        bad('Tanggal selesai diperlukan');
    if (x.kind === 'opname' && !x.assigneeId)
        bad('Pilih pemeriksa');
});
export type Payload = z.infer<typeof payload>;
export const save = z.object({ id: id.nullable().default(null), version: z.string().regex(/^\d+$/).nullable().default(null), key: id, data: payload }).strict();
export const transition = z.object({ id, version: z.string().regex(/^\d+$/), action: z.enum(['submit', 'review', 'approve', 'reject', 'revision', 'cancel']), reason: z.string().trim().min(3).max(2000) }).strict();
export const observation = z.object({ id, version: z.string().regex(/^\d+$/), assetId: nullable, data: z.object({ finding: z.enum(['matched', 'not_found', 'condition_changed', 'location_changed', 'follow_up', 'unregistered']), roomId: nullable, conditionId: nullable, notes: z.string().trim().min(3).max(2000) }).strict() }).strict();
export type Ref = {
    id: string;
    name: string;
    code?: string;
};
export type Options = {
    tenantId: string;
    permissions: string[];
    mode: string;
    rooms: Ref[];
    conditions: Ref[];
    members: Ref[];
    categories: Ref[];
    suppliers: Ref[];
};
export type Doc = {
    review_mode_snapshot:string|null;
    id: string;
    document_number: string;
    kind: Kind;
    status: string;
    row_version: string;
    revision: number;
    business_date: string;
    requested_by: string;
    payload: Payload;
    parent_id: string | null;
};
export type Line = {
    id: string;
    asset_id: string;
    snapshot: {
        code: string;
        name: string;
        roomId: string | null;
        conditionId: string;
        responsibleId: string | null;
        lifecycle: string;
        version: number;
    };
    observation: {
        finding: string;
        roomId: string | null;
        conditionId: string | null;
        notes: string;
    } | null;
    checked_by: string | null;
    checked_at: string | null;
};
export type Detail = {
    unregistered: {id:string;reason:string;created_at:string}[];
    document: Doc;
    lines: Line[];
    events: {
        id: string;
        action: string;
        reason: string;
        actor_name: string;
        created_at: string;
    }[];
    files: {
        id: string;
        original_filename: string;
        sensitivity: string;
        file_size: string;
        mime_type: string;
        status: string;
    }[];
    related: {
        id: string;
        document_number: string;
        kind: Kind;
        status: string;
    }[];
};
export type AssetChoice = {
    id: string;
    name: string;
    inventory_code: string;
    lifecycle_status: string;
    room_name: string | null;
};
export type List = {
    rows: Doc[];
    page: number;
    hasMore: boolean;
};
