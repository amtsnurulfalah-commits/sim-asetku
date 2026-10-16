import "server-only";
import { AdminService, mapAdminError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
export type AdminAction =
  | "users"
  | "member-create"
  | "member-update"
  | "role-update"
  | "profile"
  | "profile-update"
  | "directory"
  | "platform-list"
  | "platform-create"
  | "tenant-status";
export class AdminController {
  constructor(
    private service: AdminService,
    private origin: string,
  ) {}
  async handle(action: AdminAction, request: Request) {
    const n = H.cookieNames(this.origin);
    try {
      const get = ["users", "profile", "directory", "platform-list"].includes(
        action,
      );
      if (request.method !== (get ? "GET" : "POST"))
        throw new AppError("METHOD_NOT_ALLOWED", 405, "Metode tidak didukung.");
      if (!get) H.assertCsrf(request, this.origin);
      const token = H.cookieValue(request, n.session),
        url = new URL(request.url),
        page = Number(url.searchParams.get("page") ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
        throw new AppError("VALIDATION_ERROR", 400, "Halaman tidak valid.");
      const tenantScoped =
        [
          "users",
          "profile",
          "member-create",
          "member-update",
          "role-update",
          "profile-update",
        ].includes(action) ||
        (action === "directory" &&
          (url.searchParams.get("mode") ?? "tenant") === "tenant");
      if (tenantScoped) {
        const current = await this.service.auth.session(token);
        if (
          request.headers.get("x-tenant-context") !==
          current.session.active_tenant_id
        )
          throw new AppError(
            "TENANT_CONTEXT_CHANGED",
            409,
            "Lembaga aktif telah berubah. Muat ulang halaman sebelum melanjutkan.",
          );
      }
      let data: unknown;
      if (action === "users" || action === "profile")
        data = await this.service.data(token, page);
      else if (action === "platform-list")
        data = await this.service.platformData(token, page);
      else if (action === "directory") {
        const mode = url.searchParams.get("mode") ?? "tenant";
        if (mode !== "tenant" && mode !== "platform")
          throw new AppError(
            "VALIDATION_ERROR",
            400,
            "Konteks pencarian tidak valid.",
          );
        data = await this.service.search(
          token,
          url.searchParams.get("query") ?? "",
          page,
          mode,
        );
      } else {
        const body = await H.readJson(request, 12288);
        switch (action) {
          case "member-create":
            data = await this.service.add(token, body);
            break;
          case "member-update":
            data = await this.service.update(token, body);
            break;
          case "role-update":
            data = await this.service.permissions(token, body);
            break;
          case "profile-update":
            data = await this.service.profile(token, body);
            break;
          case "platform-create":
            data = await this.service.provision(token, body);
            break;
          case "tenant-status":
            data = await this.service.tenantStatus(token, body);
            break;
        }
      }
      return H.json({ success: true, data });
    } catch (e) {
      const err = mapAdminError(e);
      const r = H.json(
        {
          success: false,
          error: { code: err.code, message: err.publicMessage },
        },
        err.status,
      );
      if (err.status === 401)
        r.headers.append("Set-Cookie", H.cookie(n.session, "", n.secure, 0));
      return r;
    }
  }
}
