import "server-only";
import { SupplyService, mapSupplyError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
export type Action =
  | "options"
  | "balances"
  | "card"
  | "usage"
  | "documents"
  | "detail"
  | "policy"
  | "master"
  | "save"
  | "transition"
  | "post"
  | "link";
export class SupplyController {
  constructor(
    private service: SupplyService,
    private origin: string,
  ) {}
  async handle(action: Action, r: Request) {
    try {
      const get = [
        "options",
        "balances",
        "card",
        "usage",
        "documents",
        "detail",
      ].includes(action);
      if (r.method !== (get ? "GET" : "POST"))
        throw new AppError("METHOD_NOT_ALLOWED", 405, "Metode tidak didukung.");
      if (!get) H.assertCsrf(r, this.origin);
      const token = H.cookieValue(r, H.cookieNames(this.origin).session),
        u = new URL(r.url),
        session = await this.service.auth.session(token);
      if (
        r.headers.get("X-Tenant-Context") !== session.session.active_tenant_id
      )
        throw new AppError(
          "TENANT_CONTEXT_CHANGED",
          409,
          "Lembaga aktif berubah. Muat ulang halaman.",
        );
      let data: unknown;
      if (action === "options") data = await this.service.options(token);
      else if (action === "balances")
        data = await this.service.balances(token, {
          query: u.searchParams.get("query") ?? "",
          room: u.searchParams.get("room") || null,
          low: u.searchParams.get("low") === "1",
          page: u.searchParams.get("page") ?? 1,
        });
      else if (action === "card")
        data = await this.service.card(token, {
          itemId: u.searchParams.get("itemId"),
          roomId: u.searchParams.get("roomId") || null,
          page: u.searchParams.get("page") ?? 1,
        });
      else if (action === "usage")
        data = await this.service.usage(token, {
          from: u.searchParams.get("from"),
          to: u.searchParams.get("to"),
          roomId: u.searchParams.get("roomId") || null,
          page: u.searchParams.get("page") ?? 1,
        });
      else if (action === "documents")
        data = await this.service.documents(token, {
          kind: u.searchParams.get("kind"),
          query: u.searchParams.get("query") ?? "",
          status: u.searchParams.get("status") ?? "all",
          page: u.searchParams.get("page") ?? 1,
        });
      else if (action === "detail")
        data = await this.service.detail(token, u.searchParams.get("id") ?? "");
      else {
        const body = await H.readJson(r, 512000);
        switch (action) {
          case "policy":
            data = await this.service.policy(token, body);
            break;
          case "master":
            data = await this.service.master(token, body);
            break;
          case "save":
            data = await this.service.save(token, body);
            break;
          case "transition":
            data = await this.service.transition(token, body);
            break;
          case "post":
            data = await this.service.post(token, body);
            break;
          case "link":
            data = await this.service.link(token, body);
            break;
        }
      }
      return H.json({ success: true, data });
    } catch (e) {
      const error = mapSupplyError(e);
      return H.json(
        {
          success: false,
          error: { code: error.code, message: error.publicMessage },
        },
        error.status,
      );
    }
  }
}
