import { z } from "zod";
export const kinds = [
  "categories",
  "subcategories",
  "units",
  "conditions",
  "funding",
  "buildings",
  "rooms",
  "policies",
] as const;
export const kindSchema = z.enum(kinds);
const uuid = z.uuid(),
  optionalId = uuid.nullable().default(null);
export const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const area = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/)
  .refine((x) => Number(x) > 0);
const date = z.iso.date(),
  optionalDate = date.nullable().default(null);
const short = z.string().trim().max(180).default("");
const text = z.string().trim().max(4000).default("");
export const masterBase = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(180),
  status: z.enum(["active", "archived"]).default("active"),
});
export const masterSchemas = {
  categories: masterBase
    .extend({
      asset_kind: z.enum([
        "land",
        "building",
        "vehicle",
        "equipment",
        "collection",
        "inventory",
        "other",
      ]),
      depreciable: z.boolean(),
    })
    .strict(),
  subcategories: masterBase.extend({ category_id: uuid }).strict(),
  units: masterBase.strict(),
  conditions: masterBase
    .extend({ loan_allowed: z.boolean().default(false) })
    .strict(),
  funding: masterBase.strict(),
  buildings: masterBase.extend({ address: text }).strict(),
  rooms: masterBase
    .extend({
      building_id: uuid,
      floor_number: z.number().int().min(-10).max(200),
      responsible_membership_id: optionalId,
    })
    .strict(),
  policies: masterBase
    .extend({
      method: z.literal("straight_line"),
      version: z.number().int().min(1).max(10000),
      useful_life_months: z.number().int().min(1).max(1200),
      proration: z.enum(["full_month", "next_month", "daily"]),
    })
    .strict(),
};
const land = z
  .object({
    area_sqm: area,
    address: z.string().trim().min(1).max(2000),
    ownership_status: z.string().trim().min(1).max(120),
    certificate_number: short,
    rights_type: short,
    land_use: short,
  })
  .strict();
const building = z
  .object({
    location_building_id: optionalId,
    building_type: short,
    construction_year: z
      .number()
      .int()
      .min(1000)
      .max(9999)
      .nullable()
      .default(null),
    area_sqm: area.nullable().default(null),
    floor_count: z.number().int().min(1).max(200).nullable().default(null),
    construction_status: z.enum(["in_progress", "complete"]),
    ownership_status: short,
  })
  .strict();
const vehicle = z
  .object({
    vehicle_type: z.string().trim().min(1).max(120),
    manufacturing_year: z
      .number()
      .int()
      .min(1900)
      .max(9999)
      .nullable()
      .default(null),
    registration_number: short,
    chassis_number: short,
    engine_number: short,
    ownership_document_number: short,
    registration_expiry: optionalDate,
    next_service_date: optionalDate,
  })
  .strict();
export const assetInput = z
  .object({
    name: z.string().trim().min(1).max(180),
    category_id: uuid,
    subcategory_id: optionalId,
    unit_id: uuid,
    funding_source_id: optionalId,
    room_id: optionalId,
    responsible_membership_id: optionalId,
    condition_id: uuid,
    lifecycle_status: z.enum(["draft", "available"]),
    brand: short,
    model: short,
    serial_number: short,
    specifications: z.string().max(6000).default(""),
    acquisition_date: date,
    in_service_date: optionalDate,
    acquisition_method: z.string().trim().min(1).max(120),
    acquisition_cost: amount,
    residual_value: amount,
    useful_life_months: z
      .number()
      .int()
      .min(1)
      .max(1200)
      .nullable()
      .default(null),
    depreciation_policy_id: optionalId,
    notes: text,
    detail: z.discriminatedUnion("type", [
      z.object({ type: z.literal("land"), data: land }).strict(),
      z.object({ type: z.literal("building"), data: building }).strict(),
      z.object({ type: z.literal("vehicle"), data: vehicle }).strict(),
      z.object({ type: z.literal("general") }).strict(),
    ]),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict(); // Exact monetary comparisons are enforced by PostgreSQL numeric.

export const createInput = z
  .object({
    asset: assetInput,
    count: z.number().int().min(1).max(50),
    idempotencyKey: uuid,
  })
  .strict()
  .refine((x) => x.count === 1 || !x.asset.serial_number, {
    message: "Nomor seri harus diisi per unit.",
  });
export const updateInput = z
  .object({
    id: uuid,
    rowVersion: z.string().regex(/^[1-9]\d{0,17}$/),
    asset: assetInput,
  })
  .strict();
export const listInput = z
  .object({
    query: z.string().trim().max(120).default(""),
    category: optionalId,
    room: optionalId,
    condition: optionalId,
    status: z
      .enum([
        "all",
        "draft",
        "available",
        "reserved",
        "on_loan",
        "maintenance",
        "disposed",
        "archived",
      ])
      .default("all"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export const configuration = z
  .object({
    format: z
      .string()
      .min(1)
      .max(160)
      .refine(
        (x) =>
          x.includes("{number}") &&
          !x
            .replace(/\{(tenant|category|year|number)\}/g, "")
            .match(/[^A-Za-z0-9_./-]/),
      ),
    width: z.number().min(50).max(100),
    height: z.number().min(30).max(60),
  })
  .strict();
export type AssetInput = z.infer<typeof assetInput>;
export type MasterKind = z.infer<typeof kindSchema>;
export type Ref = {
  id: string;
  code: string;
  name: string;
  status: string;
  row_version: string;
  [key: string]: unknown;
};
export type Options = {
  tenantId: string;
  tenantName: string;
  permissions: string[];
  refs: Record<MasterKind, Ref[]>;
  members: { id: string; name: string }[];
  settings: { format: string; width: number; height: number };
};
export type AssetRow = {
  id: string;
  public_id: string;
  inventory_code: string;
  name: string;
  category_name: string;
  asset_kind: string;
  room_name: string | null;
  condition_name: string;
  lifecycle_status: string;
  row_version: string;
  acquisition_cost: string;
  book_value: string;
  accumulated_depreciation: string;
  [key: string]: unknown;
};
export type AssetDetail = {
  asset: AssetRow;
  input: AssetInput;
  detail: Record<string, unknown>;
  canSeeSensitive: boolean;
  history: Record<string, unknown[]>;
  attachments: {
    id: string;
    original_filename: string;
    mime_type: string;
    file_size: string;
    sensitivity: string;
    status: string;
  }[];
};
