import { z } from 'zod';
export const types = ['finance:depreciation', 'finance:depreciation_correction', 'supply:request', 'supply:order', 'supply:receipt', 'supply:receipt_stock', 'supply:issue', 'supply:adjustment', 'asset:placement', 'asset:movement', 'asset:loan', 'asset:return', 'asset:maintenance', 'asset:maintenance_finish', 'asset:opname', 'asset:disposal'] as const;
export type Type = typeof types[number];
export const labels: Record<Type, string> = { 'finance:depreciation': 'Penyusutan periodik', 'finance:depreciation_correction': 'Koreksi penyusutan', 'supply:request': 'Kebutuhan barang', 'supply:order': 'Pengadaan', 'supply:receipt': 'Penerimaan pengadaan', 'supply:receipt_stock': 'Penerimaan stok langsung', 'supply:issue': 'Pengeluaran stok', 'supply:adjustment': 'Penyesuaian / koreksi stok', 'asset:placement': 'Penempatan', 'asset:movement': 'Mutasi', 'asset:loan': 'Peminjaman', 'asset:return': 'Pengembalian', 'asset:maintenance': 'Mulai pemeliharaan', 'asset:maintenance_finish': 'Selesai pemeliharaan', 'asset:opname': 'Hasil stock opname', 'asset:disposal': 'Penghapusan' };
export const requiredPermission = (t: Type) => t.startsWith('finance:') ? 'depreciation.approve' : t === 'supply:request' || t === 'supply:order' ? 'procurement.approve' : t === 'supply:receipt' || t === 'supply:receipt_stock' ? 'receipts.approve' : t === 'supply:issue' ? 'inventory.issue.approve' : t === 'supply:adjustment' ? 'inventory.adjust.approve' : t === 'asset:placement' || t === 'asset:movement' ? 'movements.approve' : t === 'asset:loan' || t === 'asset:return' ? 'loans.approve' : t === 'asset:maintenance' || t === 'asset:maintenance_finish' ? 'maintenance.approve' : t === 'asset:opname' ? 'stockopname.approve' : 'disposal.approve';
export const id = z.string().uuid();
export const version = z.string().regex(/^[1-9]\d{0,17}$/);
export const reason = z.string().trim().min(3).max(2000);
export const amount = z.string().regex(/^\d{1,18}(\.\d{1,2})?$/);
const cents = (v: string) => { const [a, b = ''] = v.split('.'); return BigInt(a) * 100n + BigInt(b.padEnd(2, '0')); };
export const config = z.object({ code: z.string().regex(/^[A-Z0-9_-]{1,64}$/), name: z.string().trim().min(1).max(300), type: z.enum(types), enabled: z.boolean(), minAmount: amount, maxAmount: amount.nullable(), scope: z.enum(['all', 'standard', 'correction']), allowSelf: z.boolean(), allowReject: z.boolean(), allowRevision: z.boolean(), steps: z.array(id).min(1).max(10), reason }).strict().refine(x => x.maxAmount === null || cents(x.maxAmount) > cents(x.minAmount), 'Batas nominal tidak valid').refine(x => x.scope !== 'correction' || (x.type === 'supply:adjustment' || x.type === 'finance:depreciation_correction'), 'Lingkup koreksi untuk penyesuaian stok atau koreksi penyusutan');
export type Config = z.infer<typeof config>;
export const publish = z.object({ id: id.nullable().default(null), version: version.nullable().default(null), key: id, data: config }).strict();
export const decision = z.object({ instanceId: id, version, level: z.number().int().min(1).max(10), decision: z.enum(['approved', 'rejected', 'revision_required']), reason, key: id }).strict();
export const documentAction = z.object({ documentId: id, version, reason }).strict();
export const delegate = z.object({ id: id.nullable().default(null), version: version.nullable().default(null), fromId: id.nullable().default(null), toId: id.nullable().default(null), workflowId: id.nullable().default(null), startAt: z.string().datetime({ offset: true }).nullable().default(null), endAt: z.string().datetime({ offset: true }).nullable().default(null), reason }).strict().superRefine((x, c) => { if (!x.id && (!x.fromId || !x.toId || !x.workflowId || !x.startAt || !x.endAt || Date.parse(x.endAt) <= Date.parse(x.startAt) || x.fromId === x.toId))
    c.addIssue({ code: 'custom', message: 'Periksa delegasi' }); if (x.id && !x.version)
    c.addIssue({ code: 'custom', message: 'Versi delegasi diperlukan' }); });
export type Member = {
    id: string;
    name: string;
    permissions: string[];
};
export type Options = {
    permissions: string[];
    members: Member[];
    canManage: boolean;
};
export type Workflow = {
    id: string;
    code: string;
    name: string;
    transaction_type: string;
    status: string;
    row_version: string;
    version: number | null;
    activation_conditions: {
        minAmount: string;
        maxAmount: string | null;
        scope: 'all' | 'standard' | 'correction';
        reject: boolean;
        revision: boolean;
    } | null;
    allow_self_approval: boolean | null;
    steps: {
        level: number;
        approverId: string;
        name: string;
        permission: string;
    }[];
};
export type InstanceRow = {
    id: string;
    document_id: string;
    document_number: string;
    document_type: Type;
    document_revision: number;
    status: string;
    current_level: number;
    row_version: string;
    workflow_name: string;
    created_at: string;
    can_decide: boolean;
};
export type Step = {
    id: string;
    level: number;
    approverId: string;
    name: string;
    permission: string;
    status: string;
};
export type Summary = {
    documentNumber: string;
    date: string;
    reason: string;
    borrower?: string;
    startAt?: string;
    dueAt?: string;
    completedAt?: string;
    targetRoom?: string;
    targetCondition?: string;
    responsible?: string;
    costTreatment?: string;
    lines: Record<string, string | null>[];
    unregistered: string[];
};
export type Detail = {
    id: string;
    rowVersion: string;
    documentId: string;
    documentVersion: string;
    documentNumber: string;
    type: Type;
    documentStatus: string;
    currentRevision: number;
    revision: number;
    status: string;
    currentLevel: number;
    requestedBy: string;
    requestedName: string;
    workflow: {
        workflowId: string;
        code: string;
        name: string;
        type: Type;
        version: number;
        allowSelf: boolean;
        rules: {
            reject: boolean;
            revision: boolean;
            minAmount: string;
            maxAmount: string | null;
            scope: string;
        };
    };
    summary: Summary;
    amount: string;
    canDecide: boolean;
    isOwner: boolean;
    steps: Step[];
    actions: {
        id: string;
        decision: string;
        reason: string;
        created_at: string;
        level: number;
        actor_name: string;
    }[];
    events: {
        id: string;
        action: string;
        reason: string;
        created_at: string;
        actor_name: string;
    }[];
    files: {
        id: string;
        name: string;
        sensitivity: string;
    }[];
};
export type Delegation = {
    workflow_name: string;
    id: string;
    row_version: string;
    from_membership_id: string;
    to_membership_id: string;
    workflow_id: string;
    starts_at: string;
    ends_at: string;
    reason: string;
    revoked_at: string | null;
};
