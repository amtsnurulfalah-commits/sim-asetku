"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Image from "next/image";
import SparkMD5 from "spark-md5";
import { AdminShell, Feedback, readAdmin } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DriveData } from "./service";
const CHUNK = 1048576;
async function csrf() {
  const r = await fetch("/api/auth/csrf", { cache: "no-store" });
  const x = await r.json();
  if (!r.ok || !x.success)
    throw new Error("Muat ulang halaman sebelum melanjutkan.");
  return x.token as string;
}
async function post<T>(path: string, tenant: string, body: unknown) {
  const r = await fetch("/api/drive/" + path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": await csrf(),
      "X-Tenant-Context": tenant,
    },
    body: JSON.stringify(body),
  });
  const x = await r.json();
  if (!r.ok || !x.success)
    throw new Error(x.error?.message ?? "Operasi belum berhasil.");
  return x.data as T;
}
const statusLabel: Record<string, string> = {
  pending: "Menunggu",
  ready: "Siap",
  failed: "Gagal",
  retired: "Koneksi lama",
  revoked: "Dicabut",
  uploading: "Mengunggah",
  verifying: "Memverifikasi",
  quarantined: "Karantina",
  missing: "Tidak dapat diakses",
  archived: "Diarsipkan",
};
const capLabel: Record<string, string> = {
  read_metadata: "Baca metadata",
  list: "Daftar isi",
  create_file: "Buat file",
  create_folder: "Buat folder",
  cleanup: "Pembersihan",
};
export function DrivePanel({
  tenantId,
  tenantName,
  filesOnly = false,
}: {
  tenantId: string;
  tenantName: string;
  filesOnly?: boolean;
}) {
  const [data, setData] = useState<DriveData | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [folder, setFolder] = useState(""),
    [purpose, setPurpose] = useState("Dokumen-Lainnya"),
    [file, setFile] = useState<File | null>(null),
    [sensitive, setSensitive] = useState(false),
    [progress, setProgress] = useState(0),
    [preview, setPreview] = useState<{
      url: string;
      mime: string;
      name: string;
    } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(
    async () =>
      setData(
        await readAdmin<DriveData>(
          "/api/drive/" + (filesOnly ? "files" : "data"),
          undefined,
          tenantId,
        ),
      ),
    [filesOnly, tenantId],
  );
  useEffect(() => {
    let active = true;
    readAdmin<DriveData>(
      "/api/drive/" + (filesOnly ? "files" : "data"),
      undefined,
      tenantId,
    )
      .then((x) => {
        if (active) setData(x);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tenantId, filesOnly]);
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener("drive-upload-change", notify);
    window.addEventListener("storage", notify);
    return () => {
      window.removeEventListener("drive-upload-change", notify);
      window.removeEventListener("storage", notify);
    };
  }, []);
  const snapshot = useCallback(
    () => sessionStorage.getItem("drive-upload:" + tenantId) ?? "",
    [tenantId],
  );
  const rawResume = useSyncExternalStore(subscribe, snapshot, () => "");
  let resume: { id: string; name: string; size: number } | null = null;
  try {
    const value = JSON.parse(rawResume);
    if (
      typeof value?.id === "string" &&
      typeof value?.name === "string" &&
      typeof value?.size === "number"
    )
      resume = value;
  } catch {}
  function setResume(value: { id: string; name: string; size: number } | null) {
    if (value)
      sessionStorage.setItem("drive-upload:" + tenantId, JSON.stringify(value));
    else sessionStorage.removeItem("drive-upload:" + tenantId);
    window.dispatchEvent(new Event("drive-upload-change"));
  }
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage((await fn()) ?? "Operasi selesai.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operasi belum berhasil.");
    } finally {
      setBusy(false);
    }
  }
  async function upload(useResume: boolean) {
    if (!file) throw new Error("Pilih file terlebih dahulu.");
    if (data && file.size > data.maxBytes)
      throw new Error("Ukuran file melebihi batas.");
    const hash = new SparkMD5.ArrayBuffer();
    for (let i = 0; i < file.size; i += CHUNK)
      hash.append(await file.slice(i, i + CHUNK).arrayBuffer());
    const md5 = hash.end();
    let id: string,
      offset = 0;
    if (useResume) {
      if (!resume || resume.name !== file.name || resume.size !== file.size)
        throw new Error("Pilih kembali file asli yang sama.");
      id = resume.id;
      const r = await post<{ offset: number }>("recover", tenantId, {
        operationId: id,
      });
      offset = r.offset;
    } else {
      const storageKey = "drive-start:" + tenantId;
      let key = crypto.randomUUID();
      const fingerprint = JSON.stringify([
        file.name,
        file.type,
        file.size,
        purpose,
        sensitive,
        md5,
      ]);
      try {
        const old = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        if (old?.fingerprint === fingerprint) key = old.key;
      } catch {}
      sessionStorage.setItem(storageKey, JSON.stringify({ key, fingerprint }));
      const r = await post<{ operationId: string }>("start", tenantId, {
        name: file.name,
        mime: file.type,
        size: file.size,
        purpose,
        sensitive,
        idempotencyKey: key,
      });
      id = r.operationId;
      const saved = { id, name: file.name, size: file.size };
      setResume(saved);
      sessionStorage.setItem("drive-upload:" + tenantId, JSON.stringify(saved));
      const recovered = await post<{ offset: number }>("recover", tenantId, {
        operationId: id,
      });
      offset = recovered.offset;
    }
    const csrfToken = await csrf();
    while (offset < file.size) {
      const chunk = await file.slice(offset, offset + CHUNK).arrayBuffer();
      const r = await fetch(`/api/drive/chunk?id=${id}&offset=${offset}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CSRF-Token": csrfToken,
          "X-Tenant-Context": tenantId,
        },
        body: chunk,
      });
      const x = await r.json();
      if (!r.ok || !x.success)
        throw new Error(
          x.error?.message ??
            "Unggah terputus. Gunakan Lanjutkan unggah setelah dua menit.",
        );
      offset = x.data.offset;
      setProgress(Math.floor((offset / file.size) * 100));
    }
    await post("finish", tenantId, { operationId: id, md5 });
    sessionStorage.removeItem("drive-start:" + tenantId);
    sessionStorage.removeItem("drive-upload:" + tenantId);
    setResume(null);
    setFile(null);
    if (input.current) input.current.value = "";
    return "File tersimpan dan metadata Google Drive telah diverifikasi.";
  }
  async function download(f: DriveData["files"][number], show: boolean) {
    const size = Number(f.file_size),
      parts: BlobPart[] = [];
    for (let start = 0; start < size; start += CHUNK) {
      const r = await fetch(
        `/api/drive/download?id=${f.id}&start=${start}&end=${Math.min(size - 1, start + CHUNK - 1)}&preview=${show ? 1 : 0}`,
        { cache: "no-store", headers: { "X-Tenant-Context": tenantId } },
      );
      if (!r.ok) {
        let m = "File belum dapat diunduh.";
        try {
          m = (await r.json()).error.message;
        } catch {}
        throw new Error(m);
      }
      parts.push(await r.arrayBuffer());
    }
    const url = URL.createObjectURL(new Blob(parts, { type: f.mime_type }));
    if (show) setPreview({ url, mime: f.mime_type, name: f.original_filename });
    else {
      const a = document.createElement("a");
      a.href = url;
      a.download = f.original_filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return show ? "Pratinjau siap." : "Unduhan selesai.";
  }
  return (
    <AdminShell
      title={filesOnly ? "Dokumen dan Lampiran" : "Integrasi Google Drive"}
      tenant={tenantName}
    >
      <Feedback error={error} message={message} />
      {!filesOnly && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Hubungkan folder lembaga</h2>
          <p className="mt-2 text-sm text-slate-600">
            Gunakan akun layanan untuk Shared Drive atau otorisasi akun Google
            untuk My Drive. Folder tetap privat.
          </p>
          <label
            className="mt-5 block text-sm font-medium"
            htmlFor="drive-folder"
          >
            URL folder atau Folder ID
          </label>
          <input
            className="field mt-2"
            id="drive-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/…"
            disabled={busy}
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={busy || !folder}
              onClick={() =>
                act(async () => {
                  const r = await post<{ ready: boolean }>(
                    "configure",
                    tenantId,
                    { folder },
                  );
                  if (!r.ready)
                    throw new Error(
                      "Uji kemampuan belum lengkap. Periksa hasil dan izin Google Drive.",
                    );
                  return "Koneksi Google Drive berhasil diuji.";
                })
              }
            >
              Uji Shared Drive
            </Button>
            <Button
              variant="outline"
              disabled={busy || !folder}
              onClick={() =>
                act(async () => {
                  const r = await post<{ url: string }>(
                    "oauth/start",
                    tenantId,
                    { folder },
                  );
                  const u = new URL(r.url);
                  if (u.origin !== "https://accounts.google.com")
                    throw new Error("Tujuan otorisasi tidak valid.");
                  window.location.assign(u.href);
                })
              }
            >
              Otorisasi My Drive
            </Button>
          </div>
          <div className="mt-6 space-y-4">
            {data?.connections.map((c) => (
              <article
                key={c.id}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>
                    {c.root_folder_name ?? "Folder lembaga"} ·{" "}
                    {c.drive_id
                      ? "Shared Drive"
                      : "My Drive / belum terdeteksi"}
                  </strong>
                  <span>{statusLabel[c.status] ?? c.status}</span>
                </div>
                <p className="mt-2 break-all text-sm text-slate-600">
                  Folder: {c.root_folder_id}
                  <br />
                  Identitas: {c.google_identity}
                  <br />
                  Terakhir diuji:{" "}
                  {c.last_tested_at
                    ? new Date(c.last_tested_at).toLocaleString("id-ID")
                    : "Belum diuji"}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(capLabel).map(([k, v]) => (
                    <span
                      key={k}
                      className={
                        "rounded-full px-3 py-1 text-xs " +
                        (c.capabilities[k]
                          ? "bg-teal-50 text-teal-900"
                          : "bg-slate-100 text-slate-600")
                      }
                    >
                      {v}: {c.capabilities[k] ? "berhasil" : "belum berhasil"}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || ["retired", "revoked"].includes(c.status)}
                    onClick={() =>
                      act(async () => {
                        const r = await post<{ ready: boolean }>(
                          "test",
                          tenantId,
                          { connectionId: c.id },
                        );
                        return r.ready
                          ? "Seluruh kemampuan berhasil diuji."
                          : "Uji belum lengkap; koneksi belum siap.";
                      })
                    }
                  >
                    Test Koneksi Google Drive
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || c.status === "revoked"}
                    onClick={() =>
                      act(async () => {
                        const r = await post<{ remoteRevoked: boolean }>(
                          "revoke",
                          tenantId,
                          { connectionId: c.id },
                        );
                        return r.remoteRevoked
                          ? "Koneksi dinonaktifkan."
                          : "Koneksi dinonaktifkan di aplikasi. Cabut juga akses aplikasi melalui akun Google.";
                      })
                    }
                  >
                    Cabut koneksi
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              disabled={
                busy || !data?.connections.some((c) => c.status === "ready")
              }
              onClick={() =>
                act(async () => {
                  await post("initialize", tenantId, {});
                  return "Lima belas subfolder telah diinisialisasi.";
                })
              }
            >
              Inisialisasi subfolder
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await post<{
                    checked: number;
                    missing: number;
                    cleaned: number;
                    orphans: number;
                    changed: number;
                  }>("reconcile", tenantId, {});
                  return `Rekonsiliasi: ${r.checked} diperiksa, ${r.missing} tidak dapat diakses, ${r.changed} berubah, ${r.cleaned} objek uji dibersihkan, ${r.orphans} file tanpa metadata.`;
                })
              }
            >
              Rekonsiliasi
            </Button>
          </div>
        </section>
      )}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">Unggah dokumen</h2>
        <p className="mt-2 text-sm text-slate-600">
          PDF, JPEG, PNG, WebP. Batas{" "}
          {Math.floor((data?.maxBytes ?? 20971520) / 1048576)} MiB. File belum
          dipindai antivirus.
        </p>
        <label htmlFor="purpose" className="mt-4 block text-sm">
          Jenis dokumen
        </label>
        <select
          id="purpose"
          className="field mt-2"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          disabled={busy}
        >
          {(data?.purposes ?? ["Dokumen-Lainnya"]).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label className="mt-4 block text-sm" htmlFor="upload-file">
          Pilih file
        </label>
        <input
          ref={input}
          id="upload-file"
          className="mt-2 block max-w-full text-sm"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setProgress(0);
          }}
        />
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
            disabled={busy}
          />
          Dokumen sensitif
        </label>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            disabled={busy || !file}
            onClick={() => act(() => upload(false))}
          >
            Unggah dan verifikasi
          </Button>
          {resume && (
            <Button
              variant="outline"
              disabled={busy || !file}
              onClick={() => act(() => upload(true))}
            >
              Lanjutkan unggah {resume.name}
            </Button>
          )}
        </div>
        {busy && (
          <p role="status" className="mt-3 text-sm">
            Memproses… {progress}%
          </p>
        )}
      </section>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">Lampiran terbaru</h2>
        <p className="mt-2 text-xs text-slate-500">
          Menampilkan paling banyak 100 file terbaru.
        </p>
        <ul className="mt-4 divide-y divide-slate-100">
          {data?.files.map((f) => (
            <li
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div>
                <p className="break-all font-medium">{f.original_filename}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {statusLabel[f.status] ?? f.status} ·{" "}
                  {(Number(f.file_size) / 1024).toFixed(1)} KiB ·{" "}
                  {new Date(f.created_at).toLocaleString("id-ID")} ·{" "}
                  {f.sensitivity === "sensitive" ? "Sensitif" : "Biasa"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy || f.status !== "ready"}
                  onClick={() => act(() => download(f, true))}
                >
                  Pratinjau
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || f.status !== "ready"}
                  onClick={() => act(() => download(f, false))}
                >
                  Unduh
                </Button>
                {!filesOnly && (
                  <Button
                    variant="outline"
                    disabled={busy || f.status === "archived"}
                    onClick={() =>
                      act(async () => {
                        await post("archive", tenantId, { fileId: f.id });
                        return "File diarsipkan. Isi Google Drive tetap dipertahankan.";
                      })
                    }
                  >
                    Arsipkan
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {data?.files.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">Belum ada lampiran.</p>
        )}
      </section>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogTitle className="pr-8 font-semibold">
            {preview?.name}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            Pratinjau file privat lembaga aktif.
          </DialogDescription>
          {preview?.mime.startsWith("image/") ? (
            <Image
              unoptimized
              width={1200}
              height={900}
              src={preview.url}
              alt={preview.name}
              className="mx-auto mt-4 max-h-[65dvh] object-contain"
            />
          ) : (
            preview && (
              <object
                type="application/pdf"
                data={preview.url}
                title={preview.name}
                className="mt-4 h-[65dvh] w-full"
              >
                <p>
                  Browser belum mendukung pratinjau PDF. Gunakan tombol Unduh.
                </p>
              </object>
            )
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
