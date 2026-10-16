import "server-only";
import { AssetService } from "./service";
import { mapAssetError } from "./service";
import * as H from "@/lib/security/http";
import { AppError } from "@/lib/security/errors";
import { labelPdf, qrPng } from "./labels";
import { parseScan } from "./qr";
export type AssetAction =
  | "options"
  | "masters"
  | "master-save"
  | "configuration"
  | "list"
  | "create"
  | "update"
  | "detail"
  | "archive"
  | "link"
  | "files"
  | "qr"
  | "labels"
  | "resolve";
export class AssetController {
  constructor(
    private service: AssetService,
    private origin: string,
  ) {}
  async handle(action: AssetAction, r: Request) {
    try {
      const get = [
        "options",
        "masters",
        "list",
        "detail",
        "files",
        "qr",
        "resolve",
      ].includes(action);
      if (r.method !== (get ? "GET" : "POST"))
        throw new AppError("METHOD_NOT_ALLOWED", 405, "Metode tidak didukung.");
      if (!get) H.assertCsrf(r, this.origin);
      const token = H.cookieValue(r, H.cookieNames(this.origin).session),
        url = new URL(r.url),
        x = await this.service.auth.session(token);
      if (r.headers.get("X-Tenant-Context") !== x.session.active_tenant_id)
        throw new AppError(
          "TENANT_CONTEXT_CHANGED",
          409,
          "Lembaga aktif telah berubah. Muat ulang halaman.",
        );
      let data: unknown;
      if (action === "options")
        data = await this.service.options(
          token,
          url.searchParams.get("master") === "1",
        );
      else if (action === "masters")
        data = await this.service.masters(token, {
          kind: url.searchParams.get("kind"),
          query: url.searchParams.get("query") ?? "",
          page: url.searchParams.get("page") ?? 1,
        });
      else if (action === "list")
        data = await this.service.list(
          token,
          Object.fromEntries(url.searchParams),
        );
      else if (action === "detail")
        data = await this.service.detail(
          token,
          url.searchParams.get("id") ?? "",
          url.searchParams.get("public") === "1",
        );
      else if (action === "files") data = await this.service.files(token);
      else if (action === "resolve") {
        let scan: ReturnType<typeof parseScan>;
        try {
          scan = parseScan(url.searchParams.get("value") ?? "", this.origin);
        } catch {
          throw new AppError("SCAN_INVALID", 400, "Kode QR tidak valid atau bukan milik aplikasi ini.");
        }
        if (scan.publicId) {
          const d = await this.service.detail(token, scan.publicId, true);
          data = { path: "/aset/qr/" + d.asset.public_id };
        } else {
          const exact = await this.service.resolveCode(token, scan.code!);
          if (!exact)
            throw new AppError(
              "NOT_FOUND",
              404,
              "Kode tidak ditemukan atau tidak dapat diakses.",
            );
          data = { path: "/aset/qr/" + exact.public_id };
        }
      } else if (action === "qr") {
        const d = await this.service.detail(
          token,
          url.searchParams.get("id") ?? "",
        );
        return new Response(
          Buffer.from(await qrPng(this.origin, d.asset.public_id)),
          {
            headers: {
              "Content-Type": "image/png",
              "Cache-Control": "private, no-store",
              Vary: "Cookie",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      } else {
        const b = await H.readJson(r, 65536);
        switch (action) {
          case "master-save":
            data = await this.service.saveMaster(token, b);
            break;
          case "configuration":
            data = await this.service.configure(token, b);
            break;
          case "create":
            data = await this.service.create(token, b);
            break;
          case "update":
            data = await this.service.update(token, b);
            break;
          case "archive":
            data = await this.service.archive(token, b);
            break;
          case "link":
            data = await this.service.link(token, b);
            break;
          case "labels": {
            const rows = await this.service.labelRows(token, b);
            const pdf = await labelPdf(rows, this.origin);
            if (pdf.length > 4 * 1024 * 1024)
              throw new AppError(
                "LABEL_LIMIT",
                413,
                "Ukuran PDF melebihi batas. Kurangi jumlah label.",
              );
            return new Response(Buffer.from(pdf), {
              headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": 'attachment; filename="label-aset.pdf"',
                "Cache-Control": "private, no-store",
                Vary: "Cookie",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
        }
      }
      return H.json({ success: true, data });
    } catch (e) {
      const err = mapAssetError(e);
      return H.json(
        {
          success: false,
          error: { code: err.code, message: err.publicMessage },
        },
        err.status,
      );
    }
  }
}
