import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthService, tokenDigest } from "@/lib/session/service";
import type { Snapshot } from "@/lib/session/repository";
import type { Sql } from "@/lib/db/types";
import { AppError } from "@/lib/security/errors";
import { mapAssetError } from "@/features/assets/service";
import * as S from "./schemas";
const docSelect = `SELECT d.*,d.row_version::text,d.business_date::text,d.supply_kind kind,d.supply_reason reason,coalesce(r.id,p.id,g.id,a.id) source_id,p.total_amount::text FROM inventory.business_documents d LEFT JOIN inventory.procurement_requests r ON r.tenant_id=d.tenant_id AND r.business_document_id=d.id LEFT JOIN inventory.procurements p ON p.tenant_id=d.tenant_id AND p.business_document_id=d.id LEFT JOIN inventory.goods_receipts g ON g.tenant_id=d.tenant_id AND g.business_document_id=d.id LEFT JOIN inventory.inventory_adjustments a ON a.tenant_id=d.tenant_id AND a.business_document_id=d.id`;
export function mapSupplyError(e: unknown) {
  if (e instanceof AppError) return e;
  const code = (e as { code?: string })?.code,
    message = (e as { message?: string })?.message ?? "";
  if (code === "22003")
    return new AppError(
      "AMOUNT_LIMIT",
      409,
      "Jumlah atau total nilai melampaui batas penyimpanan. Kurangi nilai dokumen.",
    );
  if (code === "23514") {
    const text = message.includes("Insufficient stock")
      ? "Stok tidak mencukupi. Saldo negatif tidak diizinkan."
      : message.includes("Over receipt")
        ? "Jumlah penerimaan melebihi sisa pengadaan. Muat ulang lalu revisi dokumen."
        : message.includes("General approval")
          ? "Workflow approval umum sudah dikonfigurasi. Gunakan approval engine; kebijakan satu admin tidak boleh melewatinya."
          : message.includes("Idempotency")
            ? "Kunci operasi sudah dipakai untuk data berbeda. Mulai formulir baru."
            : "Dokumen belum memenuhi aturan. Periksa sumber yang disetujui, sisa jumlah, satuan dasar, referensi aktif dan hasil pemeriksaan.";
    return new AppError("SUPPLY_RULE_DENIED", 409, text);
  }
  if (code === "42501")
    return new AppError(
      "PERMISSION_DENIED",
      403,
      "Tindakan tidak diizinkan. Periksa izin, kepemilikan draf, reviewer yang berbeda, dan kebijakan review aktif.",
    );
  return mapAssetError(e);
}
const perm = (k: S.Kind) =>
  k === "request" || k === "order"
    ? "procurement.manage"
    : k === "issue"
      ? "inventory.issue"
      : k === "adjustment"
        ? "inventory.adjust"
        : "inventory.receive";
export class SupplyService {
  constructor(public auth: AuthService) {}
  private parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const r = schema.safeParse(input);
    if (!r.success)
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Periksa isian, jumlah, nilai, satuan dan kelengkapan dokumen.",
      );
    return r.data;
  }
  private scope(t: string | undefined, p = "inventory.view") {
    return this.auth.session(t, { permission: p, sensitive: true });
  }
  private run<T>(
    x: Snapshot,
    t: string | undefined,
    p: string,
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
        await q.query("SELECT inventory_security.assert_supply_actor($1)", [p]);
        return fn(q);
      },
    );
  }
  async options(t: string | undefined): Promise<S.Options> {
    const x = await this.scope(t),
      permissions = await this.auth.repo.permissions(x);
    return this.run(x, t, "inventory.view", async (q) => {
      const refs = async (table: string, filter = "") =>
        (
          await q.query<S.Ref>(
            `SELECT *,row_version::text FROM inventory.${table} ${filter} ORDER BY status,code LIMIT 1000`,
          )
        ).rows;
      return {
        tenantId: x.session.active_tenant_id!,
        tenantName: x.memberships.find(
          (m) => m.tenant_id === x.session.active_tenant_id,
        )!.tenant_name,
        permissions,
        reviewMode: (
          await q.query<{ supply_review_mode: string }>(
            "SELECT supply_review_mode FROM inventory.tenant_settings",
          )
        ).rows[0].supply_review_mode,
        items: await refs("inventory_items"),
        rooms: await refs("rooms"),
        units: await refs("units"),
        categories: await refs(
          "asset_categories",
          "WHERE asset_kind='inventory'",
        ),
        funding: await refs("funding_sources"),
        suppliers: permissions.includes("procurement.manage")
          ? await refs("suppliers")
          : [],
      };
    });
  }
  async policy(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            mode: z.enum(["disabled", "single_admin_v1"]),
            reason: z.string().trim().min(3).max(1000),
          })
          .strict(),
        input,
      ),
      x = await this.scope(t, "settings.manage");
    await this.run(x, t, "settings.manage", (q) =>
      q.query("SELECT inventory_security.supply_policy($1,$2)", [
        b.mode,
        b.reason,
      ]),
    );
    return { saved: true };
  }
  async master(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            kind: z.enum(["item", "supplier"]),
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
      data = this.parse(b.kind === "item" ? S.item : S.supplier, b.data),
      x = await this.scope(t, "settings.manage");
    return this.run(
      x,
      t,
      "settings.manage",
      async (q) =>
        (
          await q.query(
            "SELECT inventory_security.supply_master($1,$2,$3,$4) id",
            [b.kind, b.id, b.rowVersion, JSON.stringify(data)],
          )
        ).rows[0],
    );
  }
  async balances(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            query: z.string().trim().max(120).default(""),
            room: z.uuid().nullable().default(null),
            low: z.boolean().default(false),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        input,
      ),
      x = await this.scope(t);
    return this.run(x, t, "inventory.view", async (q) => {
      const cte = `WITH totals AS(SELECT i.id,i.code,i.name,i.status,i.unit_id,u.name unit_name,i.minimum_stock::text,coalesce(sum(b.quantity),0)::text quantity,coalesce(sum(b.stock_value),0)::text stock_value,coalesce(sum(b.quantity),0)<i.minimum_stock low_stock FROM inventory.inventory_items i JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id LEFT JOIN inventory.inventory_stock_balances b ON b.tenant_id=i.tenant_id AND b.item_id=i.id AND ($2::uuid IS NULL OR b.room_id=$2) WHERE ($1='' OR position(lower($1) in lower(i.code||' '||i.name))>0) GROUP BY i.id,u.name) `,
        args = [b.query, b.room, b.low];
      const items = (
          await q.query(
            cte +
              "SELECT * FROM totals WHERE (NOT $3 OR low_stock) ORDER BY code,id LIMIT 20 OFFSET $4",
            [...args, (b.page - 1) * 20],
          )
        ).rows,
        total = (
          await q.query<{ n: string }>(
            cte +
              "SELECT count(*)::text n FROM totals WHERE (NOT $3 OR low_stock)",
            args,
          )
        ).rows[0].n;
      return { items, total: Number(total), page: b.page };
    });
  }
  async card(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            itemId: z.uuid(),
            roomId: z.uuid().nullable().default(null),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        input,
      ),
      x = await this.scope(t);
    return this.run(x, t, "inventory.view", async (q) => {
      const item = (
        await q.query(
          "SELECT i.*,u.name unit_name FROM inventory.inventory_items i JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE i.id=$1",
          [b.itemId],
        )
      ).rows[0];
      if (!item)
        throw new AppError(
          "NOT_FOUND",
          404,
          "Barang tidak ditemukan atau tidak dapat diakses.",
        );
      const cte = `WITH entries AS(SELECT l.id,l.posting_sequence _order,l.created_at,l.kind,l.quantity_delta::text,l.value_delta::text,l.source_document_id,l.room_id,r.name room_name,d.document_number,d.business_date::text,sum(l.quantity_delta) OVER(PARTITION BY l.item_id,l.room_id ORDER BY l.posting_sequence)::text running_quantity,sum(l.value_delta) OVER(PARTITION BY l.item_id,l.room_id ORDER BY l.posting_sequence)::text running_value FROM inventory.inventory_stock_ledger l JOIN inventory.rooms r ON r.tenant_id=l.tenant_id AND r.id=l.room_id JOIN inventory.business_documents d ON d.tenant_id=l.tenant_id AND d.id=l.source_document_id WHERE l.item_id=$1 AND ($2::uuid IS NULL OR l.room_id=$2)) `;
      const entries = (
          await q.query(
            cte +
              "SELECT * FROM entries ORDER BY _order DESC LIMIT 20 OFFSET $3",
            [b.itemId, b.roomId, (b.page - 1) * 20],
          )
        ).rows,
        total = (
          await q.query<{ n: string }>(
            cte + "SELECT count(*)::text n FROM entries",
            [b.itemId, b.roomId],
          )
        ).rows[0].n;
      return {
        item,
        entries: entries.map(({ _order, ...r }) => {
          void _order;
          return r;
        }),
        total: Number(total),
        page: b.page,
      };
    });
  }
  async usage(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            from: z.iso.date(),
            to: z.iso.date(),
            roomId: z.uuid().nullable().default(null),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict()
          .refine((x) => x.from <= x.to),
        input,
      ),
      x = await this.scope(t);
    return this.run(x, t, "inventory.view", async (q) => {
      const cte = `WITH usage AS(SELECT i.id,i.code,i.name,u.name unit_name,(-sum(l.quantity_delta))::text quantity,(-sum(l.value_delta))::text value FROM inventory.inventory_stock_ledger l JOIN inventory.inventory_items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id JOIN inventory.business_documents d ON d.tenant_id=l.tenant_id AND d.id=l.source_document_id WHERE l.kind='issue' AND d.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR l.room_id=$3) GROUP BY i.id,u.name) `,
        args = [b.from, b.to, b.roomId];
      return {
        items: (
          await q.query(
            cte + "SELECT * FROM usage ORDER BY code LIMIT 20 OFFSET $4",
            [...args, (b.page - 1) * 20],
          )
        ).rows,
        total: Number(
          (
            await q.query<{ n: string }>(
              cte + "SELECT count(*)::text n FROM usage",
              args,
            )
          ).rows[0].n,
        ),
        page: b.page,
      };
    });
  }
  async documents(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            kind: S.kindSchema,
            status: z.string().max(40).default("all"),
            query: z.string().trim().max(120).default(""),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        input,
      ),
      x = await this.scope(
        t,
        b.kind === "order" || b.kind === "request"
          ? "procurement.manage"
          : "inventory.view",
      );
    return this.run(
      x,
      t,
      b.kind === "order" || b.kind === "request"
        ? "procurement.manage"
        : "inventory.view",
      async (q) => {
        const filter =
            " WHERE d.supply_kind=$1 AND ($2='all' OR d.status=$2) AND ($3='' OR position(lower($3) in lower(d.document_number||' '||coalesce(d.supply_reason,'')))>0)",
          args = [b.kind, b.status, b.query];
        const items = (
            await q.query<S.DocumentRow>(
              docSelect.replace(
                "d.*",
                "d.id,d.document_number,d.status,d.business_date,d.requested_by,d.revision",
              ) +
                filter +
                " ORDER BY d.created_at DESC,d.id LIMIT 20 OFFSET $4",
              [...args, (b.page - 1) * 20],
            )
          ).rows,
          total = (
            await q.query<{ n: string }>(
              "SELECT count(*)::text n FROM inventory.business_documents d" +
                filter,
              args,
            )
          ).rows[0].n;
        return { items, total: Number(total), page: b.page };
      },
    );
  }
  async save(t: string | undefined, input: unknown) {
    const b = this.parse(S.document, input),
      x = await this.scope(t, perm(b.kind));
    if (b.kind === "order") {
      const sensitive = (await this.auth.repo.permissions(x)).includes(
        "files.sensitive.download",
      );
      if (!sensitive && b.id) {
        const saved = await this.run(x, t, "procurement.manage", (q) =>
          q.query<{ input_snapshot: unknown }>(
            "SELECT input_snapshot FROM inventory.business_documents WHERE id=$1",
            [b.id],
          ),
        );
        const hasSecret = (v: unknown): boolean =>
          !!v &&
          typeof v === "object" &&
          Object.entries(v).some(([k, value]) =>
            [
              "certificate_number",
              "chassis_number",
              "engine_number",
              "ownership_document_number",
            ].includes(k)
              ? !!value
              : hasSecret(value),
          );
        if (hasSecret(saved.rows[0]?.input_snapshot))
          throw new AppError(
            "SENSITIVE_DENIED",
            403,
            "Dokumen memuat data kepemilikan terbatas. Pulihkan izin yang sesuai sebelum mengedit.",
          );
      }
      for (const l of b.lines)
        if (l.asset && l.asset.detail.type !== "general") {
          const raw = l.asset.detail.data as Record<string, unknown>;
          if (
            !sensitive &&
            [
              "certificate_number",
              "chassis_number",
              "engine_number",
              "ownership_document_number",
            ].some((k) => raw[k])
          )
            throw new AppError(
              "SENSITIVE_DENIED",
              403,
              "Data kepemilikan sensitif memerlukan izin tambahan.",
            );
        }
    }
    return this.run(
      x,
      t,
      perm(b.kind),
      async (q) =>
        (
          await q.query<{ id: string }>(
            "SELECT inventory_security.supply_save($1,$2,$3,$4) id",
            [b.id, b.rowVersion, b.idempotencyKey, JSON.stringify(b)],
          )
        ).rows[0],
    );
  }
  async detail(t: string | undefined, id: string): Promise<S.Detail> {
    this.parse(z.uuid(), id);
    const x = await this.scope(t),
      permissions = await this.auth.repo.permissions(x);
    return this.run(x, t, "inventory.view", async (q) => {
      const d = (
        await q.query<S.DocumentRow>(
          docSelect + " WHERE d.id=$1 AND d.supply_kind IS NOT NULL",
          [id],
        )
      ).rows[0];
      if (!d)
        throw new AppError(
          "NOT_FOUND",
          404,
          "Dokumen tidak ditemukan atau tidak dapat diakses.",
        );
      if (
        (d.kind === "request" || d.kind === "order") &&
        !permissions.includes("procurement.manage")
      )
        throw new AppError(
          "PERMISSION_DENIED",
          403,
          "Izin pengadaan diperlukan.",
        );
      let sql: string;
      if (d.kind === "request")
        sql =
          "SELECT i.*,i.quantity::text,i.estimated_unit_cost::text,u.name unit_name,coalesce((SELECT sum(o.quantity) FROM inventory.procurement_items o JOIN inventory.procurements p ON p.tenant_id=o.tenant_id AND p.id=o.procurement_id WHERE o.tenant_id=i.tenant_id AND o.request_item_id=i.id AND p.status<>'cancelled'),0)::text ordered_quantity FROM inventory.procurement_request_items i JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE request_id=$1 ORDER BY line_number";
      else if (d.kind === "order")
        sql =
          "SELECT i.*,i.quantity::text,i.received_quantity::text,i.unit_cost::text,u.name unit_name FROM inventory.procurement_items i JOIN inventory.units u ON u.tenant_id=i.tenant_id AND u.id=i.unit_id WHERE procurement_id=$1 ORDER BY line_number";
      else if (d.kind === "receipt")
        sql =
          "SELECT i.*,i.quantity::text,i.accepted_quantity::text,p.description,p.destination_kind,r.name room_name FROM inventory.goods_receipt_items i JOIN inventory.procurement_items p ON p.tenant_id=i.tenant_id AND p.id=i.procurement_item_id JOIN inventory.rooms r ON r.tenant_id=i.tenant_id AND r.id=i.room_id WHERE receipt_id=$1 ORDER BY line_number";
      else
        sql =
          "SELECT l.*,l.quantity_delta::text,l.unit_cost::text,i.name,i.code,r.name room_name FROM inventory.inventory_transaction_lines l JOIN inventory.inventory_items i ON i.tenant_id=l.tenant_id AND i.id=l.item_id JOIN inventory.rooms r ON r.tenant_id=l.tenant_id AND r.id=l.room_id WHERE adjustment_id=$1 ORDER BY line_number";
      const lines = (await q.query<S.Ref>(sql, [d.source_id])).rows,
        sensitive = permissions.includes("files.sensitive.download");
      if (d.kind === "receipt" && permissions.includes("assets.view"))
        for (const line of lines) {
          line.created_assets = (
            await q.query(
              "SELECT a.id,a.inventory_code,a.name FROM inventory.receipt_asset_links l JOIN inventory.assets a ON a.tenant_id=l.tenant_id AND a.id=l.asset_id WHERE l.receipt_item_id=$1 ORDER BY a.inventory_code",
              [line.id],
            )
          ).rows;
        }
      if (!sensitive) {
        const strip = (v: unknown): void => {
          if (!v || typeof v !== "object") return;
          for (const key of Object.keys(v)) {
            if (
              [
                "certificate_number",
                "chassis_number",
                "engine_number",
                "ownership_document_number",
              ].includes(key)
            )
              delete (v as Record<string, unknown>)[key];
            else strip((v as Record<string, unknown>)[key]);
          }
        };
        strip(d);
        strip(lines);
      }
      const related = permissions.includes("procurement.manage")
        ? (
            await q.query<{
              id: string;
              document_number: string;
              status: string;
            }>(
              d.kind === "request"
                ? "SELECT business_document_id id,document_number,status FROM inventory.procurements WHERE request_id=$1 ORDER BY created_at DESC LIMIT 100"
                : d.kind === "order"
                  ? "SELECT business_document_id id,document_number,status FROM inventory.goods_receipts WHERE procurement_id=$1 UNION ALL SELECT r.business_document_id,r.document_number,r.status FROM inventory.procurement_requests r JOIN inventory.procurements p ON p.tenant_id=r.tenant_id AND p.request_id=r.id WHERE p.id=$1 LIMIT 100"
                  : d.kind === "receipt"
                    ? "SELECT p.business_document_id id,p.document_number,p.status FROM inventory.procurements p JOIN inventory.goods_receipts r ON r.tenant_id=p.tenant_id AND r.procurement_id=p.id WHERE r.id=$1"
                    : "SELECT id,document_number,status FROM inventory.business_documents WHERE false",
              d.kind === "request" || d.kind === "order" || d.kind === "receipt"
                ? [d.source_id]
                : [],
            )
          ).rows
        : [];
      return {
        related,
        doc: d,
        lines,
        events: (
          await q.query<S.Detail["events"][number]>(
            "SELECT * FROM (SELECT action,reason,revision,actor_id,created_at FROM inventory.supply_review_events WHERE document_id=$1 UNION ALL SELECT action,reason,revision,actor_id,created_at FROM inventory_security.document_approval_trail($1)) history ORDER BY created_at DESC LIMIT 100",
            [id],
          )
        ).rows,
        attachments: permissions.includes("files.download")
          ? (
              await q.query<S.Detail["attachments"][number]>(
                "SELECT f.id,f.original_filename,f.mime_type,f.file_size::text,f.status,f.sensitivity FROM inventory.document_attachments a JOIN inventory.file_attachments f ON f.tenant_id=a.tenant_id AND f.id=a.file_id WHERE a.document_id=$1 AND ($2 OR f.sensitivity='normal') ORDER BY f.created_at DESC LIMIT 100",
                [id, sensitive],
              )
            ).rows
          : [],
      };
    });
  }
  async transition(t: string | undefined, input: unknown) {
    const b = this.parse(
        z
          .object({
            id: z.uuid(),
            rowVersion: z.string().regex(/^[1-9]\d{0,17}$/),
            action: z.enum([
              "submit",
              "review",
              "approve",
              "reject",
              "revision",
              "cancel",
            ]),
            reason: z.string().trim().min(3).max(1000),
          })
          .strict(),
        input,
      ),
      d = await this.detail(t, b.id),
      p = ["review", "approve", "reject", "revision"].includes(b.action)
        ? "approval.manage"
        : perm(d.doc.kind),
      x = await this.scope(t, p);
    await this.run(x, t, p, (q) =>
      q.query("SELECT inventory_security.supply_transition($1,$2,$3,$4)", [
        b.id,
        b.rowVersion,
        b.action,
        b.reason,
      ]),
    );
    return { saved: true };
  }
  async post(t: string | undefined, input: unknown) {
    const b = this.parse(
        z.object({ id: z.uuid(), idempotencyKey: z.uuid() }).strict(),
        input,
      ),
      d = await this.detail(t, b.id),
      p = perm(d.doc.kind),
      x = await this.scope(t, p);
    return this.run(
      x,
      t,
      p,
      async (q) =>
        (
          await q.query<{ result: { posted: boolean; reused: boolean } }>(
            "SELECT inventory_security.supply_post($1,$2) result",
            [b.id, b.idempotencyKey],
          )
        ).rows[0].result,
    );
  }
  async link(t: string | undefined, input: unknown) {
    const b = this.parse(
        z.object({ documentId: z.uuid(), fileId: z.uuid() }).strict(),
        input,
      ),
      d = await this.detail(t, b.documentId),
      p = perm(d.doc.kind),
      x = await this.scope(t, p);
    await this.auth.session(t, { permission: "files.upload", sensitive: true });
    return this.run(
      x,
      t,
      p,
      async (q) =>
        (
          await q.query(
            "SELECT inventory_security.supply_link_file($1,$2) id",
            [b.documentId, b.fileId],
          )
        ).rows[0],
    );
  }
}
