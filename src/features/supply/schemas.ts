import { z } from "zod";
import { assetInput } from "@/features/assets/schemas";
export const kinds = [
  "request",
  "order",
  "receipt",
  "receipt_stock",
  "issue",
  "adjustment",
] as const;
export const kindSchema = z.enum(kinds);
export const decimal = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
export const positive = decimal.refine((v) => Number(v) > 0);
export const signed = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/)
  .refine((v) => Number(v) !== 0);
const id = z.uuid(),
  opt = id.nullable().default(null),
  text = z.string().trim().min(1).max(1000);
export const item = z
  .object({
    code: z.string().regex(/^[A-Z0-9_-]{1,40}$/),
    name: z.string().trim().min(1).max(180),
    status: z.enum(["active", "archived"]),
    unitId: id,
    categoryId: id,
    minimumStock: decimal,
  })
  .strict();
export const supplier = z
  .object({
    code: z.string().regex(/^[A-Z0-9_-]{1,40}$/),
    name: z.string().trim().min(1).max(180),
    status: z.enum(["active", "archived"]),
  })
  .strict();
export const requestLine = z
  .object({
    description: text,
    unitId: id,
    quantity: positive,
    unitCost: decimal,
  })
  .strict();
export const orderLine = z
  .object({
    requestItemId: id,
    description: text,
    unitId: id,
    quantity: positive,
    unitCost: decimal,
    destination: z.enum(["inventory", "asset"]),
    itemId: opt,
    asset: assetInput.nullable().default(null),
  })
  .strict()
  .refine((x) =>
    x.destination === "inventory"
      ? !!x.itemId && !x.asset
      : !!x.asset && !x.itemId,
  );
export const receiptLine = z
  .object({
    orderItemId: id,
    quantity: positive,
    accepted: decimal,
    roomId: id,
    inspection: z.string().trim().min(3).max(1000),
  })
  .strict();
export const stockLine = z
  .object({
    itemId: id,
    roomId: id,
    quantity: signed,
    unitCost: decimal.default("0"),
  })
  .strict();
const head = {
  id: opt,
  rowVersion: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .nullable()
    .default(null),
  idempotencyKey: id,
  date: z.iso.date(),
  reason: z.string().trim().min(3).max(2000),
};
export const document = z.discriminatedUnion("kind", [
  z
    .object({
      ...head,
      kind: z.literal("request"),
      roomId: id,
      fundingId: opt,
      lines: z.array(requestLine).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...head,
      kind: z.literal("order"),
      requestId: id,
      supplierId: id,
      fundingId: opt,
      lines: z.array(orderLine).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...head,
      kind: z.literal("receipt"),
      orderId: id,
      lines: z.array(receiptLine).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...head,
      kind: z.literal("receipt_stock"),
      correctsDocumentId: opt,
      lines: z.array(stockLine).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...head,
      kind: z.literal("issue"),
      correctsDocumentId: opt,
      lines: z.array(stockLine).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...head,
      kind: z.literal("adjustment"),
      correctsDocumentId: opt,
      lines: z.array(stockLine).min(1).max(50),
    })
    .strict(),
]);
export type Kind = z.infer<typeof kindSchema>;
export type Ref = {
  id: string;
  name: string;
  code?: string;
  [k: string]: unknown;
};
export type Options = {
  tenantId: string;
  tenantName: string;
  permissions: string[];
  reviewMode: string;
  items: Ref[];
  rooms: Ref[];
  units: Ref[];
  categories: Ref[];
  funding: Ref[];
  suppliers: Ref[];
};
export type DocumentRow = {
  review_mode_snapshot:string|null;
  id: string;
  source_id: string;
  kind: Kind;
  document_number: string;
  status: string;
  business_date: string;
  requested_by: string;
  row_version: string;
  revision: number;
  total_amount: string | null;
  reason: string;
  [k: string]: unknown;
};
export type Detail = {
  related: { id: string; document_number: string; status: string }[];
  doc: DocumentRow;
  lines: Ref[];
  events: {
    action: string;
    reason: string;
    created_at: string;
    actor_id: string;
  }[];
  attachments: {
    id: string;
    original_filename: string;
    mime_type: string;
    file_size: string;
    status: string;
    sensitivity: string;
  }[];
};
export const statusText: Record<string, string> = {
  draft: "Draf",
  submitted: "Diajukan",
  pending: "Dalam review",
  partially_approved: "Disetujui sebagian",
  approved: "Disetujui",
  rejected: "Ditolak",
  revision_required: "Perlu revisi",
  cancelled: "Dibatalkan",
  posted: "Dibukukan",
};
export const kindText: Record<Kind, string> = {
  request: "Pengajuan kebutuhan",
  order: "Pengadaan",
  receipt: "Penerimaan pengadaan",
  receipt_stock: "Penerimaan langsung",
  issue: "Pengeluaran stok",
  adjustment: "Penyesuaian stok",
};
