"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminShell, Feedback, Pager } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Field, type FieldDef } from "@/features/assets/fields";
import { money } from "@/features/assets/client";
import { supplyApi } from "./client";
import type { Options, Ref } from "./schemas";
export function StockPanel({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const [o, setO] = useState<Options | null>(null),
    [data, setData] = useState<{ items: Ref[]; total: number } | null>(null),
    [query, setQuery] = useState(""),
    [room, setRoom] = useState(""),
    [low, setLow] = useState(false),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [master, setMaster] = useState<{
      kind: "item" | "supplier";
      value: Record<string, unknown>;
    } | null>(null),
    [card, setCard] = useState<{
      item: Ref;
      entries: Ref[];
      total: number;
      page: number;
    } | null>(null),
    [cardPage, setCardPage] = useState(1),
    [cardId, setCardId] = useState(""),
    [usage, setUsage] = useState<{
      items: Ref[];
      total: number;
      page: number;
    } | null>(null),
    [usagePage, setUsagePage] = useState(1),
    [from, setFrom] = useState(new Date().getFullYear() + "-01-01"),
    [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [opts, rows] = await Promise.all([
        supplyApi<Options>("options", tenantId, undefined, signal),
        supplyApi<{ items: Ref[]; total: number }>(
          "balances?" +
            new URLSearchParams({
              query,
              room,
              low: low ? "1" : "0",
              page: String(page),
            }),
          tenantId,
          undefined,
          signal,
        ),
      ]);
      if (signal?.aborted) return;
      setO(opts);
      setData(rows);
    },
    [tenantId, query, room, low, page],
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
  useEffect(() => {
    if (!cardId) return;
    const c = new AbortController();
    supplyApi<{ item: Ref; entries: Ref[]; total: number; page: number }>(
      "card?" +
        new URLSearchParams({
          itemId: cardId,
          roomId: room,
          page: String(cardPage),
        }),
      tenantId,
      undefined,
      c.signal,
    )
      .then(setCard)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [cardId, cardPage, room, tenantId]);
  const defs: FieldDef[] =
    master?.kind === "supplier"
      ? [
          { key: "code", label: "Kode", required: true },
          { key: "name", label: "Nama penyedia", required: true },
        ]
      : [
          { key: "code", label: "Kode", required: true },
          { key: "name", label: "Nama barang", required: true },
          {
            key: "unitId",
            label: "Satuan dasar",
            type: "select",
            required: true,
            options: o?.units
              .filter((x) => x.status === "active")
              .map((x) => ({ value: x.id, label: x.name })),
          },
          {
            key: "categoryId",
            label: "Kategori persediaan",
            type: "select",
            required: true,
            options: o?.categories
              .filter((x) => x.status === "active")
              .map((x) => ({ value: x.id, label: x.name })),
          },
          {
            key: "minimumStock",
            label: "Stok minimum",
            required: true,
            hint: "Satuan dasar; maksimal 6 angka desimal.",
          },
        ];
  defs.push({
    key: "status",
    label: "Status",
    type: "select",
    required: true,
    options: [
      { value: "active", label: "Aktif" },
      { value: "archived", label: "Arsip" },
    ],
  });
  async function loadUsage(p: number) {
    setBusy(true);
    setError("");
    try {
      const report = await supplyApi<{
        items: Ref[];
        total: number;
        page: number;
      }>(
        "usage?" +
          new URLSearchParams({ from, to, roomId: room, page: String(p) }),
        tenantId,
      );
      setUsage(report);
      setUsagePage(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openMaster(kind: "item" | "supplier", r?: Ref) {
    setError("");
    setMaster({
      kind,
      value: {
        id: r?.id ?? null,
        rowVersion: r?.row_version ?? null,
        code: r?.code ?? "",
        name: r?.name ?? "",
        status: r?.status ?? "active",
        unitId: r?.unit_id ?? "",
        categoryId: r?.category_id ?? "",
        minimumStock: String(r?.minimum_stock ?? "0"),
      },
    });
  }
  return (
    <AdminShell title="Persediaan dan Nilai Stok" tenant={tenantName}>
      <Feedback error={error} message={message} />
      <div className="mb-5 flex flex-wrap gap-3">
        <Link
          href="/pengadaan"
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-teal-800"
        >
          Pengadaan dan transaksi stok
        </Link>
        {o?.permissions.includes("settings.manage") && (
          <>
            <Button onClick={() => openMaster("item")}>Tambah barang</Button>
            <Button variant="outline" onClick={() => openMaster("supplier")}>
              Tambah penyedia
            </Button>
          </>
        )}
      </div>
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="grid items-end gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="stock-query" className="text-sm">
              Cari barang
            </label>
            <input
              id="stock-query"
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
            <label htmlFor="stock-room" className="text-sm">
              Ruangan
            </label>
            <select
              id="stock-room"
              className="field mt-2"
              value={room}
              onChange={(e) => {
                setRoom(e.target.value);setUsage(null);setUsagePage(1);
                setPage(1);
              }}
            >
              <option value="">Semua ruangan</option>
              {o?.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-3 text-sm">
            <input
              type="checkbox"
              checked={low}
              onChange={(e) => {
                setLow(e.target.checked);
                setPage(1);
              }}
            />
            Hanya stok rendah
          </label>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Nilai memakai rata-rata tertimbang berjalan per barang/ruangan. Stok
          minimum dibandingkan dengan saldo pada cakupan ruangan yang dipilih.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-slate-500">
                {[
                  "Barang",
                  "Saldo",
                  "Minimum",
                  "Nilai persediaan",
                  "Tindakan",
                ].map((x) => (
                  <th className="p-3" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="p-3">
                    <strong>{r.name}</strong>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      {r.code}
                    </p>
                    {!!r.low_stock && (
                      <span className="text-xs font-semibold text-amber-700">
                        Stok rendah
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {String(r.quantity)} {String(r.unit_name)}
                  </td>
                  <td className="p-3">{String(r.minimum_stock)}</td>
                  <td className="whitespace-nowrap p-3">
                    {money(r.stock_value)}
                  </td>
                  <td className="p-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCardPage(1);
                        setCardId(r.id);
                      }}
                    >
                      Kartu stok
                    </Button>
                    {o?.permissions.includes("settings.manage") && (
                      <Button
                        className="ml-2"
                        variant="outline"
                        onClick={() =>
                          openMaster(
                            "item",
                            o.items.find((i) => i.id === r.id),
                          )
                        }
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.items.length === 0 && (
            <p className="p-4 text-sm text-slate-500">
              Tidak ada barang sesuai pencarian.
            </p>
          )}
        </div>
        <Pager
          page={page}
          total={data?.total ?? 0}
          onPage={setPage}
          disabled={busy}
        />
      </section>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">Laporan penggunaan</h2>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void loadUsage(usagePage);
          }}
        >
          <Field
            def={{
              key: "from",
              label: "Dari tanggal",
              type: "date",
              required: true,
            }}
            value={from}
            onChange={(v) => {
              setFrom(String(v));
              setUsagePage(1);
              setUsage(null);
            }}
          />
          <Field
            def={{
              key: "to",
              label: "Sampai tanggal",
              type: "date",
              required: true,
            }}
            value={to}
            onChange={(v) => {
              setTo(String(v));
              setUsagePage(1);
              setUsage(null);
            }}
          />
          <Button disabled={busy}>Tampilkan</Button>
        </form>
        {usage && (
          <>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {["Barang", "Jumlah dipakai", "Nilai pemakaian"].map(
                      (x) => (
                        <th key={x} className="p-3">
                          {x}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {usage.items.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="p-3">{r.name}</td>
                      <td className="p-3">
                        {String(r.quantity)} {String(r.unit_name)}
                      </td>
                      <td className="p-3">{money(r.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-3">
              <Button
                variant="outline"
                disabled={busy || usage.page <= 1}
                onClick={() => void loadUsage(usage.page - 1)}
              >
                Sebelumnya
              </Button>
              <Button
                variant="outline"
                disabled={busy || usage.page * 20 >= usage.total}
                onClick={() => void loadUsage(usage.page + 1)}
              >
                Berikutnya
              </Button>
            </div>
          </>
        )}
      </section>
      {o?.permissions.includes("settings.manage") && (
        <details className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <summary className="font-semibold">Penyedia terdaftar</summary>
          <ul className="mt-3 divide-y divide-slate-100">
            {o.suppliers.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between py-3 text-sm"
              >
                <span>
                  {s.name} · {s.status === "active" ? "Aktif" : "Arsip"}
                </span>
                <Button
                  variant="outline"
                  onClick={() => openMaster("supplier", s)}
                >
                  Edit / Arsip
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Dialog
        open={!!master}
        onOpenChange={(v) => {
          if (!v && !busy) setMaster(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogTitle className="text-xl font-semibold">
            {master?.value.id ? "Edit" : "Tambah"}{" "}
            {master?.kind === "item" ? "barang persediaan" : "penyedia"}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            Master berlaku untuk lembaga aktif. Satuan yang sudah dipakai ledger
            tidak dapat diubah.
          </DialogDescription>
          <Feedback error={error} message="" />
          {master && (
            <form
              className="mt-4"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const data: Record<string, unknown> = {};
                  for (const f of defs) data[f.key] = master.value[f.key];
                  await supplyApi("master", tenantId, {
                    kind: master.kind,
                    id: master.value.id,
                    rowVersion: master.value.rowVersion,
                    data,
                  });
                  setMaster(null);
                  setMessage("Master tersimpan.");
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {defs.map((f) => (
                  <Field
                    key={f.key}
                    def={f}
                    value={master.value[f.key]}
                    disabled={busy}
                    onChange={(v) =>
                      setMaster((m) =>
                        m ? { ...m, value: { ...m.value, [f.key]: v } } : null,
                      )
                    }
                  />
                ))}
              </div>
              <Button className="mt-5" disabled={busy}>
                Simpan
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!cardId}
        onOpenChange={(v) => {
          if (!v) {
            setCardId("");
            setCard(null);
          }
        }}
      >
        <DialogContent className="max-w-4xl">
          <Feedback error={error} message="" />
          <DialogTitle className="text-xl font-semibold">
            Kartu stok {card?.item.name ?? ""}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            Saldo berjalan per ruangan, menurut urutan posting. Tanggal bisnis
            ditampilkan pada setiap dokumen.
          </DialogDescription>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  {[
                    "Dokumen / tanggal",
                    "Ruangan",
                    "Masuk/keluar",
                    "Nilai",
                    "Saldo jumlah",
                    "Saldo nilai",
                  ].map((x) => (
                    <th key={x} className="p-2">
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card?.entries.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="p-2">
                      <Link
                        className="text-teal-800"
                        href={"/pengadaan/" + r.source_document_id}
                      >
                        {String(r.document_number)}
                      </Link>
                      <p>{String(r.business_date)}</p>
                    </td>
                    <td className="p-2">{String(r.room_name)}</td>
                    <td className="p-2">{String(r.quantity_delta)}</td>
                    <td className="p-2">{money(r.value_delta)}</td>
                    <td className="p-2">{String(r.running_quantity)}</td>
                    <td className="p-2">{money(r.running_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={cardPage}
            total={card?.total ?? 0}
            disabled={busy}
            onPage={setCardPage}
          />
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
