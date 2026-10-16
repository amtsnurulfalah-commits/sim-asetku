"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminShell, Feedback, Pager } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/features/assets/client";
import { supplyApi } from "./client";
import { DocumentForm } from "./document-form";
import {
  kinds,
  kindText,
  statusText,
  type Kind,
  type Options,
  type DocumentRow,
} from "./schemas";
export function DocumentsPanel({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const [o, setO] = useState<Options | null>(null),
    [kind, setKind] = useState<Kind>("request"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [rows, setRows] = useState<{ items: DocumentRow[]; total: number } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [mode, setMode] = useState("disabled"),
    [reason, setReason] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const opts = await supplyApi<Options>(
        "options",
        tenantId,
        undefined,
        signal,
      );
      const allowedKind =
        !opts.permissions.includes("procurement.manage") &&
        ["request", "order"].includes(kind)
          ? "receipt_stock"
          : kind;
      if (allowedKind !== kind) {
        setKind(allowedKind);
        return;
      }
      const data = await supplyApi<{ items: DocumentRow[]; total: number }>(
        "documents?" +
          new URLSearchParams({ kind, status, query, page: String(page) }),
        tenantId,
        undefined,
        signal,
      );
      if (signal?.aborted) return;
      setO(opts);
      setMode(opts.reviewMode);
      setRows(data);
    },
    [kind, status, query, page, tenantId],
  );
  useEffect(() => {
    const c = new AbortController(),
      timer = setTimeout(
        () =>
          load(c.signal).catch((e) => {
            if (!c.signal.aborted) setError(e.message);
          }),
        250,
      );
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [load]);
  const required =
    kind === "request" || kind === "order"
      ? "procurement.manage"
      : kind === "issue"
        ? "inventory.issue"
        : kind === "adjustment"
          ? "inventory.adjust"
          : "inventory.receive";
  return (
    <AdminShell title="Pengadaan dan Transaksi Stok" tenant={tenantName}>
      <Feedback error={error} message={message} />
      <Link href="/persediaan" className="text-sm font-semibold text-teal-800">
        Saldo, kartu stok dan laporan penggunaan
      </Link>
      {o?.reviewMode === "disabled" && (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Kebijakan review belum diaktifkan. Draf dapat disiapkan, tetapi
          pengajuan dan posting belum dapat dilakukan.
        </p>
      )}
      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-6">
        <div className="grid items-end gap-3 md:grid-cols-4">
          <div>
            <label htmlFor="doc-kind" className="text-sm">
              Jenis dokumen
            </label>
            <select
              id="doc-kind"
              className="field mt-2"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                setPage(1);
              }}
            >
              {kinds
                .filter(
                  (k) =>
                    o?.permissions.includes("procurement.manage") ||
                    !["request", "order"].includes(k),
                )
                .map((k) => (
                  <option key={k} value={k}>
                    {kindText[k]}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label htmlFor="doc-query" className="text-sm">
              Cari nomor / keperluan
            </label>
            <input
              id="doc-query"
              className="field mt-2"
              maxLength={120}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div>
            <label htmlFor="doc-status" className="text-sm">
              Status
            </label>
            <select
              id="doc-status"
              className="field mt-2"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Semua</option>
              {Object.entries(statusText).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {o?.permissions.includes(required) && (
            <Button disabled={busy} onClick={() => setOpen(true)}>
              Buat draf
            </Button>
          )}
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-slate-500">
                {[
                  "Nomor / keperluan",
                  "Tanggal",
                  "Status",
                  "Nilai pengadaan",
                ].map((t) => (
                  <th key={t} className="p-3">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows?.items.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="p-3">
                    <Link
                      className="font-semibold text-teal-800"
                      prefetch={false}
                      href={"/pengadaan/" + d.id}
                    >
                      {d.document_number}
                    </Link>
                    <p className="mt-1 text-xs text-slate-500">{d.reason}</p>
                  </td>
                  <td className="p-3">{d.business_date}</td>
                  <td className="p-3">{statusText[d.status] ?? d.status}</td>
                  <td className="p-3">
                    {d.total_amount === null ? "—" : money(d.total_amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows?.items.length === 0 && (
            <p className="p-4 text-sm text-slate-500">
              Belum ada dokumen sesuai pencarian.
            </p>
          )}
        </div>
        <Pager
          page={page}
          total={rows?.total ?? 0}
          onPage={setPage}
          disabled={busy}
        />
      </section>
      {o?.permissions.includes("settings.manage") && (
        <details className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <summary className="cursor-pointer font-semibold">
            Kebijakan review Tahap 7
          </summary>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Review satu admin yang berbeda dari pembuat dokumen. Ini kebijakan
            terbatas untuk tahap ini; workflow umum yang sudah dikonfigurasi
            tidak akan dilewati. Mengubah kebijakan tidak membatalkan dokumen
            yang sudah disetujui.
          </p>
          <form
            className="mt-4 space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await supplyApi("policy", tenantId, { mode, reason });
                setMessage("Kebijakan review disimpan dan diaudit.");
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor="review-mode" className="block text-sm">
              Mode review
            </label>
            <select
              id="review-mode"
              className="field"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="disabled">Nonaktifkan pengajuan baru</option>
              <option value="single_admin_v1">Satu admin independen</option>
            </select>
            <label htmlFor="policy-reason" className="block text-sm">
              Alasan kebijakan
            </label>
            <input
              id="policy-reason"
              className="field"
              value={reason}
              minLength={3}
              maxLength={1000}
              required
              onChange={(e) => setReason(e.target.value)}
            />
            <Button disabled={busy}>Simpan kebijakan</Button>
          </form>
        </details>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogTitle className="pr-8 text-xl font-semibold">
            {kindText[kind]}
          </DialogTitle>
          <DialogDescription className="mb-5 mt-2 text-sm text-slate-500">
            Draf belum mengubah saldo. Dokumen harus ditinjau dan disetujui
            sebelum posting.
          </DialogDescription>
          {o && (
            <DocumentForm
              kind={kind}
              options={o}
              onCancel={() => setOpen(false)}
              onSaved={(id) => window.location.assign("/pengadaan/" + id)}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
