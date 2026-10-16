"use client";
import SparkMD5 from "spark-md5";
export async function csrf() {
  const r = await fetch("/api/auth/csrf", { cache: "no-store" }),
    b = await r.json();
  if (!r.ok || !b.success)
    throw new Error("Muat ulang halaman sebelum melanjutkan.");
  return b.token as string;
}
export async function api<T>(
  path: string,
  tenant: string,
  body?: unknown,
  raw = false,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api/assets/" + path, {
    signal,
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "X-Tenant-Context": tenant,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": await csrf() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (raw && r.ok) return (await r.blob()) as T;
  const x = await r.json();
  if (!r.ok || !x.success)
    throw new Error(x.error?.message ?? "Permintaan belum berhasil.");
  return x.data as T;
}
async function drive<T>(path: string, t: string, b: unknown): Promise<T> {
  const r = await fetch("/api/drive/" + path, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Context": t,
        "X-CSRF-Token": await csrf(),
      },
      body: JSON.stringify(b),
    }),
    x = await r.json();
  if (!r.ok || !x.success)
    throw new Error(x.error?.message ?? "Unggah belum berhasil.");
  return x.data;
}
export async function uploadFile(
  file: File,
  tenant: string,
  purpose: string,
  sensitive: boolean,
  key: string,
  progress: (n: number) => void,
) {
  const md5 = new SparkMD5.ArrayBuffer();
  for (let i = 0; i < file.size; i += 1048576)
    md5.append(await file.slice(i, i + 1048576).arrayBuffer());
  const { operationId } = await drive<{ operationId: string }>(
    "start",
    tenant,
    {
      name: file.name,
      mime: file.type,
      size: file.size,
      purpose,
      sensitive,
      idempotencyKey: key,
    },
  );
  let { offset } = await drive<{ offset: number }>("recover", tenant, {
    operationId,
  });
  const c = await csrf();
  while (offset < file.size) {
    const bytes = await file.slice(offset, offset + 1048576).arrayBuffer(),
      r = await fetch(`/api/drive/chunk?id=${operationId}&offset=${offset}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Tenant-Context": tenant,
          "X-CSRF-Token": c,
        },
        body: bytes,
      }),
      x = await r.json();
    if (!r.ok || !x.success)
      throw new Error(
        x.error?.message ??
          "Unggah terputus. Coba lanjutkan setelah dua menit.",
      );
    offset = x.data.offset;
    progress(Math.floor((offset / file.size) * 100));
  }
  return drive<{ ready: boolean; fileId: string }>("finish", tenant, {
    operationId,
    md5: md5.end(),
  });
}
export async function privateBlob(
  tenant: string,
  f: { id: string; file_size: string; mime_type: string },
  preview: boolean,
) {
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < Number(f.file_size); i += 1048576) {
    const r = await fetch(
      `/api/drive/download?id=${f.id}&start=${i}&end=${Math.min(Number(f.file_size) - 1, i + 1048575)}&preview=${preview ? 1 : 0}`,
      { cache: "no-store", headers: { "X-Tenant-Context": tenant } },
    );
    if (!r.ok) {
      const x = await r.json();
      throw new Error(x.error?.message ?? "Unduh belum berhasil.");
    }
    parts.push(await r.arrayBuffer());
  }
  return new Blob(parts, { type: f.mime_type });
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const money = (value: unknown) => {
  const [n, d = "00"] = String(value ?? "0").split(".");
  return (
    "Rp " + n.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d.padEnd(2, "0")
  );
};
export const lifecycle: Record<string, string> = {
  draft: "Draf",
  available: "Tersedia",
  reserved: "Dipesan",
  on_loan: "Dipinjam",
  maintenance: "Pemeliharaan",
  disposed: "Dihapus melalui transaksi",
  archived: "Diarsipkan",
};
