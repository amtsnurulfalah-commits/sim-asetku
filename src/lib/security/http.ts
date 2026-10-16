import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";
export function cookieNames(origin: string) {
  const secure = origin.startsWith("https://");
  return {
    secure,
    session: secure ? "__Host-inventaris_session" : "inventaris_session_dev",
    csrf: secure ? "__Host-inventaris_csrf" : "inventaris_csrf_dev",
  };
}
export function cookieValue(request: Request, name: string) {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  if (entries.length !== 1) return undefined;
  return entries[0].slice(name.length + 1);
}
export function cookie(
  name: string,
  value: string,
  secure: boolean,
  seconds: number,
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${secure ? "; Secure" : ""}`;
}
export function assertOrigin(request: Request, origin: string) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(
      "ORIGIN_DENIED",
      403,
      "Permintaan tidak diizinkan. Muat ulang halaman.",
    );
}
export function assertCsrf(request: Request, origin: string) {
  assertOrigin(request, origin);
  const raw = cookieValue(request, cookieNames(origin).csrf),
    header = request.headers.get("x-csrf-token");
  if (
    !raw ||
    !header ||
    !/^[0-9a-f]{64}$/.test(raw) ||
    !/^[0-9a-f]{64}$/.test(header) ||
    !timingSafeEqual(Buffer.from(raw, "hex"), Buffer.from(header, "hex"))
  )
    throw new AppError(
      "CSRF_DENIED",
      403,
      "Token halaman kedaluwarsa. Muat ulang lalu coba lagi.",
    );
}
export async function readJson(
  request: Request,
  max = 12288,
): Promise<unknown> {
  if (
    !/^application\/json(?:;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new AppError(
      "CONTENT_TYPE",
      415,
      "Format permintaan tidak didukung.",
    );
  if (Number(request.headers.get("content-length")) > max)
    throw new AppError("PAYLOAD_TOO_LARGE", 413, "Permintaan terlalu besar.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError("VALIDATION_ERROR", 400, "Permintaan tidak lengkap.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new AppError(
          "PAYLOAD_TOO_LARGE",
          413,
          "Permintaan terlalu besar.",
        );
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      400,
      "Format permintaan tidak valid.",
    );
  }
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
}
export function newCsrf() {
  return randomBytes(32).toString("hex");
}
