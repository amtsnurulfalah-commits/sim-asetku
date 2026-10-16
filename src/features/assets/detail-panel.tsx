"use client";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminShell, Feedback } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssetForm } from "./asset-form";
import {
  api,
  money,
  lifecycle,
  saveBlob,
  privateBlob,
  uploadFile,
} from "./client";
import type { AssetDetail, Options } from "./schemas";
const historyText: Record<string, string> = {
  draft: "Draf",
  submitted: "Diajukan",
  pending: "Menunggu",
  partially_approved: "Disetujui sebagian",
  approved: "Disetujui",
  rejected: "Ditolak",
  revision_required: "Perlu revisi",
  cancelled: "Dibatalkan",
  posted: "Dibukukan",
  expense: "Beban",
  capitalization: "Kapitalisasi",
  insert: "Ditambahkan",
  update: "Diperbarui",
};
const labels: Record<string, string> = {
  area_sqm: "Luas (m²)",
  address: "Alamat",
  ownership_status: "Status kepemilikan",
  certificate_number: "Nomor sertifikat",
  rights_type: "Jenis hak",
  land_use: "Penggunaan",
  building_type: "Jenis bangunan",
  construction_year: "Tahun pembangunan",
  floor_count: "Jumlah lantai",
  construction_status: "Status pembangunan",
  vehicle_type: "Jenis kendaraan",
  manufacturing_year: "Tahun pembuatan",
  registration_number: "Nomor polisi",
  chassis_number: "Nomor rangka",
  engine_number: "Nomor mesin",
  ownership_document_number: "Nomor BPKB",
  registration_expiry: "Berlaku dokumen",
  next_service_date: "Servis berikutnya",
  started_at: "Mulai perbaikan",
  completed_at: "Selesai perbaikan",
  notes: "Catatan",
  treatment: "Perlakuan biaya",
  description: "Uraian",
  created_at: "Waktu",
  reason: "Alasan",
  from_room: "Dari ruangan",
  to_room: "Ke ruangan",
  from_condition: "Kondisi awal",
  to_condition: "Kondisi akhir",
  document_number: "Nomor dokumen",
  status: "Status",
  due_at: "Jatuh tempo",
  period: "Periode",
  amount: "Nilai penyusutan",
  book_value_after: "Nilai buku",
  action: "Tindakan",
  details: "Versi perubahan",
};
export function AssetDetailPanel({
  tenantId,
  tenantName,
  assetKey,
  publicId = false,
}: {
  tenantId: string;
  tenantName: string;
  assetKey: string;
  publicId?: boolean;
}) {
  const [data, setData] = useState<AssetDetail | null>(null),
    [options, setOptions] = useState<Options | null>(null),
    [files, setFiles] = useState<{ id: string; original_filename: string }[]>(
      [],
    ),
    [selectedFile, setSelectedFile] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [archive, setArchive] = useState(false),
    [reason, setReason] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [sensitive, setSensitive] = useState(false),
    [progress, setProgress] = useState(0),
    [qr, setQr] = useState<string | null>(null),
    [preview, setPreview] = useState<{
      url: string;
      mime: string;
      name: string;
    } | null>(null);
  const uploadKey = useRef(crypto.randomUUID());
  const fetchDetail = useCallback(
    async (signal?: AbortSignal) => {
      const [d, o] = await Promise.all([
        api<AssetDetail>(
          `detail?id=${assetKey}&public=${publicId ? 1 : 0}`,
          tenantId,
          undefined,
          false,
          signal,
        ),
        api<Options>("options", tenantId, undefined, false, signal),
      ]);
      const files = o.permissions.includes("files.download")
        ? await api<{ id: string; original_filename: string }[]>(
            "files",
            tenantId,
            undefined,
            false,
            signal,
          )
        : [];
      return { d, o, files };
    },
    [tenantId, assetKey, publicId],
  );
  const apply = useCallback(
    (result: Awaited<ReturnType<typeof fetchDetail>>) => {
      setData(result.d);
      setOptions(result.o);
      setFiles(result.files);
    },
    [],
  );
  const load = useCallback(
    async () => apply(await fetchDetail()),
    [apply, fetchDetail],
  );
  useEffect(() => {
    const controller = new AbortController();
    fetchDetail(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) apply(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [fetchDetail, apply]);
  useEffect(
    () => () => {
      if (qr) URL.revokeObjectURL(qr);
    },
    [qr],
  );
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
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const a = data?.asset,
    canEdit =
      !!a &&
      ["draft", "available"].includes(a.lifecycle_status) &&
      !!options?.permissions.includes("assets.update");
  return (
    <AdminShell title={a?.name ?? "Detail Aset"} tenant={tenantName}>
      <Feedback error={error} message={message} />
      <Link href="/aset" className="text-sm font-semibold text-teal-800">
        ← Kembali ke daftar aset
      </Link>
      {a && data && (
        <>
          <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="break-all font-mono text-sm text-slate-500">
                  {a.inventory_code}
                </p>
                <h2 className="mt-2 text-xl font-semibold">{a.name}</h2>
                <p className="mt-2 text-sm text-slate-500">
                  {a.category_name} · {lifecycle[a.lifecycle_status]}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canEdit && (
                  <Button disabled={busy} onClick={() => setEdit(true)}>
                    Edit aset
                  </Button>
                )}
                {options?.permissions.includes("assets.delete") &&
                  ["draft", "available"].includes(a.lifecycle_status) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setArchive(true)}
                    >
                      Arsipkan
                    </Button>
                  )}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const b = await api<Blob>(
                        "qr?id=" + a.id,
                        tenantId,
                        undefined,
                        true,
                      );
                      setQr(URL.createObjectURL(b));
                      return "QR siap ditampilkan.";
                    })
                  }
                >
                  QR Code
                </Button>
                {options?.permissions.includes("assets.export") && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(async () =>
                        saveBlob(
                          await api<Blob>(
                            "labels",
                            tenantId,
                            { ids: [a.id] },
                            true,
                          ),
                          "label-aset.pdf",
                        ),
                      )
                    }
                  >
                    Cetak label
                  </Button>
                )}
              </div>
            </div>
            <dl className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries({
                "Kelompok pencatatan": a.batch_count
                  ? `${a.batch_name} (${a.batch_count} unit)`
                  : "—",
                Kategori: a.category_name,
                Subkategori:
                  options?.refs.subcategories.find(
                    (s) => s.id === a.subcategory_id,
                  )?.name ?? "—",
                Satuan: a.unit_name,
                Merek: a.brand,
                Model: a.model,
                "Nomor seri": a.serial_number,
                "Tanggal perolehan": a.acquisition_date,
                "Mulai digunakan": a.in_service_date,
                "Cara perolehan": a.acquisition_method,
                "Sumber dana": a.funding_name,
                "Harga perolehan": money(a.acquisition_cost),
                "Nilai residu": money(a.residual_value),
                "Akumulasi penyusutan": money(a.accumulated_depreciation),
                "Nilai buku": money(a.book_value),
                "Umur manfaat (bulan)": a.useful_life_months,
                "Kebijakan penyusutan":
                  options?.refs.policies.find(
                    (p) => p.id === a.depreciation_policy_id,
                  )?.name ?? "Tidak diterapkan",
                Gedung: a.building_name,
                Lantai: a.floor_number,
                Ruangan: a.room_name,
                "Penanggung jawab":
                  options?.members.find(
                    (m) => m.id === a.responsible_membership_id,
                  )?.name ?? "—",
                Kondisi: a.condition_name,
                Spesifikasi: data.input.specifications,
                Keterangan: a.notes,
              }).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs font-semibold text-slate-500">{k}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
                    {String(v ?? "—")}
                  </dd>
                </div>
              ))}
            </dl>
            {Object.keys(data.detail).length > 0 && (
              <>
                <h3 className="mt-7 border-t border-slate-100 pt-5 font-semibold">
                  Detail khusus
                </h3>
                <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(data.detail)
                    .filter(([k]) => labels[k])
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs font-semibold text-slate-500">
                          {labels[k]}
                        </dt>
                        <dd className="mt-1 text-sm">
                          {v === "in_progress"
                            ? "Dalam proses"
                            : v === "complete"
                              ? "Selesai"
                              : String(v ?? "—")}
                        </dd>
                      </div>
                    ))}
                </dl>
                {!data.canSeeSensitive && (
                  <p className="mt-4 text-xs text-slate-500">
                    Nomor dokumen kepemilikan dan identitas sensitif dibatasi
                    sesuai izin.
                  </p>
                )}
              </>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold">
              Foto dan dokumen pendukung
            </h2>
            {canEdit && options?.permissions.includes("files.upload") && (
              <div className="mt-4 rounded-xl bg-slate-50 p-4">
                <label htmlFor="asset-file" className="text-sm font-medium">
                  Unggah dan kaitkan lampiran
                </label>
                <input
                  id="asset-file"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  className="mt-2 block max-w-full text-sm"
                  disabled={busy}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    uploadKey.current = crypto.randomUUID();
                  }}
                />
                <label className="mt-3 flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sensitive}
                    disabled={busy}
                    onChange={(e) => {
                      setSensitive(e.target.checked);
                      uploadKey.current = crypto.randomUUID();
                    }}
                  />
                  Dokumen sensitif
                </label>
                <p className="mt-2 text-xs text-slate-500">
                  PDF, JPEG, PNG, WebP. Unggah mengikuti batas koneksi Drive.
                  Belum dipindai antivirus.
                </p>
                <Button
                  className="mt-3"
                  disabled={busy || !file}
                  onClick={() =>
                    act(async () => {
                      if (!file) return;
                      if (file.size > 104857600)
                        throw new Error("Ukuran file melebihi batas maksimum.");
                      const purpose = file.type.startsWith("image/")
                        ? "Foto-Aset"
                        : a.asset_kind === "land"
                          ? "Tanah"
                          : a.asset_kind === "building"
                            ? "Bangunan"
                            : a.asset_kind === "vehicle"
                              ? "Kendaraan"
                              : "Aset";
                      const result = await uploadFile(
                        file,
                        tenantId,
                        purpose,
                        sensitive,
                        uploadKey.current,
                        setProgress,
                      );
                      await api("link", tenantId, {
                        assetId: a.id,
                        fileId: result.fileId,
                      });
                      setFile(null);
                      return "Lampiran tersimpan, terverifikasi, dan terkait dengan aset.";
                    })
                  }
                >
                  Unggah / Lanjutkan {busy ? progress + "%" : ""}
                </Button>
                {options.permissions.includes("files.download") && (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <select
                      aria-label="Pilih lampiran yang sudah tersedia"
                      className="field flex-1"
                      value={selectedFile}
                      onChange={(e) => setSelectedFile(e.target.value)}
                    >
                      <option value="">Atau pilih lampiran tersimpan…</option>
                      {files.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.original_filename}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      disabled={busy || !selectedFile}
                      onClick={() =>
                        act(async () => {
                          await api("link", tenantId, {
                            assetId: a.id,
                            fileId: selectedFile,
                          });
                          return "Lampiran dikaitkan.";
                        })
                      }
                    >
                      Kaitkan
                    </Button>
                  </div>
                )}
              </div>
            )}
            <ul className="mt-4 divide-y divide-slate-100">
              {data.attachments.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{f.original_filename}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {f.sensitivity === "sensitive" ? "Sensitif" : "Biasa"} ·{" "}
                      {f.status === "ready" ? "Siap" : "Tidak tersedia"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || f.status !== "ready"}
                      onClick={() =>
                        act(async () => {
                          const blob = await privateBlob(tenantId, f, true);
                          setPreview({
                            url: URL.createObjectURL(blob),
                            mime: f.mime_type,
                            name: f.original_filename,
                          });
                        })
                      }
                    >
                      Pratinjau
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || f.status !== "ready"}
                      onClick={() =>
                        act(async () =>
                          saveBlob(
                            await privateBlob(tenantId, f, false),
                            f.original_filename,
                          ),
                        )
                      }
                    >
                      Unduh
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {!data.attachments.length && (
              <p className="mt-4 text-sm text-slate-500">
                Belum ada lampiran yang dapat diakses.
              </p>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold">Riwayat aset</h2>
            {Object.entries(data.history).map(([name, records]) => (
              <details
                key={name}
                className="mt-4 rounded-xl border border-slate-200 p-4"
              >
                <summary className="cursor-pointer font-medium capitalize">
                  {name} ({records.length})
                </summary>
                {!records.length ? (
                  <p className="mt-3 text-sm text-slate-500">
                    Belum ada riwayat.
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-slate-100">
                    {records.map((r, i) => (
                      <li key={i} className="py-3 text-sm">
                        {Object.entries(r as Record<string, unknown>)
                          .filter(([k]) => labels[k])
                          .map(([k, v]) => (
                            <p key={k} className="break-words">
                              <span className="text-slate-500">
                                {labels[k]}:{" "}
                              </span>
                              {v && typeof v === "object"
                                ? "Versi " +
                                  String(
                                    (v as { row_version?: number })
                                      .row_version ?? "",
                                  )
                                : (["status","action","treatment"].includes(k)?historyText[String(v)]??String(v??"—"):String(v??"—"))}
                            </p>
                          ))}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}
          </section>
          <Dialog open={edit} onOpenChange={setEdit}>
            <DialogContent className="max-w-3xl">
              <DialogTitle className="pr-8 text-xl font-semibold">
                Edit aset
              </DialogTitle>
              <DialogDescription className="mb-5 mt-2 text-sm text-slate-500">
                Perubahan lokasi aset aktif dilakukan melalui mutasi. Data
                keuangan yang sudah dijurnal dilindungi.
              </DialogDescription>
              {options && (
                <AssetForm
                  options={options}
                  initial={data.input}
                  id={a.id}
                  rowVersion={a.row_version}
                  onCancel={() => setEdit(false)}
                  onSaved={() => {
                    setEdit(false);
                    load().catch((e) => setError(e.message));
                    setMessage("Perubahan aset tersimpan.");
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={archive} onOpenChange={setArchive}>
            <DialogContent>
              <Feedback error={error} message="" />
              <DialogTitle className="text-xl font-semibold">
                Arsipkan aset
              </DialogTitle>
              <DialogDescription className="mt-2 text-sm text-slate-500">
                Riwayat dan file dipertahankan. Arsip berbeda dari penghapusan
                melalui transaksi.
              </DialogDescription>
              <label className="mt-4 block text-sm" htmlFor="archive-reason">
                Alasan
              </label>
              <textarea
                id="archive-reason"
                className="field mt-2"
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                className="mt-4"
                disabled={busy || reason.trim().length < 3}
                onClick={() =>
                  act(async () => {
                    await api("archive", tenantId, {
                      id: a.id,
                      rowVersion: a.row_version,
                      reason,
                    });
                    setArchive(false);
                    return "Aset diarsipkan.";
                  })
                }
              >
                Simpan arsip
              </Button>
            </DialogContent>
          </Dialog>
        </>
      )}
      <Dialog
        open={!!qr || !!preview}
        onOpenChange={(open) => {
          if (!open) {
            setQr(null);
            setPreview(null);
          }
        }}
      >
        <DialogContent className={preview ? "max-w-4xl" : "max-w-md"}>
          <DialogTitle className="pr-8 font-semibold">
            {preview?.name ?? "QR Aset"}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            {preview
              ? "Lampiran privat lembaga aktif."
              : "QR membuka halaman aset dan tetap memerlukan sesi serta izin."}
          </DialogDescription>
          {qr && (
            <Image
              src={qr}
              width={512}
              height={512}
              unoptimized
              alt="QR Code aset"
              className="mx-auto mt-4 max-w-full"
            />
          )}
          {preview &&
            (preview.mime.startsWith("image/") ? (
              <Image
                src={preview.url}
                width={1200}
                height={900}
                unoptimized
                alt={preview.name}
                className="mx-auto mt-4 max-h-[65dvh] object-contain"
              />
            ) : (
              <object
                type="application/pdf"
                data={preview.url}
                className="mt-4 h-[65dvh] w-full"
              >
                <p>Gunakan Unduh jika browser belum mendukung pratinjau PDF.</p>
              </object>
            ))}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
