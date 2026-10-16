import "server-only";
import { z } from "zod";
import { AuthService } from "@/lib/session/service";
import { AppError } from "@/lib/security/errors";
import * as H from "@/lib/security/http";
export class AuthController {
  constructor(
    private service: AuthService,
    private origin: string,
    private trustedSource?: (r: Request) => string | undefined,
  ) {}
  async handle(
    action: "csrf" | "login" | "logout" | "session" | "tenants" | "switch",
    request: Request,
  ) {
    const n = H.cookieNames(this.origin);
    try {
      const expected = ["csrf", "session", "tenants"].includes(action)
        ? "GET"
        : "POST";
      if (request.method !== expected)
        return H.json(
          {
            success: false,
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Metode tidak didukung.",
            },
          },
          405,
        );
      if (expected === "POST") H.assertCsrf(request, this.origin);
      const old = H.cookieValue(request, n.session);
      if (action === "csrf") {
        const o = request.headers.get("origin");
        if (
          (o && o !== this.origin) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          throw new AppError(
            "ORIGIN_DENIED",
            403,
            "Permintaan tidak diizinkan.",
          );
        const existing = H.cookieValue(request, n.csrf);
        const token = existing && /^[0-9a-f]{64}$/.test(existing) ? existing : H.newCsrf();
        const response = H.json({ success: true, token });
        response.headers.append(
          "Set-Cookie",
          H.cookie(n.csrf, token, n.secure, 3600),
        );
        return response;
      }
      if (action === "login") {
        const input = await H.readJson(request);
        const result = await this.service.login(
          input,
          old,
          this.trustedSource?.(request),
        );
        const response = H.json({ success: true, next: result.next });
        response.headers.append(
          "Set-Cookie",
          H.cookie(
            n.session,
            result.token,
            n.secure,
            (result.expires.getTime() - Date.now()) / 1000,
          ),
        );
        return response;
      }
      if (action === "logout") {
        const r = await this.service.logout(old);
        const response = H.json({ success: true, ...r });
        response.headers.append(
          "Set-Cookie",
          H.cookie(n.session, "", n.secure, 0),
        );
        response.headers.append(
          "Set-Cookie",
          H.cookie(n.csrf, "", n.secure, 0),
        );
        return response;
      }
      if (action === "switch") {
        const parsed = z
          .object({ tenant_id: z.uuid() })
          .strict()
          .safeParse(await H.readJson(request, 2048));
        if (!parsed.success)
          throw new AppError(
            "VALIDATION_ERROR",
            400,
            "Pilihan lembaga tidak valid.",
          );
        const r = await this.service.switchTenant(old, parsed.data.tenant_id);
        const response = H.json({ success: true, next: r.next });
        response.headers.append(
          "Set-Cookie",
          H.cookie(
            n.session,
            r.token,
            n.secure,
            (r.expires.getTime() - Date.now()) / 1000,
          ),
        );
        return response;
      }
      const x = await this.service.session(old, { tenant: false });
      if (action === "tenants")
        return H.json({
          success: true,
          items: x.memberships.map((m) => ({
            id: m.tenant_id,
            name: m.tenant_name,
          })),
          active_tenant_id: x.session.active_tenant_id,
        });
      return H.json({
        success: true,
        user: { name: x.user.full_name_snapshot },
        tenant:
          x.memberships.find((m) => m.tenant_id === x.session.active_tenant_id)
            ?.tenant_name ?? null,
        needs_tenant: !x.session.active_tenant_id,
      });
    } catch (e) {
      const error =
        e instanceof AppError
          ? e
          : new AppError(
              "SERVICE_UNAVAILABLE",
              503,
              "Layanan belum dapat dihubungi. Silakan coba kembali.",
            );
      if (!(e instanceof AppError)) console.error("AUTH_REQUEST_FAILED");
      const r = H.json(
        {
          success: false,
          error: { code: error.code, message: error.publicMessage },
        },
        error.status,
      );
      if (error.status === 401)
        r.headers.append("Set-Cookie", H.cookie(n.session, "", n.secure, 0));
      return r;
    }
  }
}
