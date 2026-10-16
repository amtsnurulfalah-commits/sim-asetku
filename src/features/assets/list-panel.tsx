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
import { AssetForm } from "./asset-form";
import { api, money, lifecycle, saveBlob } from "./client";
import type { AssetRow, Options } from "./schemas";
export function AssetList({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const [options, setOptions] = useState<Options | null>(null),
    [data, setData] = useState<{ items: AssetRow[]; total: number } | null>(
      null,
    ),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [room, setRoom] = useState(""),
    [condition, setCondition] = useState(""),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const params = new URLSearchParams({ query, status, page: String(page) });
      if (category) params.set("category", category);
      if (room) params.set("room", room);
      if (condition) params.set("condition", condition);
      const [o, d] = await Promise.all([
        api<Options>("options", tenantId, undefined, false, signal),
        api<{ items: AssetRow[]; total: number }>(
          "list?" + params,
          tenantId,
          undefined,
          false,
          signal,
        ),
      ]);
      if (signal?.aborted) return;
      setOptions(o);
      setData(d);
    },
    [tenantId, query, status, page, category, room, condition],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        load(controller.signal).catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        }),
      250,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  async function labels(filtered: boolean) {
    setBusy(true);
    setError("");
    try {
      const blob = await api<Blob>(
        "labels",
        tenantId,
        filtered
          ? { category: category || null, room: room || null }
          : { ids: selected },
        true,
      );
      saveBlob(blob, "label-aset.pdf");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminShell title="Aset Tetap" tenant={tenantName}>
      <Feedback error={error} message={message} />
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap justify-between gap-3">
          <p className="text-sm text-slate-500">
            Satu unit, satu kode inventaris, satu QR.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/pindai"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-teal-800"
            >
              Pindai QR
            </Link>
            {options?.permissions.includes("assets.create") && (
              <Button onClick={() => setOpen(true)}>Tambah aset</Button>
            )}
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="asset-search" className="text-xs text-slate-500">
              Cari nama, kode, nomor seri
            </label>
            <input
              id="asset-search"
              className="field mt-2"
              maxLength={120}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {(
            [
              [
                "category",
                "Kategori",
                category,
                setCategory,
                options?.refs.categories,
              ],
              ["room", "Ruangan", room, setRoom, options?.refs.rooms],
              [
                "condition",
                "Kondisi",
                condition,
                setCondition,
                options?.refs.conditions,
              ],
            ] as const
          ).map(([key, label, value, setter, refs]) => (
            <div key={key}>
              <label
                htmlFor={"asset-" + key}
                className="text-xs text-slate-500"
              >
                {label}
              </label>
              <select
                id={"asset-" + key}
                className="field mt-2"
                value={value}
                onChange={(e) => {
                  setter(e.target.value);
                  setPage(1);
                  setSelected([]);
                }}
              >
                <option value="">Semua</option>
                {refs?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div>
            <label htmlFor="asset-status" className="text-xs text-slate-500">
              Status
            </label>
            <select
              id="asset-status"
              className="field mt-2"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Semua</option>
              {Object.entries(lifecycle).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="p-3">Pilih</th>
                <th className="p-3">Kode / Aset</th>
                <th className="p-3">Kategori / Lokasi</th>
                <th className="p-3">Kondisi / Status</th>
                <th className="p-3">Nilai buku</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={"Pilih " + a.name}
                      checked={selected.includes(a.id)}
                      disabled={
                        a.lifecycle_status === "archived" ||
                        (!selected.includes(a.id) && selected.length >= 100)
                      }
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked
                            ? [...s, a.id]
                            : s.filter((id) => id !== a.id),
                        )
                      }
                    />
                  </td>
                  <td className="p-3">
                    <Link
                      href={"/aset/" + a.id}
                      prefetch={false}
                      className="font-semibold text-teal-800"
                    >
                      {a.name}
                    </Link>
                    <p className="mt-1 whitespace-nowrap font-mono text-xs text-slate-500">
                      {a.inventory_code}
                    </p>
                  </td>
                  <td className="p-3">
                    {a.category_name}
                    <p className="mt-1 text-xs text-slate-500">
                      {a.room_name ?? "Belum ditempatkan"}
                    </p>
                  </td>
                  <td className="p-3">
                    {a.condition_name}
                    <p className="mt-1 text-xs text-slate-500">
                      {lifecycle[a.lifecycle_status]}
                    </p>
                  </td>
                  <td className="whitespace-nowrap p-3">
                    {money(a.book_value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.items.length === 0 && (
            <p className="p-6 text-sm text-slate-500">
              Belum ada aset sesuai pencarian.
            </p>
          )}
        </div>
        <Pager
          page={page}
          total={data?.total ?? 0}
          onPage={setPage}
          disabled={busy}
        />
        {options?.permissions.includes("assets.export") && (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy || !selected.length}
              onClick={() => labels(false)}
            >
              Cetak {selected.length} label terpilih
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => labels(true)}
            >
              Label menurut kategori / ruangan
            </Button>
            <p className="w-full text-xs text-slate-500">
              PDF A4, skala cetak 100%. Cetak menurut kategori/ruangan memakai
              kedua filter tersebut; maksimal 100 aset.
            </p>
          </div>
        )}
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogTitle className="pr-8 text-xl font-semibold">
            Tambah aset
          </DialogTitle>
          <DialogDescription className="mb-5 mt-2 text-sm text-slate-500">
            Nomor inventaris dibuat otomatis. Batch menghasilkan record terpisah
            untuk tiap unit.
          </DialogDescription>
          {options && (
            <AssetForm
              options={options}
              onCancel={() => setOpen(false)}
              onSaved={() => {
                setOpen(false);
                setMessage("Aset berhasil dicatat.");
                load().catch((e) => setError(e.message));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
