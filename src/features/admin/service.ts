import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { AuthService, tokenDigest } from "@/lib/session/service";
import type { Snapshot } from "@/lib/session/repository";
import type { Sql } from "@/lib/db/types";
import type { SsoClient } from "@/lib/sso/client";
import { SsoError } from "@/lib/sso/client";
import { AppError } from "@/lib/security/errors";
import * as S from "./schemas";
export interface DirectoryProvider {
  getUser: SsoClient["getUser"];
  searchUsers: SsoClient["searchUsers"];
}
export function mapAdminError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof SsoError)
    return new AppError(
      "DIRECTORY_UNAVAILABLE",
      503,
      "Direktori pusat belum dapat dihubungi. Coba kembali.",
    );
  const code = (e as { code?: string })?.code;
  if (code === "42501")
    return new AppError(
      "PERMISSION_DENIED",
      403,
      "Tindakan ini tidak diizinkan.",
    );
  if (code === "28000")
    return new AppError(
      "REAUTH_REQUIRED",
      401,
      "Masuk kembali sebelum melakukan tindakan platform.",
    );
  if (code === "P0002")
    return new AppError(
      "NOT_FOUND",
      404,
      "Data tidak ditemukan atau tidak dapat diakses.",
    );
  if (code === "40001")
    return new AppError(
      "VERSION_CONFLICT",
      409,
      "Data telah berubah. Muat ulang sebelum menyimpan.",
    );
  if (code === "23505")
    return new AppError(
      "DUPLICATE",
      409,
      "Pengguna atau kode lembaga sudah terdaftar.",
    );
  if (code === "23514" || code === "23503")
    return new AppError(
      "CONSTRAINT_DENIED",
      409,
      "Data belum memenuhi aturan. Periksa admin aktif, relasi data, dan kesiapan koneksi Drive untuk aktivasi.",
    );
  return new AppError(
    "SERVICE_UNAVAILABLE",
    503,
    "Layanan administrasi belum dapat diproses.",
  );
}
export class AdminService {
  constructor(
    public auth: AuthService,
    private directory: DirectoryProvider,
    private rateSecret: string,
  ) {}
  private parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
    const x = schema.safeParse(input);
    if (!x.success)
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Periksa isian formulir dan pilih data yang tersedia.",
      );
    return x.data;
  }
  private async tenant(token: string | undefined, sensitive = false) {
    return this.auth.session(token, { permission: "users.manage", sensitive });
  }
  private async platform(token: string | undefined, sensitive = false) {
    const x = await this.auth.session(token, { tenant: false, sensitive });
    if (!x.is_operator)
      throw new AppError(
        "PERMISSION_DENIED",
        403,
        "Kewenangan operator platform diperlukan.",
      );
    return x;
  }
  private run<T>(
    x: Snapshot,
    token: string | undefined,
    fn: (sql: Sql) => Promise<T>,
    platform = false,
  ) {
    return this.auth.repo.db.run(
      platform ? "auth" : "runtime",
      {
        userId: x.user.id,
        tenantId: platform
          ? undefined
          : (x.session.active_tenant_id ?? undefined),
        membershipId: platform
          ? undefined
          : (x.session.active_membership_id ?? undefined),
        sessionDigest: token ? tokenDigest(token) : undefined,
      },
      fn,
    );
  }
  async data(token: string | undefined, page = 1) {
    const x = await this.tenant(token);
    return this.run(
      x,
      token,
      async (q) =>
        (
          await q.query<{ data: S.AdminData }>(
            "SELECT inventory_security.tenant_admin_data($1) AS data",
            [page],
          )
        ).rows[0].data,
    );
  }
  async platformData(token: string | undefined, page = 1) {
    const x = await this.platform(token);
    return this.run(
      x,
      token,
      async (q) =>
        (
          await q.query<{ data: S.PlatformData }>(
            "SELECT inventory_security.platform_tenants($1) AS data",
            [page],
          )
        ).rows[0].data,
      true,
    );
  }
  async search(
    token: string | undefined,
    query: string,
    page: number,
    mode: "tenant" | "platform",
  ) {
    const x =
      mode === "platform"
        ? await this.platform(token)
        : await this.tenant(token);
    if (
      [...query.trim()].length < 2 ||
      [...query].length > 100 ||
      /[\u0000-\u001f\u007f]/.test(query) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1000000
    )
      throw new AppError(
        "VALIDATION_ERROR",
        400,
        "Ketik minimal dua karakter untuk mencari pengguna.",
      );
    const hash = (s: string) =>
      createHmac("sha256", this.rateSecret).update(s).digest("hex");
    if (
      !(await this.auth.repo.limit(hash("directory-global"), 20, 60)) ||
      !(await this.auth.repo.limit(hash("directory-user:" + x.user.id), 10, 60))
    )
      throw new AppError(
        "RATE_LIMITED",
        429,
        "Pencarian terlalu sering. Tunggu sebentar lalu coba kembali.",
      );
    const r = await this.directory.searchUsers({
      query: query.trim(),
      status: "active",
      page,
      page_size: 25,
      sort_by: "full_name",
      sort_direction: "asc",
    });
    return {
      items: r.items.map((u) => ({
        sso_user_id: u.sso_user_id,
        username: u.username,
        full_name: u.full_name,
      })),
      pagination: r.pagination,
    };
  }
  private async centralUser(id: string) {
    try {
      const u = await this.directory.getUser(id);
      if (u.account_status !== "active")
        throw new AppError(
          "CENTRAL_USER_INACTIVE",
          400,
          "Pengguna pusat harus aktif.",
        );
      return u;
    } catch (e) {
      if (e instanceof SsoError && e.code === "NOT_FOUND")
        throw new AppError("NOT_FOUND", 404, "Pengguna pusat tidak ditemukan.");
      throw e;
    }
  }
  async add(token: string | undefined, input: unknown) {
    const p = this.parse(S.memberCreate, input),
      x = await this.tenant(token, true),
      u = await this.centralUser(p.sso_user_id);
    return this.run(x, token, async (q) => {
      const r = await q.query<{ id: string }>(
        "SELECT inventory_security.add_tenant_member($1,$2,$3,$4,$5) AS id",
        [u.sso_user_id, u.username, u.full_name, p.role, p.status],
      );
      return { id: r.rows[0].id };
    });
  }
  async update(token: string | undefined, input: unknown) {
    const p = this.parse(S.memberUpdate, input),
      x = await this.tenant(token, true);
    return this.run(x, token, async (q) => {
      await q.query(
        "SELECT inventory_security.update_tenant_member($1,$2,$3,$4)",
        [p.membership_id, p.role, p.status, p.row_version],
      );
      return { updated: true };
    });
  }
  async permissions(token: string | undefined, input: unknown) {
    const p = this.parse(S.roleUpdate, input),
      x = await this.tenant(token, true);
    return this.run(x, token, async (q) => {
      await q.query(
        "SELECT inventory_security.update_role_permissions($1,$2,$3)",
        [p.role_id, p.permissions, p.row_version],
      );
      return { updated: true };
    });
  }
  async profile(token: string | undefined, input: unknown) {
    const p = this.parse(S.profileInput, input),
      x = await this.auth.session(token, {
        permission: "settings.manage",
        sensitive: true,
      });
    return this.run(x, token, async (q) => {
      await q.query(
        "SELECT inventory_security.update_tenant_profile($1,$2,$3::jsonb,$4)",
        [p.name, p.timezone, JSON.stringify(p.profile), p.row_version],
      );
      return { updated: true };
    });
  }
  async provision(token: string | undefined, input: unknown) {
    const p = this.parse(S.provisionInput, input),
      x = await this.platform(token, true),
      u = await this.centralUser(p.admin_sso_user_id);
    return this.run(
      x,
      token,
      async (q) =>
        (
          await q.query<{ data: { id: string; reused: boolean } }>(
            "SELECT inventory_security.provision_tenant($1,$2,$3,$4,$5,$6) AS data",
            [
              p.code,
              p.name,
              u.sso_user_id,
              u.username,
              u.full_name,
              p.idempotency_key,
            ],
          )
        ).rows[0].data,
      true,
    );
  }
  async tenantStatus(token: string | undefined, input: unknown) {
    const p = this.parse(S.tenantStatusInput, input),
      x = await this.platform(token, true);
    return this.run(
      x,
      token,
      async (q) => {
        await q.query(
          "SELECT inventory_security.set_tenant_status($1,$2,$3,$4)",
          [p.tenant_id, p.status, p.row_version, p.reason],
        );
        return { updated: true };
      },
      true,
    );
  }
}
