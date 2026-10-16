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
import {
  privateBlob,
  saveBlob,
  uploadFile,
  api as assetApi,
  money,
} from "@/features/assets/client";
import { supplyApi } from "./client";
import { DocumentForm } from "./document-form";
import {DocumentApproval} from "@/features/approval/document-status";
import { kindText, statusText, type Detail, type Options } from "./schemas";
const actions: Record<string, string> = {
  submit: "Ajukan",
  review: "Mulai review",
  approve: "Setujui",
  reject: "Tolak",
  revision: "Minta revisi",
  cancel: "Batalkan",
  post: "Posting",
  save: "Simpan draf",
};
export function SupplyDetail({
  tenantId,
  tenantName,
  id,
  membershipId,
}: {
  tenantId: string;
  tenantName: string;
  id: string;
  membershipId: string;
}) {
  const [data, setData] = useState<Detail | null>(null),
    [o, setO] = useState<Options | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState<string | null>(null),
    [reason, setReason] = useState(""),
    [edit, setEdit] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [sensitive, setSensitive] = useState(false),
    [progress, setProgress] = useState(0),
    [files, setFiles] = useState<{ id: string; original_filename: string }[]>(
      [],
    ),
    [fileId, setFileId] = useState(""),
    [preview, setPreview] = useState<{
      url: string;
      mime: string;
      name: string;
    } | null>(null);
  const key = useRef(crypto.randomUUID()),
    postKey = useRef(crypto.randomUUID());
  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      const [d, opts] = await Promise.all([
        supplyApi<Detail>("detail?id=" + id, tenantId, undefined, signal),
        supplyApi<Options>("options", tenantId, undefined, signal),
      ]);
      const choices = opts.permissions.includes("files.download")
        ? await assetApi<{ id: string; original_filename: string }[]>(
            "files",
            tenantId,
            undefined,
            false,
            signal,
          )
        : [];
      return { d, opts, choices };
    },
    [id, tenantId],
  );
  const apply = useCallback((r: Awaited<ReturnType<typeof fetchData>>) => {
    setData(r.d);
    setO(r.opts);
    setFiles(r.choices);
  }, []);
  const load = useCallback(
    async () => apply(await fetchData()),
    [fetchData, apply],
  );
  useEffect(() => {
    const c = new AbortController();
    fetchData(c.signal)
      .then((r) => {
        if (!c.signal.aborted) apply(r);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [fetchData, apply]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function act(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    try {
      setMessage((await fn()) ?? "Operasi selesai.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const d = data?.doc,
    owner = d?.requested_by === membershipId,
    permission =
      d &&
      (d.kind === "request" || d.kind === "order"
        ? "procurement.manage"
        : d.kind === "issue"
          ? "inventory.issue"
          : d.kind === "adjustment"
            ? "inventory.adjust"
            : "inventory.receive"),
    canWrite = !!permission && !!o?.permissions.includes(permission),
    reviewer = !!o?.permissions.includes("approval.manage") && !owner;
  const available: string[] = [];
  if (d) {
    if (owner && canWrite && d.status === "draft") available.push("submit");
    if (
      owner &&
      canWrite &&
      [
        "draft",
        "submitted",
        "pending",
        "partially_approved",
        "revision_required",
        "rejected",
      ].includes(d.status)
    )
      available.push("cancel");
    if (reviewer && d.review_mode_snapshot!=='engine_v1' && d.status === "submitted") available.push("review");
    if (reviewer && d.review_mode_snapshot!=='engine_v1' && d.status === "pending")
      available.push("approve", "reject", "revision");
    if (reviewer && d.review_mode_snapshot!=="engine_v1" && d.status==="approved") available.push("revision");
    if (
      canWrite &&
      d.status === "approved" &&
      !["request", "order"].includes(d.kind)
    )
      available.push("post");
  }
  const rowLabels: Record<string, string> = {
    description: "Uraian",
    name: "Barang",
    quantity: "Jumlah",
    estimated_unit_cost: "Perkiraan harga",
    unit_cost: "Harga satuan",
    received_quantity: "Diterima baik kumulatif",
    accepted_quantity: "Diterima baik",
    room_name: "Ruangan",
    quantity_delta: "Perubahan jumlah",
    inspection_notes: "Hasil pemeriksaan",
    unit_name: "Satuan",
  };
  return (
    <AdminShell
      title={d ? kindText[d.kind] : "Detail Dokumen"}
      tenant={tenantName}
    >
      <Feedback error={error} message={message} />
      {d&&o?.permissions.includes("approval.access")&&<DocumentApproval tenantId={tenantId} id={id} version={d.row_version}/>}
      <Link href="/pengadaan" className="text-sm font-semibold text-teal-800">
        ← Daftar dokumen
      </Link>
      {d && data && o && (
        <>
          <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-sm text-slate-500">
                  {d.document_number}
                </p>
                <h2 className="mt-2 text-xl font-semibold">
                  {statusText[d.status]}
                </h2>
                <p className="mt-2 text-sm">
                  Tanggal: {d.business_date} · Revisi {d.revision}
                </p>
                <p className="mt-2 text-sm text-slate-600">{d.reason}</p>
                {d.total_amount !== null && (
                  <p className="mt-3 font-semibold">
                    Total pengadaan: {money(d.total_amount)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {owner &&
                  canWrite &&
                  ["draft", "revision_required"].includes(d.status) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setEdit(true)}
                    >
                      Edit draf / revisi
                    </Button>
                  )}
                {available.map((a) => (
                  <Button
                    key={a}
                    variant={a === "post" ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => {
                      setReason("");
                      setAction(a);
                    }}
                  >
                    {actions[a]}
                  </Button>
                ))}
              </div>
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Draf dan approval belum mengubah saldo. Posting penerimaan atau
              transaksi stok baru mengubah ledger secara atomik.
            </p>
            {data.related.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-semibold">Dokumen terkait</h3>
                <div className="mt-2 flex flex-wrap gap-3">
                  {data.related.map((link) => (
                    <Link
                      className="text-sm text-teal-800"
                      key={link.id}
                      href={"/pengadaan/" + link.id}
                    >
                      {link.document_number} · {statusText[link.status]}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {data.lines.map((l, i) => (
                <article
                  key={l.id}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <h3 className="mb-3 text-sm font-semibold">Baris {i + 1}</h3>
                  <dl className="space-y-2 text-sm">
                    {Object.entries(rowLabels)
                      .filter(([k]) => l[k] !== undefined)
                      .map(([k, label]) => (
                        <div key={k}>
                          <dt className="text-xs text-slate-500">{label}</dt>
                          <dd>
                            {k.includes("cost")
                              ? money(l[k])
                              : String(l[k] ?? "—")}
                          </dd>
                        </div>
                      ))}
                    {Array.isArray(l.created_assets) &&
                      l.created_assets.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs text-slate-500">
                            Aset hasil penerimaan
                          </p>
                          {(
                            l.created_assets as {
                              id: string;
                              inventory_code: string;
                              name: string;
                            }[]
                          ).map((asset) => (
                            <Link
                              key={asset.id}
                              className="mt-1 block text-xs text-teal-800"
                              href={"/aset/" + asset.id}
                            >
                              {asset.inventory_code} · {asset.name}
                            </Link>
                          ))}
                        </div>
                      )}
                    {!!l.destination_kind && (
                      <p className="text-xs font-semibold text-teal-800">
                        {l.destination_kind === "asset"
                          ? "Aset individual"
                          : "Persediaan"}
                      </p>
                    )}
                  </dl>
                </article>
              ))}
            </div>
          </section>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold">
              Dokumen pendukung Google Drive
            </h2>
            {canWrite && o.permissions.includes("files.upload") && (
              <div className="mt-4 rounded-xl bg-slate-50 p-4">
                <label htmlFor="supply-file" className="text-sm">
                  Unggah lampiran
                </label>
                <input
                  id="supply-file"
                  type="file"
                  className="mt-2 block max-w-full text-sm"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  disabled={busy}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    key.current = crypto.randomUUID();
                  }}
                />
                <label className="mt-3 flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sensitive}
                    disabled={busy}
                    onChange={(e) => {
                      setSensitive(e.target.checked);
                      key.current = crypto.randomUUID();
                    }}
                  />
                  Dokumen sensitif
                </label>
                <Button
                  className="mt-4"
                  disabled={busy || !file}
                  onClick={() =>
                    act(async () => {
                      if (!file) return;
                      if (file.size > 104857600)
                        throw new Error("Ukuran file melebihi batas maksimum.");
                      const r = await uploadFile(
                        file,
                        tenantId,
                        d.kind === "receipt" ? "Penerimaan" : "Pengadaan",
                        sensitive,
                        key.current,
                        setProgress,
                      );
                      await supplyApi("link", tenantId, {
                        documentId: id,
                        fileId: r.fileId,
                      });
                      setFile(null);
                      return "Lampiran tersimpan dan terkait dengan dokumen.";
                    })
                  }
                >
                  Unggah / lanjutkan {busy ? progress + "%" : ""}
                </Button>
                <p className="mt-2 text-xs text-slate-500">
                  File mengikuti whitelist dan batas Drive. Belum dipindai
                  antivirus.
                </p>
                {o.permissions.includes("files.download") && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <select
                      className="field flex-1"
                      aria-label="Pilih dokumen tersimpan"
                      value={fileId}
                      onChange={(e) => setFileId(e.target.value)}
                    >
                      <option value="">Pilih file yang sudah tersedia…</option>
                      {files.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.original_filename}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      disabled={busy || !fileId}
                      onClick={() =>
                        act(async () => {
                          await supplyApi("link", tenantId, {
                            documentId: id,
                            fileId,
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
                  className="flex flex-wrap justify-between gap-3 py-3"
                  key={f.id}
                >
                  <p className="text-sm">
                    {f.original_filename} ·{" "}
                    {f.sensitivity === "sensitive" ? "Sensitif" : "Biasa"}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy || f.status !== "ready"}
                      onClick={() =>
                        act(async () =>
                          setPreview({
                            url: URL.createObjectURL(
                              await privateBlob(tenantId, f, true),
                            ),
                            mime: f.mime_type,
                            name: f.original_filename,
                          }),
                        )
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
              <p className="mt-3 text-sm text-slate-500">
                Belum ada lampiran yang dapat diakses.
              </p>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-lg font-semibold">
              Riwayat keputusan dan posting
            </h2>
            <ul className="mt-4 divide-y divide-slate-100">
              {data.events.map((e, i) => (
                <li key={i} className="py-3 text-sm">
                  <strong>{actions[e.action] ?? e.action}</strong>
                  <p className="mt-1 text-slate-600">{e.reason}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(e.created_at).toLocaleString("id-ID")}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <Dialog
            open={!!action}
            onOpenChange={(v) => {
              if (!v && !busy) setAction(null);
            }}
          >
            <DialogContent>
              <DialogTitle className="text-xl font-semibold">
                {actions[action ?? ""]} dokumen
              </DialogTitle>
              <DialogDescription className="mt-2 text-sm text-slate-500">
                {action === "post"
                  ? "Posting mengubah saldo atau membuat aset sesuai penerimaan yang disetujui. Transaksi yang dibukukan tidak dapat diedit; koreksi memakai dokumen baru."
                  : "Keputusan diperiksa ulang terhadap versi terbaru dan dicatat dalam audit."}
              </DialogDescription>
              <Feedback error={error} message="" />
              {action !== "post" && (
                <>
                  <label
                    className="mt-4 block text-sm"
                    htmlFor="decision-reason"
                  >
                    Alasan
                  </label>
                  <textarea
                    id="decision-reason"
                    className="field mt-2"
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </>
              )}
              <Button
                className="mt-5"
                disabled={
                  busy || (action !== "post" && reason.trim().length < 3)
                }
                onClick={() =>
                  act(async () => {
                    if (action === "post")
                      await supplyApi("post", tenantId, {
                        id,
                        idempotencyKey: postKey.current,
                      });
                    else
                      await supplyApi("transition", tenantId, {
                        id,
                        rowVersion: d.row_version,
                        action,
                        reason,
                      });
                    setAction(null);
                    return "Dokumen berhasil diperbarui.";
                  })
                }
              >
                {busy ? "Memproses…" : "Jalankan"}
              </Button>
            </DialogContent>
          </Dialog>
          <Dialog open={edit} onOpenChange={setEdit}>
            <DialogContent className="max-w-4xl">
              <DialogTitle className="text-xl font-semibold">
                Edit {kindText[d.kind]}
              </DialogTitle>
              <DialogDescription className="mb-5 mt-2 text-sm text-slate-500">
                Simpan akan membuat revisi dokumen. Perubahan harus diajukan
                kembali untuk review.
              </DialogDescription>
              <DocumentForm
                kind={d.kind}
                options={o}
                initial={{
                  ...(d.input_snapshot as Record<string, unknown>),
                  id: d.id,
                  rowVersion: d.row_version,
                  idempotencyKey: crypto.randomUUID(),
                }}
                onCancel={() => setEdit(false)}
                onSaved={() => {
                  setEdit(false);
                  load().catch((e) => setError(e.message));
                }}
              />
            </DialogContent>
          </Dialog>
        </>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(v) => {
          if (!v) setPreview(null);
        }}
      >
        <DialogContent className="max-w-4xl">
          <DialogTitle className="font-semibold">{preview?.name}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            Lampiran privat lembaga aktif.
          </DialogDescription>
          {preview &&
            (preview.mime.startsWith("image/") ? (
              <Image
                unoptimized
                src={preview.url}
                alt={preview.name}
                width={1200}
                height={900}
                className="mx-auto mt-4 max-h-[65dvh] object-contain"
              />
            ) : (
              <object
                type="application/pdf"
                data={preview.url}
                className="mt-4 h-[65dvh] w-full"
              >
                <p>Gunakan Unduh jika pratinjau tidak didukung.</p>
              </object>
            ))}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
