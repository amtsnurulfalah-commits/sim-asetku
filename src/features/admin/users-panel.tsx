"use client";
import { useRef, useState } from "react";
import { UserPlus, Pencil, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { authPost } from "@/features/auth/client";
import type { AdminData, Member } from "./schemas";
import {
  DirectoryPicker,
  Feedback,
  Pager,
  readAdmin,
  type DirectoryUser,
} from "./ui-shared";
const statuses = { active: "Aktif", inactive: "Nonaktif", revoked: "Dicabut" };
export function UsersPanel({ initial }: { initial: AdminData }) {
  const [data, setData] = useState(initial),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Member | null>(null),
    [selected, setSelected] = useState<DirectoryUser | null>(null),
    [role, setRole] = useState("petugas"),
    [status, setStatus] = useState("active"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  async function load(page = data.page) {
    const next = await readAdmin<AdminData>(
      "/api/admin/users?page=" + page,
      undefined,
      data.tenant.id,
    );
    setData(next);
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
  function start(member: Member | null) {
    setEditing(member);
    setSelected(null);
    setRole(member?.role_code ?? "petugas");
    setStatus(member?.status ?? "active");
    setError("");
    setMessage("");
    setOpen(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || (!editing && !selected)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await authPost(
        editing ? "/api/admin/users/update" : "/api/admin/users/create",
        editing
          ? {
              membership_id: editing.id,
              role,
              status,
              row_version: editing.row_version,
            }
          : { sso_user_id: selected!.sso_user_id, role, status },
        data.tenant.id,
      );
      setOpen(false);
      setMessage(
        editing
          ? "Akses pengguna berhasil diperbarui."
          : "Pengguna berhasil ditambahkan.",
      );
      try {
        await load();
      } catch {
        setError(
          "Perubahan tersimpan, tetapi daftar belum dapat dimuat ulang.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Perubahan belum berhasil.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Feedback error={!open ? error : ""} message={message} />
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900">Pengguna lembaga</h2>
            <p className="mt-1 text-xs text-slate-500">
              Kelola keanggotaan dan tanggung jawab pengguna.
            </p>
          </div>
          <Button onClick={() => start(null)} disabled={busy}>
            <UserPlus size={17} />
            <span className="hidden sm:inline">Tambah pengguna</span>
            <span className="sm:hidden">Tambah</span>
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-y border-slate-100 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="p-3">Pengguna</th>
                <th className="p-3">Role</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="border-b border-slate-100">
                  <td className="p-3">
                    <span className="block font-semibold text-slate-800">
                      {m.full_name}
                    </span>
                    <span className="text-xs text-slate-500">
                      @{m.username}
                    </span>
                  </td>
                  <td className="p-3 text-slate-600">
                    {data.roles.find((r) => r.id === m.role_id)?.name ?? "—"}
                  </td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${m.status === "active" ? "bg-teal-50 text-teal-800" : "bg-slate-100 text-slate-600"}`}
                    >
                      {statuses[m.status]}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      variant="ghost"
                      disabled={m.id === data.actor_id || busy}
                      onClick={() => start(m)}
                      aria-label={"Ubah akses " + m.full_name}
                    >
                      <Pencil size={15} />
                      {m.id === data.actor_id ? "Akun Anda" : "Ubah"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.items.length === 0 && (
            <p className="p-8 text-center text-sm text-slate-500">
              Belum ada pengguna pada halaman ini.
            </p>
          )}
        </div>
        <Pager
          page={data.page}
          total={data.total}
          disabled={busy}
          onPage={page}
        />
      </section>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="font-bold text-slate-900">
          Riwayat perubahan akses terbaru
        </h2>
        <ul className="mt-4 space-y-3">
          {data.history
            .filter(
              (h) =>
                h.action === "member_added" || h.action === "member_changed",
            )
            .map((h, i) => (
              <li
                key={h.created_at + i}
                className="border-b border-slate-100 pb-3 text-sm text-slate-600"
              >
                <p className="font-semibold text-slate-700">
                  {data.items.find((m) => m.id === h.resource_id)?.full_name ??
                    "Pengguna lembaga"}{" "}
                  ·{" "}
                  {h.action === "member_added"
                    ? "Keanggotaan ditambahkan"
                    : "Keanggotaan diperbarui"}
                </p>
                {h.action === "member_changed" && (
                  <p className="mt-1 text-xs">
                    Role:{" "}
                    {data.roles.find((r) => r.id === h.details.old_role_id)
                      ?.name ?? "—"}{" "}
                    →{" "}
                    {data.roles.find((r) => r.id === h.details.new_role_id)
                      ?.name ?? "—"}{" "}
                    · Status:{" "}
                    {statuses[h.details.new_status as keyof typeof statuses] ??
                      "—"}
                  </p>
                )}
                <time className="mt-1 block text-xs text-slate-400">
                  {new Date(h.created_at).toLocaleString("id-ID", {
                    timeZone: data.tenant.timezone,
                  })}
                </time>
              </li>
            ))}
        </ul>
        {data.history.filter(
          (h) => h.action === "member_added" || h.action === "member_changed",
        ).length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            Tidak ada perubahan keanggotaan pada riwayat terbaru.
          </p>
        )}
      </section>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent>
          <DialogTitle className="text-xl font-bold">
            {editing ? "Ubah akses pengguna" : "Tambah pengguna"}
          </DialogTitle>
          <DialogDescription className="mb-5 mt-2 text-sm leading-6 text-slate-500">
            {editing
              ? "Perubahan berlaku untuk lembaga ini dan mencabut sesi yang terdampak."
              : "Pilih akun pusat yang sudah aktif, lalu tetapkan role lokal."}
          </DialogDescription>
          <Feedback error={error} message="" />
          <form onSubmit={save} className="space-y-4">
            {editing ? (
              <p className="rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-700">
                {editing.full_name} (@{editing.username})
              </p>
            ) : (
              <DirectoryPicker
                tenantId={data.tenant.id}
                value={selected}
                onChange={setSelected}
                disabled={busy}
              />
            )}
            <div>
              <label
                htmlFor="member-role"
                className="mb-2 block text-sm font-semibold"
              >
                Role Inventaris
              </label>
              <select
                id="member-role"
                className="field"
                disabled={busy}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {data.roles.map((r) => (
                  <option value={r.code} key={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="member-status"
                className="mb-2 block text-sm font-semibold"
              >
                Status keanggotaan
              </label>
              <select
                id="member-status"
                className="field"
                disabled={busy}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="active">Aktif</option>
                <option value="inactive">Nonaktif</option>
                {editing && <option value="revoked">Dicabut</option>}
              </select>
            </div>
            <Button
              className="w-full"
              disabled={busy || (!editing && !selected)}
            >
              {busy ? (
                <>
                  <LoaderCircle className="animate-spin" size={17} />
                  Menyimpan…
                </>
              ) : (
                "Simpan akses"
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
