"use client";
import { useCallback, useEffect, useState } from "react";
import { AdminShell, Feedback, Pager } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, type FieldDef } from "./fields";
import { api } from "./client";
import { kinds, type MasterKind, type Options, type Ref } from "./schemas";
const names: Record<MasterKind, string> = {
  categories: "Kategori",
  subcategories: "Subkategori",
  units: "Satuan",
  conditions: "Kondisi",
  funding: "Sumber Dana",
  buildings: "Gedung",
  rooms: "Ruangan",
  policies: "Kebijakan Penyusutan",
};
export function MasterPanel({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const [options, setOptions] = useState<Options | null>(null),
    [kind, setKind] = useState<MasterKind>("categories"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<{ items: Ref[]; total: number } | null>(null),
    [modal, setModal] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [modalError, setModalError] = useState(""),
    [busy, setBusy] = useState(false),
    [format, setFormat] = useState(""),
    [width, setWidth] = useState(70),
    [height, setHeight] = useState(35);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [o, d] = await Promise.all([
        api<Options>("options?master=1", tenantId, undefined, false, signal),
        api<{ items: Ref[]; total: number }>(
          "masters?" + new URLSearchParams({ kind, query, page: String(page) }),
          tenantId,
          undefined,
          false,
          signal,
        ),
      ]);
      if (signal?.aborted) return;
      setOptions(o);
      setData(d);
      setFormat(o.settings.format);
      setWidth(o.settings.width);
      setHeight(o.settings.height);
    },
    [kind, query, page, tenantId],
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
  const refs = (k: MasterKind) =>
    options?.refs[k]
      .filter((r) => r.status === "active")
      .map((r) => ({ value: r.id, label: r.name })) ?? [];
  const fields: FieldDef[] = [
    {
      key: "code",
      label: "Kode",
      required: true,
      hint: "Huruf besar, angka, garis bawah atau tanda hubung.",
    },
    { key: "name", label: "Nama", required: true },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: [
        { value: "active", label: "Aktif" },
        { value: "archived", label: "Arsip" },
      ],
    },
  ];
  if (kind === "categories")
    fields.push(
      {
        key: "asset_kind",
        label: "Jenis aset",
        type: "select",
        required: true,
        options: [
          ...[
            ["land", "Tanah"],
            ["building", "Bangunan"],
            ["vehicle", "Kendaraan"],
            ["equipment", "Peralatan"],
            ["collection", "Koleksi"],
            ["inventory", "Persediaan"],
            ["other", "Lainnya"],
          ].map(([value, label]) => ({ value, label })),
        ],
      },
      { key: "depreciable", label: "Dapat disusutkan", type: "checkbox" },
    );
  if (kind === "subcategories")
    fields.push({
      key: "category_id",
      label: "Kategori induk",
      type: "select",
      required: true,
      options: refs("categories"),
    });
  if (kind === "conditions")
    fields.push({
      key: "loan_allowed",
      label: "Kondisi dapat dipinjamkan",
      type: "checkbox",
    });
  if (kind === "buildings")
    fields.push({
      key: "address",
      label: "Alamat",
      type: "textarea",
      maxLength: 4000,
    });
  if (kind === "rooms")
    fields.push(
      {
        key: "building_id",
        label: "Gedung",
        type: "select",
        required: true,
        options: refs("buildings"),
      },
      { key: "floor_number", label: "Lantai", type: "number", required: true },
      {
        key: "responsible_membership_id",
        label: "Penanggung jawab",
        type: "select",
        options: options?.members.map((m) => ({ value: m.id, label: m.name })),
      },
    );
  if (kind === "policies")
    fields.push(
      {
        key: "method",
        label: "Metode",
        type: "select",
        required: true,
        options: [{ value: "straight_line", label: "Garis lurus" }],
      },
      { key: "version", label: "Versi", type: "number", required: true },
      {
        key: "useful_life_months",
        label: "Umur manfaat (bulan)",
        type: "number",
        required: true,
      },
      {
        key: "proration",
        label: "Prorata",
        type: "select",
        required: true,
        options: [
          { value: "full_month", label: "Bulan penuh" },
          { value: "next_month", label: "Bulan berikutnya" },
          { value: "daily", label: "Harian" },
        ],
      },
    );
  function open(row?: Ref) {
    setModalError("");
    const defaults = {
      code: "",
      name: "",
      status: "active",
      asset_kind: "equipment",
      depreciable: true,
      category_id: null,
      loan_allowed: false,
      address: "",
      building_id: null,
      floor_number: 0,
      responsible_membership_id: null,
      method: "straight_line",
      version: 1,
      useful_life_months: 48,
      proration: "full_month",
    };
    const value: Record<string, unknown> = {
      id: row?.id ?? null,
      rowVersion: row?.row_version ?? null,
    };
    for (const f of fields)
      value[f.key] = row?.[f.key] ?? defaults[f.key as keyof typeof defaults];
    setModal(value);
  }
  return (
    <AdminShell title="Master Data Inventaris" tenant={tenantName}>
      <Feedback error={error} message={message} />
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48">
            <label htmlFor="master-kind" className="text-sm font-medium">
              Jenis master data
            </label>
            <select
              id="master-kind"
              className="field mt-2"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as MasterKind);
                setPage(1);
                setData(null);
              }}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {names[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label htmlFor="master-search" className="text-sm font-medium">
              Cari kode atau nama
            </label>
            <input
              id="master-search"
              className="field mt-2"
              maxLength={120}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Button disabled={busy || !options} onClick={() => open()}>
            Tambah {names[kind]}
          </Button>
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="p-3">Kode</th>
                <th className="p-3">Nama</th>
                <th className="p-3">Status</th>
                <th className="p-3">Tindakan</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="p-3 font-mono text-xs">{r.code}</td>
                  <td className="p-3">{r.name}</td>
                  <td className="p-3">
                    {r.status === "active" ? "Aktif" : "Arsip"}
                  </td>
                  <td className="p-3">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => open(r)}
                    >
                      Edit / Arsip
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.items.length === 0 && (
            <p className="p-4 text-sm text-slate-500">
              Belum ada data sesuai pencarian.
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
        <h2 className="font-semibold">Kode inventaris dan ukuran label</h2>
        <p className="mt-2 text-sm text-slate-500">
          Format baru hanya berlaku pada aset yang dibuat setelah disimpan.
          Nomor urut tetap berlanjut per lembaga.
        </p>
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("configuration", tenantId, { format, width, height });
              setMessage("Format kode dan ukuran label disimpan.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            def={{
              key: "format",
              label: "Format kode",
              required: true,
              hint: "Placeholder: {tenant}, {category}, {year}, {number}. {number} wajib.",
            }}
            value={format}
            onChange={(v) => setFormat(String(v))}
          />
          <Field
            def={{
              key: "width",
              label: "Lebar label (50–100 mm)",
              type: "number",
              step: "0.1",
            }}
            value={width}
            onChange={(v) => setWidth(Number(v))}
          />
          <Field
            def={{
              key: "height",
              label: "Tinggi label (30–60 mm)",
              type: "number",
              step: "0.1",
            }}
            value={height}
            onChange={(v) => setHeight(Number(v))}
          />
          <div className="self-end">
            <Button disabled={busy || !options}>Simpan pengaturan</Button>
          </div>
        </form>
      </section>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogTitle className="pr-8 text-xl font-semibold">
            {modal?.id ? "Edit" : "Tambah"} {names[kind]}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-slate-500">
            Data master berlaku untuk lembaga aktif. Arsip mempertahankan
            referensi historis.
          </DialogDescription>
          {modal && (
            <form
              className="mt-5"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setModalError("");
                try {
                  const body: Record<string, unknown> = {};
                  for (const f of fields) body[f.key] = modal[f.key];
                  await api("master-save", tenantId, {
                    kind,
                    id: modal.id,
                    rowVersion: modal.rowVersion,
                    data: body,
                  });
                  setModal(null);
                  setMessage("Master data tersimpan.");
                  await load();
                } catch (e) {
                  setModalError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Feedback error={modalError} message="" />
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <Field
                    key={f.key}
                    def={f}
                    value={modal[f.key]}
                    disabled={busy}
                    onChange={(v) =>
                      setModal((old) => ({ ...old, [f.key]: v }))
                    }
                  />
                ))}
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Batal
                </Button>
                <Button disabled={busy}>
                  {busy ? "Menyimpan…" : "Simpan"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
