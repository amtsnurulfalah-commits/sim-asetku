import "server-only";
import { DriveService } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
import { mapAdminError } from "@/features/admin/service";
import { CHUNK_SIZE, fail } from "@/lib/drive/core";
export type DriveAction =
  | "data"
  | "files"
  | "configure"
  | "oauth-start"
  | "oauth-callback"
  | "test"
  | "initialize"
  | "revoke"
  | "start"
  | "chunk"
  | "finish"
  | "recover"
  | "download"
  | "archive"
  | "reconcile"
  | "rotate";
export class DriveController {
  constructor(
    private service: DriveService,
    private origin: string,
  ) {}
  async handle(action: DriveAction, r: Request) {
    const n = H.cookieNames(this.origin);
    try {
      const get = ["data", "files", "oauth-callback", "download"].includes(
        action,
      );
      if (r.method !== (get ? "GET" : "POST")) fail("METHOD_NOT_ALLOWED", 405);
      if (!get) H.assertCsrf(r, this.origin);
      const token = H.cookieValue(r, n.session),
        url = new URL(r.url);
      if (action !== "oauth-callback") {
        const x = await this.service.auth.session(token);
        if (r.headers.get("x-tenant-context") !== x.session.active_tenant_id)
          throw new AppError(
            "TENANT_CONTEXT_CHANGED",
            409,
            "Lembaga aktif berubah. Muat ulang halaman.",
          );
      }
      if (action === "oauth-callback") {
        if (url.searchParams.has("error")) fail("OAUTH_CANCELLED", 400);
        await this.service.oauthCallback(
          token,
          url.searchParams.get("state") ?? "",
          url.searchParams.get("code") ?? "",
        );
        return new Response(null, {
          status: 303,
          headers: {
            Location: this.origin + "/administrasi/drive?oauth=selesai",
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (action === "download") {
        const start = Number(url.searchParams.get("start")),
          end = Number(url.searchParams.get("end"));
        if (!url.searchParams.has("start") || !url.searchParams.has("end"))
          fail("INVALID_RANGE", 400);
        const f = await this.service.download(
          token,
          url.searchParams.get("id") ?? "",
          start,
          end,
          url.searchParams.get("preview") === "1",
        );
        return new Response(Buffer.from(f.bytes), {
          status: 206,
          headers: {
            "Content-Type": f.mime,
            "Content-Length": String(f.bytes.length),
            "Content-Range": `bytes ${start}-${end}/${f.size}`,
            "Content-Disposition":
              "attachment; filename*=UTF-8''" + encodeURIComponent(f.name),
            "Cache-Control": "private, no-store",
            Vary: "Cookie",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          },
        });
      }
      let data: unknown;
      if (action === "data" || action === "files")
        data = await this.service.data(token, action === "files");
      else if (action === "initialize")
        data = await this.service.initialize(token);
      else if (action === "rotate") data = await this.service.rotate(token);
      else if (action === "reconcile")
        data = await this.service.reconcile(token);
      else if (action === "chunk") {
        if (!url.searchParams.has("offset")) fail("INVALID_CHUNK", 400);
        if (r.headers.get("content-type") !== "application/octet-stream")
          fail("INVALID_CHUNK", 400);
        const reader = r.body?.getReader();
        if (!reader) fail("INVALID_CHUNK", 400);
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > CHUNK_SIZE) fail("PAYLOAD_TOO_LARGE", 413);
            parts.push(value);
          }
        } finally {
          await reader.cancel();
        }
        data = await this.service.chunk(
          token,
          url.searchParams.get("id") ?? "",
          Number(url.searchParams.get("offset")),
          Buffer.concat(parts),
        );
      } else {
        const b = await H.readJson(r);
        switch (action) {
          case "configure":
            data = await this.service.configure(token, b);
            break;
          case "oauth-start":
            data = await this.service.oauthStart(token, b);
            break;
          case "test":
            data = await this.service.test(token, b);
            break;
          case "revoke":
            data = await this.service.revoke(token, b);
            break;
          case "start":
            data = await this.service.start(token, b);
            break;
          case "finish":
            data = await this.service.finish(token, b);
            break;
          case "recover":
            data = await this.service.recover(token, b);
            break;
          case "archive":
            data = await this.service.archive(token, b);
            break;
        }
      }
      return H.json({ success: true, data });
    } catch (e) {
      const error = mapAdminError(e);
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
