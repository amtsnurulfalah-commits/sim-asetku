"use client";
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
  const csrfResponse = await fetch("/api/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const csrf = await safeJson(csrfResponse);
  if (!csrfResponse.ok || !csrf.success || typeof csrf.token !== "string")
    throw new Error(
      csrf.error?.message ?? "Halaman belum dapat diproses. Coba kembali.",
    );
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf.token,
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
