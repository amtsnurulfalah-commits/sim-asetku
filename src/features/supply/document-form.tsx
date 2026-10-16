"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Feedback } from "@/features/admin/ui-shared";
import { Field, type FieldDef } from "@/features/assets/fields";
import { AssetForm } from "@/features/assets/asset-form";
import { api as assetApi } from "@/features/assets/client";
import type {
  AssetInput,
  Options as AssetOptions,
} from "@/features/assets/schemas";
import { supplyApi } from "./client";
import {
  kindText,
  type Kind,
  type Options,
  type Detail,
  type DocumentRow,
} from "./schemas";
function subtract(a: unknown, b: unknown) {
  const fixed = (v: unknown) => {
    const [x, d = ""] = String(v ?? 0).split(".");
    return BigInt(x + d.padEnd(6, "0"));
  };
  const n = fixed(a) - fixed(b),
    s = (n < 0n ? -n : n).toString().padStart(7, "0");
  return (
    (n < 0n ? "-" : "") +
    s.slice(0, -6) +
    (s.slice(-6).replace(/0+$/, "") ? "." + s.slice(-6).replace(/0+$/, "") : "")
  );
}
export function DocumentForm({
  kind,
  options,
  initial,
  onSaved,
  onCancel,
}: {
  kind: Kind;
  options: Options;
  initial?: Record<string, unknown>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(
      initial ?? {
        kind,
        id: null,
        rowVersion: null,
        idempotencyKey: crypto.randomUUID(),
        date: new Date().toISOString().slice(0, 10),
        reason: "",
        roomId: options.rooms.find((r) => r.status === "active")?.id ?? "",
        fundingId: null,
        requestId: "",
        supplierId: "",
        orderId: "",
        correctsDocumentId: null,
      },
    ),
    [lines, setLines] = useState<Record<string, unknown>[]>(
      (initial?.lines as Record<string, unknown>[]) ??
        (kind === "request"
          ? [{ description: "", unitId: "", quantity: "1", unitCost: "0" }]
          : ["order", "receipt"].includes(kind)
            ? []
            : [
                {
                  itemId: "",
                  roomId: "",
                  quantity: kind === "issue" ? "-1" : "1",
                  unitCost: "0",
                },
              ]),
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [sourceQuery, setSourceQuery] = useState(""),
    [sourcePage, setSourcePage] = useState(1),
    [sources, setSources] = useState<{
      items: DocumentRow[];
      total: number;
    } | null>(null),
    [assetOptions, setAssetOptions] = useState<AssetOptions | null>(null),
    [templateIndex, setTemplateIndex] = useState<number | null>(null);
  const sourceKind =
    kind === "order" ? "request" : kind === "receipt" ? "order" : null;
  useEffect(() => {
    if (!sourceKind) return;
    const c = new AbortController(),
      timer = setTimeout(
        () =>
          supplyApi<{ items: DocumentRow[]; total: number }>(
            "documents?" +
              new URLSearchParams({
                kind: sourceKind,
                status: "approved",
                query: sourceQuery,
                page: String(sourcePage),
              }),
            options.tenantId,
            undefined,
            c.signal,
          )
            .then(setSources)
            .catch((e) => {
              if (!c.signal.aborted) setError(e.message);
            }),
        250,
      );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [sourceKind, sourceQuery, sourcePage, options.tenantId]);
  const ref = (name: "rooms" | "units" | "funding" | "suppliers" | "items") =>
    options[name]
      .filter((r) => r.status === "active")
      .map((r) => ({
        value: r.id,
        label: r.name + (r.code ? " (" + r.code + ")" : ""),
      }));
  async function source(id: string) {
    setBusy(true);
    setError("");
    try {
      const d = await supplyApi<Detail>("detail?id=" + id, options.tenantId);
      if (kind === "order") {
        setValue((v) => ({
          ...v,
          requestId: d.doc.source_id,
          fundingId: d.doc.funding_source_id ?? null,
        }));
        setLines(
          d.lines
            .filter((l) => subtract(l.quantity, l.ordered_quantity) !== "0")
            .map((l) => ({
              requestItemId: l.id,
              description: l.description,
              unitId: l.unit_id,
              quantity: subtract(l.quantity, l.ordered_quantity),
              unitCost: String(l.estimated_unit_cost),
              destination: "inventory",
              itemId: null,
              asset: null,
            })),
        );
      } else {
        setValue((v) => ({ ...v, orderId: d.doc.source_id }));
        setLines(
          d.lines
            .filter((l) => subtract(l.quantity, l.received_quantity) !== "0")
            .map((l) => ({
              orderItemId: l.id,
              quantity: subtract(l.quantity, l.received_quantity),
              accepted: subtract(l.quantity, l.received_quantity),
              roomId:
                options.rooms.find((r) => r.status === "active")?.id ?? "",
              inspection: "Barang diperiksa sesuai dokumen",
              label: l.description,
            })),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const headers: FieldDef[] = [
    { key: "date", label: "Tanggal dokumen", type: "date", required: true },
    {
      key: "reason",
      label: "Keperluan / alasan",
      type: "textarea",
      required: true,
      maxLength: 2000,
    },
  ];
  if (kind === "request")
    headers.push({
      key: "roomId",
      label: "Ruangan pemohon",
      type: "select",
      required: true,
      options: ref("rooms"),
    });
  if (kind === "request" || kind === "order")
    headers.push({
      key: "fundingId",
      label: "Sumber dana",
      type: "select",
      options: ref("funding"),
    });
  if (kind === "order")
    headers.push({
      key: "supplierId",
      label: "Penyedia",
      type: "select",
      required: true,
      options: ref("suppliers"),
    });
  function fields(l: Record<string, unknown>): FieldDef[] {
    if (kind === "request")
      return [
        {
          key: "description",
          label: "Uraian",
          required: true,
          maxLength: 1000,
        },
        {
          key: "unitId",
          label: "Satuan",
          type: "select",
          required: true,
          options: ref("units"),
        },
        { key: "quantity", label: "Jumlah", required: true },
        {
          key: "unitCost",
          label: "Perkiraan harga satuan (Rp)",
          required: true,
        },
      ];
    if (kind === "order")
      return [
        {
          key: "description",
          label: "Uraian",
          required: true,
          maxLength: 1000,
        },
        {
          key: "unitId",
          label: "Satuan",
          type: "select",
          required: true,
          options: ref("units"),
        },
        { key: "quantity", label: "Jumlah dipesan", required: true },
        { key: "unitCost", label: "Harga satuan (Rp)", required: true },
        {
          key: "destination",
          label: "Ditetapkan sebagai",
          type: "select",
          required: true,
          options: [
            { value: "inventory", label: "Persediaan" },
            { value: "asset", label: "Aset individual" },
          ],
        },
        ...(l.destination === "inventory"
          ? [
              {
                key: "itemId",
                label: "Barang persediaan",
                type: "select" as const,
                required: true,
                options: ref("items"),
              },
            ]
          : []),
      ];
    if (kind === "receipt")
      return [
        { key: "quantity", label: "Jumlah dikirim", required: true },
        { key: "accepted", label: "Jumlah diterima baik", required: true },
        {
          key: "roomId",
          label: "Ruangan penerima",
          type: "select",
          required: true,
          options: ref("rooms"),
        },
        {
          key: "inspection",
          label: "Hasil pemeriksaan / penolakan",
          required: true,
          maxLength: 1000,
        },
      ];
    return [
      {
        key: "itemId",
        label: "Barang",
        type: "select",
        required: true,
        options: ref("items"),
      },
      {
        key: "roomId",
        label: "Ruangan",
        type: "select",
        required: true,
        options: ref("rooms"),
      },
      {
        key: "quantity",
        label:
          kind === "issue" ? "Jumlah keluar (negatif)" : "Perubahan jumlah",
        required: true,
        hint:
          kind === "adjustment"
            ? "Positif menambah, negatif mengurangi."
            : undefined,
      },
      {
        key: "unitCost",
        label: "Harga satuan masuk (Rp)",
        required: true,
        disabled: kind === "issue",
        hint: "Pengeluaran dinilai otomatis dari rata-rata tertimbang.",
      },
    ];
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const {
            roomId,
            fundingId,
            requestId,
            supplierId,
            orderId,
            correctsDocumentId,
            ...common
          } = value;
          const clean = lines.map(({ label: _, ...l }) => {
            void _;
            return l;
          });
          const data = {
            ...common,
            kind,
            ...(kind === "request"
              ? { roomId, fundingId }
              : kind === "order"
                ? { requestId, supplierId, fundingId }
                : kind === "receipt"
                  ? { orderId }
                  : { correctsDocumentId: correctsDocumentId ?? null }),
            lines: clean,
          };
          const r = await supplyApi<{ id: string }>(
            "save",
            options.tenantId,
            data,
          );
          onSaved(r.id);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Feedback error={error} message="" />
      <div className="grid gap-4 sm:grid-cols-2">
        {headers.map((f) => (
          <Field
            key={f.key}
            def={f}
            value={value[f.key]}
            disabled={busy}
            onChange={(v) => setValue((old) => ({ ...old, [f.key]: v }))}
          />
        ))}
      </div>
      {sourceKind && (
        <fieldset className="mt-6 rounded-xl border border-slate-200 p-4">
          <legend className="px-2 text-sm font-semibold">Pilih sumber</legend>
          <label htmlFor="supply-source-query" className="text-sm">
            Cari nomor / keperluan {kindText[sourceKind]} yang disetujui
          </label>
          <input
            id="supply-source-query"
            className="field mt-2"
            value={sourceQuery}
            onChange={(e) => {
              setSourceQuery(e.target.value);
              setSourcePage(1);
            }}
          />
          <select
            aria-label="Pilih sumber dokumen"
            className="field mt-3"
            defaultValue=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void source(e.target.value);
            }}
          >
            <option value="">
              {initial
                ? "Sumber tersimpan dipertahankan; pilih untuk mengganti…"
                : "Pilih dokumen sumber…"}
            </option>
            {sources?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.document_number} · {d.reason}
              </option>
            ))}
          </select>
          <div className="mt-3 flex gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={busy || sourcePage <= 1}
              onClick={() => setSourcePage((p) => p - 1)}
            >
              Sebelumnya
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || sourcePage * 20 >= (sources?.total ?? 0)}
              onClick={() => setSourcePage((p) => p + 1)}
            >
              Berikutnya
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Jumlah sumber dihitung ulang saat simpan dan posting. Tidak ada
            konversi satuan otomatis.
          </p>
        </fieldset>
      )}
      <div className="mt-6 space-y-4">
        {lines.map((l, i) => (
          <fieldset key={i} className="rounded-xl border border-slate-200 p-4">
            <legend className="px-2 text-sm font-semibold">
              Barang {i + 1}
              {l.label ? " · " + l.label : ""}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {fields(l).map((f) => (
                <Field
                  key={f.key}
                  def={f}
                  value={l[f.key]}
                  disabled={busy}
                  onChange={(v) =>
                    setLines((old) =>
                      old.map((row, index) =>
                        index === i
                          ? {
                              ...row,
                              [f.key]: v,
                              ...(f.key === "destination"
                                ? { itemId: null, asset: null }
                                : {}),
                            }
                          : row,
                      ),
                    )
                  }
                />
              ))}
            </div>
            {kind === "order" && l.destination === "asset" && (
              <div className="mt-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setError("");
                    try {
                      setAssetOptions(
                        await assetApi<AssetOptions>(
                          "options",
                          options.tenantId,
                        ),
                      );
                      setTemplateIndex(i);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {l.asset ? "Edit template aset" : "Isi template aset"}
                </Button>
                <p className="mt-2 text-xs text-slate-500">
                  Aset baru dibuat saat penerimaan dibukukan, bukan saat
                  menyimpan template. Maksimal 50 unit diterima per baris
                  penerimaan.
                </p>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              disabled={busy || lines.length <= 1}
              onClick={() =>
                setLines((old) => old.filter((_, index) => index !== i))
              }
            >
              Hapus baris
            </Button>
          </fieldset>
        ))}
      </div>
      {!["order", "receipt"].includes(kind) && (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={busy || lines.length >= 50}
          onClick={() =>
            setLines((old) => [
              ...old,
              kind === "request"
                ? { description: "", unitId: "", quantity: "1", unitCost: "0" }
                : {
                    itemId: "",
                    roomId: "",
                    quantity: kind === "issue" ? "-1" : "1",
                    unitCost: "0",
                  },
            ])
          }
        >
          Tambah baris
        </Button>
      )}
      <div className="sticky bottom-0 mt-6 flex justify-end gap-3 border-t border-slate-100 bg-white pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Batal
        </Button>
        <Button disabled={busy || !lines.length}>
          {busy ? "Menyimpan…" : "Simpan draf"}
        </Button>
      </div>
      <Dialog
        open={templateIndex !== null}
        onOpenChange={(v) => {
          if (!v) setTemplateIndex(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogTitle className="text-xl font-semibold">
            Template aset pengadaan
          </DialogTitle>
          <DialogDescription className="mb-5 mt-2 text-sm text-slate-500">
            Lokasi, biaya dan tanggal perolehan mengikuti penerimaan. Kosongkan
            mulai digunakan jika belum diketahui.
          </DialogDescription>
          {assetOptions && templateIndex !== null && (
            <AssetForm
              options={assetOptions}
              initial={
                (lines[templateIndex].asset ?? undefined) as
                  AssetInput | undefined
              }
              onCancel={() => setTemplateIndex(null)}
              onSaved={() => {}}
              onTemplate={(a) => {
                const idx = templateIndex;
                setLines((old) =>
                  old.map((l, i) => (i === idx ? { ...l, asset: a } : l)),
                );
                setTemplateIndex(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </form>
  );
}
