"use client";
import { useRef, useState } from "react";
import { Plus, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { authPost } from "@/features/auth/client";
import type { PlatformData } from "./schemas";
import {
  DirectoryPicker,
  Feedback,
  Pager,
  readAdmin,
  type DirectoryUser,
} from "./ui-shared";
export function PlatformPanel({ initial }: { initial: PlatformData }) {
  const [data, setData] = useState(initial),
    [open, setOpen] = useState(false),
    [picked, setPicked] = useState<DirectoryUser | null>(null),
    [target, setTarget] = useState<PlatformData["items"][number] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lock = useRef(false),
    key = useRef<string | null>(null);
  async function load(page = data.page) {
    setData(
      await readAdmin<PlatformData>("/api/platform/tenants?page=" + page),
    );
  }
  async function page(n: number) {
    setBusy(true);
    setError("");
    try {
      await load(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Daftar belum dapat dimuat.");
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current || (!target && !picked)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const d = new FormData(e.currentTarget);
    try {
      if (target)
        await authPost("/api/platform/tenants/status", {
          tenant_id: target.id,
          status: target.status === "active" ? "inactive" : "active",
          row_version: target.row_version,
          reason: String(d.get("reason")),
        });
      else {
        key.current ??= crypto.randomUUID();
        await authPost("/api/platform/tenants/create", {
          code: String(d.get("code")),
          name: String(d.get("name")),
          admin_sso_user_id: picked!.sso_user_id,
          idempotency_key: key.current,
        });
      }
      setOpen(false);
      key.current = null;
      setMessage(
        target
          ? "Status lembaga berhasil diperbarui."
          : "Lembaga berhasil dibuat dalam status penyiapan. Admin pertama dapat masuk untuk melengkapi pengaturan.",
      );
      try {
        await load();
      } catch {
        setError(
          "Perubahan tersimpan, tetapi daftar terbaru belum dapat dimuat.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tindakan belum berhasil.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function start(t: PlatformData["items"][number] | null) {
    setTarget(t);
    setPicked(null);
    setOpen(true);
    setError("");
    setMessage("");
    key.current = null;
  }
  return (
    <>
      <Feedback error={!open ? error : ""} message={message} />
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900">Daftar lembaga</h2>
            <p className="mt-1 text-xs text-slate-500">
              Kelola pembuatan dan status lembaga.
            </p>
          </div>
          <Button onClick={() => start(null)} disabled={busy}>
            <Plus size={17} />
            Tambah lembaga
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-y border-slate-100 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="p-3">Lembaga</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="p-3">
                    <p className="font-semibold text-slate-800">{t.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{t.code}</p>
                  </td>
                  <td className="p-3 text-slate-600">
                    {t.status === "setup"
                      ? "Penyiapan"
                      : t.status === "active"
                        ? "Aktif"
                        : t.status === "inactive"
                          ? "Nonaktif"
                          : "Belum siap"}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => start(t)}
                    >
                      {t.status === "active" ? "Nonaktifkan" : "Aktifkan"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.items.length && (
            <div className="p-8 text-center text-slate-500">
              <Building2 className="mx-auto mb-3" />
              <p>Belum ada lembaga terdaftar.</p>
            </div>
          )}
        </div>
        <Pager
          page={data.page}
          total={data.total}
          disabled={busy}
          onPage={page}
        />
      </section>
      <p className="mt-4 text-xs leading-6 text-slate-500">
        Kewenangan operator platform tidak otomatis memberikan akses ke
        inventaris lembaga. Aktivasi memerlukan admin aktif dan koneksi Google
        Drive yang tervalidasi.
      </p>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent>
          <DialogTitle className="text-xl font-bold">
            {target
              ? target.status === "active"
                ? "Nonaktifkan lembaga"
                : "Aktifkan lembaga"
              : "Tambah lembaga"}
          </DialogTitle>
          <DialogDescription className="mb-5 mt-2 text-sm leading-6 text-slate-500">
            {target
              ? target.name
              : "Tetapkan identitas lembaga dan pilih administrator pertamanya dari direktori pusat."}
          </DialogDescription>
          <Feedback error={error} message="" />
          <form
            onSubmit={submit}
            onChange={() => {
              if (!target) key.current = null;
            }}
            className="space-y-4"
          >
            {target ? (
              <div>
                <label
                  htmlFor="status-reason"
                  className="mb-2 block text-sm font-semibold"
                >
                  Alasan perubahan status
                </label>
                <textarea
                  id="status-reason"
                  name="reason"
                  className="field min-h-24"
                  required
                  minLength={5}
                  maxLength={500}
                  disabled={busy}
                />
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="tenant-code"
                    className="mb-2 block text-sm font-semibold"
                  >
                    Kode lembaga
                  </label>
                  <input
                    id="tenant-code"
                    name="code"
                    className="field uppercase"
                    required
                    minLength={2}
                    maxLength={40}
                    pattern="[A-Za-z0-9_\-]+"
                    disabled={busy}
                  />
                </div>
                <div>
                  <label
                    htmlFor="tenant-name"
                    className="mb-2 block text-sm font-semibold"
                  >
                    Nama lembaga
                  </label>
                  <input
                    id="tenant-name"
                    name="name"
                    className="field"
                    required
                    maxLength={300}
                    disabled={busy}
                  />
                </div>
                <DirectoryPicker
                  mode="platform"
                  value={picked}
                  onChange={(u) => {
                    setPicked(u);
                    key.current = null;
                  }}
                  disabled={busy}
                />
              </>
            )}
            <Button className="w-full" disabled={busy || (!target && !picked)}>
              {busy
                ? "Menyimpan…"
                : target
                  ? "Konfirmasi perubahan"
                  : "Buat lembaga"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
