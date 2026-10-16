"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Feedback } from "@/features/admin/ui-shared";
import { Field, type FieldDef } from "./fields";
import type { AssetInput, Options } from "./schemas";
import { api } from "./client";
const details = {
  land: {
    area_sqm: "",
    address: "",
    ownership_status: "",
    certificate_number: "",
    rights_type: "",
    land_use: "",
  },
  building: {
    location_building_id: null,
    building_type: "",
    construction_year: null,
    area_sqm: null,
    floor_count: null,
    construction_status: "complete",
    ownership_status: "",
  },
  vehicle: {
    vehicle_type: "",
    manufacturing_year: null,
    registration_number: "",
    chassis_number: "",
    engine_number: "",
    ownership_document_number: "",
    registration_expiry: null,
    next_service_date: null,
  },
};
export function newAsset(o: Options): AssetInput {
  return {
    name: "",
    category_id: "",
    subcategory_id: null,
    unit_id: o.refs.units.find((x) => x.code === "UNIT")?.id ?? "",
    funding_source_id: null,
    room_id: null,
    responsible_membership_id: null,
    condition_id: o.refs.conditions.find((x) => x.code === "BAIK")?.id ?? "",
    lifecycle_status: "draft",
    brand: "",
    model: "",
    serial_number: "",
    specifications: "",
    acquisition_date: new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Jakarta",
    }),
    in_service_date: null,
    acquisition_method: "Pembelian",
    acquisition_cost: "0",
    residual_value: "0",
    useful_life_months: null,
    depreciation_policy_id: null,
    notes: "",
    detail: { type: "general" },
    reason: "Pencatatan awal aset",
  };
}
export function AssetForm({
  options,
  initial,
  id,
  rowVersion,
  onSaved,
  onCancel,
  onTemplate,
}: {
  options: Options;
  initial?: AssetInput;
  id?: string;
  rowVersion?: string;
  onSaved: () => void;
  onCancel: () => void;
  onTemplate?: (value: AssetInput) => void;
}) {
  const [value, setValue] = useState<AssetInput>(initial ?? newAsset(options)),
    [count, setCount] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const ref = (
    kind: keyof Options["refs"],
    filter?: (r: Options["refs"][typeof kind][number]) => boolean,
  ) =>
    options.refs[kind]
      .filter(
        (r) =>
          (r.status === "active" || Object.values(value).includes(r.id)) &&
          (!filter || filter(r)),
      )
      .map((r) => ({
        value: r.id,
        label: r.name + (r.status === "archived" ? " (arsip)" : ""),
      }));
  const fields: FieldDef[] = [
    { key: "name", label: "Nama aset", required: true },
    {
      key: "category_id",
      label: "Kategori",
      disabled: !!id && value.detail.type !== "general",
      type: "select",
      required: true,
      options: ref("categories", (r) => r.asset_kind !== "inventory"),
    },
    {
      key: "subcategory_id",
      label: "Subkategori",
      type: "select",
      options: ref("subcategories", (r) => r.category_id === value.category_id),
    },
    {
      key: "unit_id",
      label: "Satuan",
      type: "select",
      required: true,
      options: ref("units"),
    },
    {
      key: "funding_source_id",
      label: "Sumber dana",
      type: "select",
      options: ref("funding"),
    },
    {
      key: "room_id",
      label: "Gedung / lantai / ruangan",
      type: "select",
      options: ref("rooms").map((r) => {
        const room = options.refs.rooms.find((x) => x.id === r.value)!;
        return {
          ...r,
          label:
            (options.refs.buildings.find((x) => x.id === room.building_id)
              ?.name ?? "") +
            " / Lt. " +
            room.floor_number +
            " / " +
            r.label,
        };
      }),
    },
    {
      key: "responsible_membership_id",
      label: "Penanggung jawab",
      type: "select",
      options: options.members.map((m) => ({ value: m.id, label: m.name })),
    },
    {
      key: "condition_id",
      label: "Kondisi",
      type: "select",
      required: true,
      options: ref("conditions"),
    },
    {
      key: "lifecycle_status",
      label: "Status aset",
      type: "select",
      required: true,
      options: [
        { value: "draft", label: "Draf" },
        { value: "available", label: "Tersedia" },
      ],
      hint: "Status transaksi dikelola melalui alur peminjaman, pemeliharaan, dan penghapusan.",
    },
    { key: "brand", label: "Merek" },
    { key: "model", label: "Tipe / model" },
    { key: "serial_number", label: "Nomor seri", disabled: count > 1 },
    {
      key: "acquisition_date",
      label: "Tanggal perolehan",
      type: "date",
      required: true,
    },
    { key: "in_service_date", label: "Mulai digunakan", type: "date" },
    { key: "acquisition_method", label: "Cara perolehan", required: true },
    {
      key: "acquisition_cost",
      label: "Harga perolehan per unit (Rp)",
      required: true,
      hint: "Gunakan titik desimal tanpa pemisah ribuan, contoh 1500000.50",
    },
    { key: "residual_value", label: "Nilai residu (Rp)", required: true },
    {
      key: "depreciation_policy_id",
      label: "Kebijakan penyusutan",
      type: "select",
      options: ref("policies"),
    },
    {
      key: "useful_life_months",
      label: "Umur manfaat (bulan)",
      type: "number",
    },
    { key: "specifications", label: "Spesifikasi", type: "textarea" },
    { key: "notes", label: "Keterangan", type: "textarea", maxLength: 4000 },
    {
      key: "reason",
      label: "Alasan pencatatan / perubahan",
      required: true,
      maxLength: 1000,
    },
  ];
  const sensitive = options.permissions.includes("files.sensitive.download"),
    df: FieldDef[] =
      value.detail.type === "land"
        ? [
            { key: "area_sqm", label: "Luas tanah (m²)", required: true },
            {
              key: "address",
              label: "Alamat tanah",
              required: true,
              maxLength: 2000,
            },
            {
              key: "ownership_status",
              label: "Status kepemilikan",
              required: true,
            },
            {
              key: "certificate_number",
              label: "Nomor sertifikat",
              disabled: !sensitive,
            },
            { key: "rights_type", label: "Jenis hak" },
            { key: "land_use", label: "Penggunaan" },
          ]
        : value.detail.type === "building"
          ? [
              {
                key: "location_building_id",
                label: "Lokasi gedung",
                type: "select",
                options: ref("buildings"),
              },
              { key: "building_type", label: "Jenis bangunan" },
              {
                key: "construction_year",
                label: "Tahun pembangunan",
                type: "number",
              },
              { key: "area_sqm", label: "Luas bangunan (m²)" },
              { key: "floor_count", label: "Jumlah lantai", type: "number" },
              {
                key: "construction_status",
                label: "Status pembangunan",
                type: "select",
                required: true,
                options: [
                  { value: "complete", label: "Selesai" },
                  { value: "in_progress", label: "Dalam proses" },
                ],
              },
              { key: "ownership_status", label: "Status kepemilikan" },
            ]
          : value.detail.type === "vehicle"
            ? [
                {
                  key: "vehicle_type",
                  label: "Jenis kendaraan",
                  required: true,
                },
                {
                  key: "manufacturing_year",
                  label: "Tahun pembuatan",
                  type: "number",
                },
                { key: "registration_number", label: "Nomor polisi" },
                {
                  key: "chassis_number",
                  label: "Nomor rangka",
                  disabled: !sensitive,
                },
                {
                  key: "engine_number",
                  label: "Nomor mesin",
                  disabled: !sensitive,
                },
                {
                  key: "ownership_document_number",
                  label: "Nomor BPKB",
                  disabled: !sensitive,
                },
                {
                  key: "registration_expiry",
                  label: "Berlaku dokumen sampai",
                  type: "date",
                },
                {
                  key: "next_service_date",
                  label: "Jadwal servis berikutnya",
                  type: "date",
                },
              ]
            : [];
  function change(k: string, v: unknown) {
    setValue((old) => {
      const next = { ...old, [k]: v };
      if (k === "category_id") {
        const type = options.refs.categories.find(
          (c) => c.id === v,
        )?.asset_kind;
        next.subcategory_id = null;
        next.detail =
          type === "land" || type === "building" || type === "vehicle"
            ? ({ type, data: { ...details[type] } } as AssetInput["detail"])
            : { type: "general" };
        if (type === "land") {
          next.depreciation_policy_id = null;
          next.useful_life_months = null;
        }
      }
      if (k === "depreciation_policy_id")
        next.useful_life_months =
          Number(
            options.refs.policies.find((p) => p.id === v)?.useful_life_months,
          ) || null;
      return next;
    });
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        setError("");
        try {
          if (onTemplate) {
            onTemplate(value);
            return;
          }
          await api(
            id ? "update" : "create",
            options.tenantId,
            id
              ? { id, rowVersion, asset: value }
              : { asset: value, count, idempotencyKey: key },
          );
          onSaved();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Simpan belum berhasil.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Feedback error={error} message="" />
      <div className="grid gap-4 sm:grid-cols-2">
        {!id && !onTemplate && (
          <Field
            def={{
              key: "count",
              label: "Jumlah unit dalam batch",
              type: "number",
              required: true,
              hint: "1–50 unit; tiap unit memperoleh identitas dan QR sendiri.",
            }}
            value={count}
            disabled={busy}
            onChange={(v) => {
              setCount(Number(v));
              if (Number(v) > 1) change("serial_number", "");
            }}
          />
        )}
        {fields.map((f) => (
          <Field
            key={f.key}
            def={f}
            value={value[f.key as keyof AssetInput]}
            disabled={busy}
            onChange={(v) => change(f.key, v)}
          />
        ))}
      </div>
      {df.length > 0 && (
        <>
          <h3 className="mt-6 font-semibold">
            Detail{" "}
            {value.detail.type === "land"
              ? "tanah"
              : value.detail.type === "building"
                ? "bangunan"
                : "kendaraan"}
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {df.map((f) => (
              <Field
                key={f.key}
                def={f}
                disabled={busy}
                value={
                  value.detail.type !== "general"
                    ? (value.detail.data as Record<string, unknown>)[f.key]
                    : null
                }
                onChange={(v) =>
                  setValue((old) =>
                    old.detail.type === "general"
                      ? old
                      : {
                          ...old,
                          detail: {
                            ...old.detail,
                            data: { ...old.detail.data, [f.key]: v },
                          } as AssetInput["detail"],
                        },
                  )
                }
              />
            ))}
          </div>
          {!sensitive && (
            <p className="mt-3 text-xs text-slate-500">
              Data kepemilikan sensitif dipertahankan oleh sistem dan tidak
              ditampilkan pada akses Anda.
            </p>
          )}
        </>
      )}
      <div className="sticky bottom-0 mt-6 flex justify-end gap-3 border-t border-slate-100 bg-white pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Batal
        </Button>
        <Button disabled={busy}>
          {busy ? "Menyimpan…" : onTemplate ? "Simpan template" : "Simpan aset"}
        </Button>
      </div>
    </form>
  );
}
