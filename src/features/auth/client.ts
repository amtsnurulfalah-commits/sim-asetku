"use client";
import { csrf } from "./csrf-client";
async function safeJson(r: Response) {
  try {
    return await r.json();
  } catch {
    throw new Error("Layanan belum dapat dihubungi. Silakan coba kembali.");
  }
}
type Result = {
  success: boolean;
  next?: string;
  error?: { code: string; message: string };
};
export async function authPost(
  path: string,
  body: unknown = {},
  tenantId?: string,
): Promise<Result> {
  const csrfToken = await csrf();
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      ...(tenantId ? { "X-Tenant-Context": tenantId } : {}),
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data: Result = await safeJson(r);
  if (!r.ok || !data.success)
    throw new Error(
      data.error?.message ?? "Permintaan belum berhasil. Coba kembali.",
    );
  return data;
}
export function go(next: string | undefined) {
  window.location.replace(
    next === "/platform/lembaga"
      ? "/platform/lembaga"
      : next === "/pilih-lembaga"
        ? "/pilih-lembaga"
        : next === "/login"
          ? "/login"
          : "/dashboard",
  );
}
