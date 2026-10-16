import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthService, tokenDigest } from "@/lib/session/service";
import type { Snapshot } from "@/lib/session/repository";
import type { Sql } from "@/lib/db/types";
import { AppError } from "@/lib/security/errors";
import { mapAdminError } from "@/features/admin/service";
import * as S from "./schemas";
const tables: Record<S.MasterKind, string> = {
  categories: "asset_categories",
  subcategories: "asset_subcategories",
  units: "units",
  conditions: "asset_conditions",
  funding: "funding_sources",
  buildings: "buildings",
  rooms: "rooms",
  policies: "depreciation_policies",
};
const SELECT = `SELECT a.*,a.row_version::text,a.acquisition_cost::text,a.residual_value::text,a.acquisition_date::text,a.in_service_date::text,c.name category_name,c.asset_kind,c.depreciable,bt.name batch_name,bt.asset_count batch_count,r.name room_name,b.name building_name,r.floor_number,co.name condition_name,u.name unit_name,fs.name funding_name,
coalesce(d.total,0)::text accumulated_depreciation,(a.acquisition_cost-coalesce(d.total,0))::text book_value FROM inventory.assets a JOIN inventory.asset_categories c ON c.tenant_id=a.tenant_id AND c.id=a.category_id JOIN inventory.asset_conditions co ON co.tenant_id=a.tenant_id AND co.id=a.condition_id JOIN inventory.units u ON u.tenant_id=a.tenant_id AND u.id=a.unit_id LEFT JOIN inventory.asset_batches bt ON bt.tenant_id=a.tenant_id AND bt.id=a.batch_id LEFT JOIN inventory.rooms r ON r.tenant_id=a.tenant_id AND r.id=a.room_id LEFT JOIN inventory.buildings b ON b.tenant_id=r.tenant_id AND b.id=r.building_id LEFT JOIN inventory.funding_sources fs ON fs.tenant_id=a.tenant_id AND fs.id=a.funding_source_id LEFT JOIN LATERAL (SELECT sum(amount) total FROM inventory.depreciation_entries WHERE tenant_id=a.tenant_id AND asset_id=a.id) d ON true`;
export function assetError(
  code: string,
  status: number,
  message: string,
): never {
  throw new AppError(code, status, message);
}
export function mapAssetError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const code = (e as { code?: string })?.code,
    message = (e as { message?: string })?.message ?? "";
  if (code === "23514") {
    const hint = message.includes("movement workflow")
      ? "Perubahan lokasi aset aktif harus melalui alur mutasi."
      : message.includes("Posted accounting")
        ? "Nilai dan kebijakan aset yang sudah dijurnal harus melalui koreksi akuntansi."
        : message.includes("Idempotency")
          ? "Kunci operasi telah dipakai dengan data berbeda. Tutup formulir lalu mulai pencatatan baru."
          : message.includes("Used depreciation")
            ? "Kebijakan yang sudah dipakai tidak dapat diubah secara finansial. Buat versi kebijakan baru."
            : "Data aset belum memenuhi aturan. Periksa referensi aktif, detail jenis, tanggal, nilai, dan status transaksi.";
    return new AppError("ASSET_RULE_DENIED", 409, hint);
  }
  if (code === "23505")
    return new AppError(
      "DUPLICATE",
      409,
      "Kode master atau kode inventaris sudah digunakan.",
    );
  if (code === "23503")
    return new AppError(
      "REFERENCE_CONFLICT",
      409,
      "Referensi tidak sesuai lembaga atau masih dipakai oleh data lain.",
    );
  if (code === "23502")
    return new AppError(
      "VALIDATION_ERROR",
      400,
      "Lengkapi isian yang diwajibkan.",
    );
  if (code === "40001")
    return new AppError(
      "VERSION_CONFLICT",
      409,
      "Data telah berubah. Muat ulang sebelum menyimpan kembali.",
    );
  return mapAdminError(e);
}
export class AssetService {
  constructor(public auth: AuthService) {}
  private parse<T extends z.ZodType>(schema: T, b: unknown): z.infer<T> {
    const x = schema.safeParse(b);
    if (!x.success)
      assetError(
        "VALIDATION_ERROR",
        400,
        "Periksa isian, tanggal, nilai uang, dan referensi formulir.",
      );
    return x.data;
  }
  private scope(token: string | undefined, permission = "assets.view") {
    return this.auth.session(token, { permission, sensitive: true });
  }
  private run<T>(
    x: Snapshot,
    t: string | undefined,
    permission: string,
    fn: (q: Sql) => Promise<T>,
  ) {
    return this.auth.repo.db.run(
      "runtime",
      {
        tenantId: x.session.active_tenant_id!,
        userId: x.user.id,
        membershipId: x.session.active_membership_id!,
        sessionDigest: tokenDigest(t!),
        correlationId: randomUUID(),
      },
      async (q) => {
        await q.query("SELECT inventory_security.assert_asset_actor($1)", [
          permission,
        ]);
        return fn(q);
      },
    );
  }
  async options(token: string | undefined, master = false): Promise<S.Options> {
    const permission = master ? "settings.manage" : "assets.view",
      x = await this.scope(token, permission),
      permissions = await this.auth.repo.permissions(x);
    return this.run(x, token, permission, async (q) => {
      const refs = {} as Record<S.MasterKind, S.Ref[]>;
      for (const kind of S.kinds)
        refs[kind] = (
          await q.query<S.Ref>(
            `SELECT *,row_version::text FROM inventory.${tables[kind]} ORDER BY status,code LIMIT 1000`,
          )
        ).rows;
      const s = (
        await q.query<{
          inventory_code_format: string;
          label_width_mm: string;
          label_height_mm: string;
        }>(
          "SELECT inventory_code_format,label_width_mm,label_height_mm FROM inventory.tenant_settings",
        )
      ).rows[0];
      const members = (
        await q.query<{ id: string; name: string }>(
          "SELECT * FROM inventory_security.asset_member_options($1)",
          [permission],
        )
      ).rows;
      return {
        tenantId: x.session.active_tenant_id!,
        tenantName: x.memberships.find(
          (m) => m.tenant_id === x.session.active_tenant_id,
        )!.tenant_name,
        permissions,
        refs,
        members,
        settings: {
          format: s.inventory_code_format,
          width: Number(s.label_width_mm),
          height: Number(s.label_height_mm),
        },
      };
    });
  }
  async masters(token: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            kind: S.kindSchema,
            query: z.string().trim().max(120).default(""),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        input,
      ),
      x = await this.scope(token, "settings.manage");
    return this.run(x, token, "settings.manage", async (q) => {
      const table = tables[b.kind],
        filter =
          "WHERE ($1='' OR position(lower($1) in lower(code||' '||name))>0)";
      const items = (
          await q.query<S.Ref>(
            `SELECT *,row_version::text FROM inventory.${table} ${filter} ORDER BY code,id LIMIT 20 OFFSET $2`,
            [b.query, (b.page - 1) * 20],
          )
        ).rows,
        total = (
          await q.query<{ n: string }>(
            `SELECT count(*)::text n FROM inventory.${table} ${filter}`,
            [b.query],
          )
        ).rows[0].n;
      return { items, total: Number(total), page: b.page };
    });
  }
  async saveMaster(token: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            kind: S.kindSchema,
            id: z.uuid().nullable(),
            rowVersion: z
              .string()
              .regex(/^[1-9]\d{0,17}$/)
              .nullable(),
            data: z.unknown(),
          })
          .strict(),
        input,
      ),
      data = this.parse(S.masterSchemas[b.kind], b.data),
      x = await this.scope(token, "settings.manage");
    return this.run(
      x,
      token,
      "settings.manage",
      async (q) =>
        (
          await q.query(
            "SELECT inventory_security.save_asset_master($1,$2,$3,$4) id",
            [b.kind, b.id, b.rowVersion, JSON.stringify(data)],
          )
        ).rows[0],
    );
  }
  async configure(token: string | undefined, input: unknown) {
    const b = this.parse(S.configuration, input),
      x = await this.scope(token, "settings.manage");
    await this.run(x, token, "settings.manage", (q) =>
      q.query("SELECT inventory_security.asset_configuration($1,$2,$3)", [
        b.format,
        b.width,
        b.height,
      ]),
    );
    return { saved: true };
  }
  async list(token: string | undefined, input: unknown) {
    const b = this.parse(S.listInput, input),
      x = await this.scope(token);
    return this.run(x, token, "assets.view", async (q) => {
      const where =
          " WHERE ($1='' OR position(lower($1) in lower(a.name||' '||a.inventory_code||' '||coalesce(a.serial_number,'')))>0) AND ($2::uuid IS NULL OR a.category_id=$2) AND ($3::uuid IS NULL OR a.room_id=$3) AND ($4::uuid IS NULL OR a.condition_id=$4) AND ($5='all' OR a.lifecycle_status=$5)",
        args = [b.query, b.category, b.room, b.condition, b.status];
      const items = (
        await q.query<S.AssetRow>(
          SELECT +
            where +
            " ORDER BY a.created_at DESC,a.id LIMIT 20 OFFSET $6",
          [...args, (b.page - 1) * 20],
        )
      ).rows;
      const total = (
        await q.query<{ n: string }>(
          "SELECT count(*)::text n FROM inventory.assets a" + where,
          args,
        )
      ).rows[0].n;
      return { items, total: Number(total), page: b.page };
    });
  }
  private async protectSensitive(
    x: Snapshot,
    t: string | undefined,
    b: S.AssetInput,
    id?: string,
  ) {
    const allowed = (await this.auth.repo.permissions(x)).includes(
      "files.sensitive.download",
    );
    if (allowed) return b;
    if (b.detail.type !== "land" && b.detail.type !== "vehicle") return b;
    const keys =
      b.detail.type === "land"
        ? ["certificate_number"]
        : ["chassis_number", "engine_number", "ownership_document_number"];
    const raw = b.detail.data as Record<string, unknown>;
    if (keys.some((k) => raw[k]))
      assetError(
        "SENSITIVE_DENIED",
        403,
        "Anda tidak memiliki izin mengubah data kepemilikan sensitif.",
      );
    if (id) {
      const table =
        b.detail.type === "land"
          ? "asset_land_details"
          : "asset_vehicle_details";
      const existing = await this.run(x, t, "assets.update", (q) =>
        q.query<Record<string, unknown>>(
          `SELECT ${keys.join(",")} FROM inventory.${table} WHERE asset_id=$1`,
          [id],
        ),
      );
      if (existing.rows[0])
        for (const k of keys) raw[k] = existing.rows[0][k] ?? "";
    }
    return b;
  }
  private sqlData(b: S.AssetInput) {
    return { ...b, specifications: { description: b.specifications } };
  }
  async create(token: string | undefined, input: unknown) {
    const b = this.parse(S.createInput, input),
      x = await this.scope(token, "assets.create"),
      asset = await this.protectSensitive(x, token, b.asset);
    return this.run(
      x,
      token,
      "assets.create",
      async (q) =>
        (
          await q.query<{
            result: { ids: string[]; batchId: string; reused: boolean };
          }>(
            "SELECT inventory_security.save_asset(NULL,NULL,$1,$2,$3) result",
            [JSON.stringify(this.sqlData(asset)), b.count, b.idempotencyKey],
          )
        ).rows[0].result,
    );
  }
  async update(token: string | undefined, input: unknown) {
    const b = this.parse(S.updateInput, input),
      x = await this.scope(token, "assets.update"),
      asset = await this.protectSensitive(x, token, b.asset, b.id);
    return this.run(
      x,
      token,
      "assets.update",
      async (q) =>
        (
          await q.query(
            "SELECT inventory_security.save_asset($1,$2,$3,1,NULL) result",
            [b.id, b.rowVersion, JSON.stringify(this.sqlData(asset))],
          )
        ).rows[0],
    );
  }
  async archive(token: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            id: z.uuid(),
            rowVersion: z.string().regex(/^[1-9]\d{0,17}$/),
            reason: z.string().trim().min(3).max(1000),
          })
          .strict(),
        input,
      ),
      x = await this.scope(token, "assets.delete");
    await this.run(x, token, "assets.delete", (q) =>
      q.query("SELECT inventory_security.archive_asset($1,$2,$3)", [
        b.id,
        b.rowVersion,
        b.reason,
      ]),
    );
    return { archived: true };
  }
  async detail(
    token: string | undefined,
    key: string,
    publicId = false,
  ): Promise<S.AssetDetail> {
    this.parse(z.uuid(), key);
    const x = await this.scope(token),
      permissions = await this.auth.repo.permissions(x),
      canSeeSensitive = permissions.includes("files.sensitive.download");
    return this.run(x, token, "assets.view", async (q) => {
      const a = (
        await q.query<S.AssetRow>(
          SELECT + ` WHERE a.${publicId ? "public_id" : "id"}=$1`,
          [key],
        )
      ).rows[0];
      if (!a)
        assetError(
          "NOT_FOUND",
          404,
          "Aset tidak ditemukan atau berada di lembaga lain. Pilih lembaga yang sesuai.",
        );
      let detail: Record<string, unknown> = {};
      const kind = a.asset_kind,
        table =
          kind === "land"
            ? "asset_land_details"
            : kind === "building"
              ? "asset_building_details"
              : kind === "vehicle"
                ? "asset_vehicle_details"
                : null;
      if (table) {
        detail =
          (
            await q.query<Record<string, unknown>>(
              `SELECT *,row_version::text${kind === "vehicle" ? ",registration_expiry::text,next_service_date::text" : ""} FROM inventory.${table} WHERE asset_id=$1`,
              [a.id],
            )
          ).rows[0] ?? {};
        if (!canSeeSensitive)
          for (const k of [
            "certificate_number",
            "chassis_number",
            "engine_number",
            "ownership_document_number",
          ])
            delete detail[k];
      }
      const input: Record<string, unknown> = {};
      const keys = [
        "name",
        "category_id",
        "subcategory_id",
        "unit_id",
        "funding_source_id",
        "room_id",
        "responsible_membership_id",
        "condition_id",
        "lifecycle_status",
        "brand",
        "model",
        "serial_number",
        "acquisition_date",
        "in_service_date",
        "acquisition_method",
        "acquisition_cost",
        "residual_value",
        "useful_life_months",
        "depreciation_policy_id",
        "notes",
      ];
      for (const k of keys) input[k] = a[k];
      for (const k of ["brand", "model", "serial_number", "notes"])
        input[k] ??= "";
      input.specifications =
        (a.specifications as { description?: string })?.description ?? "";
      input.reason = "Pembaruan data aset";
      const dto = { ...detail };
      for (const k of [
        "id",
        "tenant_id",
        "asset_id",
        "row_version",
        "created_at",
        "updated_at",
      ])
        delete dto[k];
      for (const k of [
        "certificate_number",
        "rights_type",
        "land_use",
        "chassis_number",
        "engine_number",
        "ownership_document_number",
        "registration_number",
        "ownership_status",
        "building_type",
      ])
        if (k in dto && dto[k] === null) dto[k] = "";
      input.detail = table ? { type: kind, data: dto } : { type: "general" };
      const history: Record<string, unknown[]> = {};
      for (const [name, sql] of Object.entries({
        lokasi:
          "SELECT h.created_at,h.reason,f.name from_room,t.name to_room FROM inventory.asset_location_history h LEFT JOIN inventory.rooms f ON f.tenant_id=h.tenant_id AND f.id=h.from_room_id LEFT JOIN inventory.rooms t ON t.tenant_id=h.tenant_id AND t.id=h.to_room_id WHERE h.asset_id=$1 ORDER BY h.created_at DESC LIMIT 50",
        kondisi:
          "SELECT h.created_at,h.reason,f.name from_condition,t.name to_condition FROM inventory.asset_condition_history h LEFT JOIN inventory.asset_conditions f ON f.tenant_id=h.tenant_id AND f.id=h.from_condition_id LEFT JOIN inventory.asset_conditions t ON t.tenant_id=h.tenant_id AND t.id=h.to_condition_id WHERE h.asset_id=$1 ORDER BY h.created_at DESC LIMIT 50",
        pemeliharaan:
          "SELECT id,document_number,status,created_at FROM inventory.maintenance_requests WHERE asset_id=$1 ORDER BY created_at DESC LIMIT 50",
        perbaikan:
          "SELECT r.started_at,r.completed_at,r.notes,m.document_number,c.amount::text,c.treatment,c.description FROM inventory.maintenance_records r JOIN inventory.maintenance_requests m ON m.tenant_id=r.tenant_id AND m.id=r.request_id LEFT JOIN inventory.maintenance_costs c ON c.tenant_id=r.tenant_id AND c.record_id=r.id WHERE m.asset_id=$1 ORDER BY r.started_at DESC LIMIT 50",
        peminjaman:
          "SELECT l.document_number,l.status,l.due_at FROM inventory.asset_loan_items i JOIN inventory.asset_loans l ON l.tenant_id=i.tenant_id AND l.id=i.loan_id WHERE i.asset_id=$1 ORDER BY l.created_at DESC LIMIT 50",
        penyusutan:
          "SELECT period,amount::text,book_value_after::text FROM inventory.depreciation_entries WHERE asset_id=$1 ORDER BY period DESC LIMIT 50",
        audit:
          "SELECT created_at,action,details FROM inventory.tenant_audit_logs WHERE resource_type='assets' AND resource_id=$1 ORDER BY created_at DESC LIMIT 50",
      }))
        history[name] = (await q.query(sql, [a.id])).rows;
      const attachments = permissions.includes("files.download")
        ? (
            await q.query<S.AssetDetail["attachments"][number]>(
              "SELECT f.id,f.original_filename,f.mime_type,f.file_size::text,f.status,f.sensitivity FROM inventory.asset_attachments l JOIN inventory.file_attachments f ON f.tenant_id=l.tenant_id AND f.id=l.file_id WHERE l.asset_id=$1 AND ($2 OR f.sensitivity='normal') ORDER BY f.created_at DESC LIMIT 100",
              [a.id, canSeeSensitive],
            )
          ).rows
        : [];
      return {
        asset: a,
        input: input as S.AssetInput,
        detail,
        canSeeSensitive,
        history,
        attachments,
      };
    });
  }
  async link(token: string | undefined, input: unknown) {
    const b = this.parse(
        z.object({ assetId: z.uuid(), fileId: z.uuid() }).strict(),
        input,
      ),
      x = await this.scope(token, "assets.update");
    await this.auth.session(token, {
      permission: "files.upload",
      sensitive: true,
    });
    return this.run(
      x,
      token,
      "assets.update",
      async (q) =>
        (
          await q.query("SELECT inventory_security.link_asset_file($1,$2) id", [
            b.assetId,
            b.fileId,
          ])
        ).rows[0],
    );
  }
  async files(token: string | undefined) {
    const x = await this.scope(token, "files.download"),
      sensitive = (await this.auth.repo.permissions(x)).includes(
        "files.sensitive.download",
      );
    return this.run(
      x,
      token,
      "files.download",
      async (q) =>
        (
          await q.query(
            "SELECT id,original_filename,mime_type,file_size::text FROM inventory.file_attachments WHERE status='ready' AND ($1 OR sensitivity='normal') ORDER BY created_at DESC LIMIT 100",
            [sensitive],
          )
        ).rows,
    );
  }
  async resolveCode(token: string | undefined, code: string) {
    const x = await this.scope(token);
    return this.run(
      x,
      token,
      "assets.view",
      async (q) =>
        (
          await q.query<{ public_id: string }>(
            "SELECT public_id FROM inventory.assets WHERE inventory_code=$1",
            [code],
          )
        ).rows[0],
    );
  }
  async labelRows(token: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            ids: z.array(z.uuid()).min(1).max(100).optional(),
            category: z.uuid().nullable().optional(),
            room: z.uuid().nullable().optional(),
          })
          .strict(),
        input,
      ),
      x = await this.scope(token, "assets.export");
    return this.run(x, token, "assets.export", async (q) => {
      const rows = (
        await q.query<S.AssetRow>(
          SELECT +
            " WHERE ($1::uuid[] IS NULL OR a.id=ANY($1)) AND ($2::uuid IS NULL OR a.category_id=$2) AND ($3::uuid IS NULL OR a.room_id=$3) AND a.lifecycle_status<>'archived' ORDER BY a.inventory_code LIMIT 101",
          [b.ids ?? null, b.category ?? null, b.room ?? null],
        )
      ).rows;
      if (rows.length > 100)
        assetError(
          "LABEL_LIMIT",
          400,
          "Filter label maksimal 100 aset per cetak.",
        );
      if (!rows.length || (b.ids && new Set(b.ids).size !== rows.length))
        assetError(
          "NOT_FOUND",
          404,
          "Sebagian aset tidak ditemukan, diarsipkan, atau tidak dapat diakses.",
        );
      const settings = (
        await q.query<{ label_width_mm: string; label_height_mm: string }>(
          "SELECT label_width_mm,label_height_mm FROM inventory.tenant_settings",
        )
      ).rows[0];
      return {
        rows,
        tenantName: x.memberships.find(
          (m) => m.tenant_id === x.session.active_tenant_id,
        )!.tenant_name,
        width: Number(settings.label_width_mm),
        height: Number(settings.label_height_mm),
      };
    });
  }
}
