"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { authPost } from "@/features/auth/client";
import { Feedback, readAdmin } from "./ui-shared";
import type { AdminData, Role } from "./schemas";
const protectedCodes = new Set([
  "users.manage",
  "settings.manage",
  "approval.manage",
]);
export function RolesPanel({ initial }: { initial: AdminData }) {
  const [data, setData] = useState(initial),
    [selected, setSelected] = useState<Role>(
      initial.roles.find((r) => r.code === "petugas") ?? initial.roles[0],
    ),
    [codes, setCodes] = useState<string[]>(
      (initial.roles.find((r) => r.code === "petugas") ?? initial.roles[0])
        .permissions,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  function choose(id: string) {
    const r = data.roles.find((x) => x.id === id)!;
    setSelected(r);
    setCodes(r.permissions);
    setMessage("");
    setError("");
  }
  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await authPost(
        "/api/admin/roles/update",
        {
          role_id: selected.id,
          permissions: codes,
          row_version: selected.row_version,
        },
        data.tenant.id,
      );
      setMessage(
        "Izin role diperbarui. Sesi pengguna yang terdampak telah dicabut.",
      );
      try {
        const r = await readAdmin<AdminData>(
          "/api/admin/roles",
          undefined,
          data.tenant.id,
        );
        setData(r);
        const next = r.roles.find((x) => x.id === selected.id)!;
        setSelected(next);
        setCodes(next.permissions);
      } catch {
        setError(
          "Perubahan tersimpan, tetapi data terbaru belum dapat dimuat.",
        );
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Izin belum berhasil disimpan.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Feedback error={error} message={message} />
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <label className="mb-2 block text-sm font-semibold" htmlFor="role-pick">
          Role yang dikelola
        </label>
        <select
          id="role-pick"
          className="field max-w-sm"
          disabled={busy}
          value={selected.id}
          onChange={(e) => choose(e.target.value)}
        >
          {data.roles.map((r) => (
            <option value={r.id} key={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <p className="my-4 text-sm leading-6 text-slate-500">
          Izin Admin Inventaris dilindungi. Kewenangan administrasi tidak dapat
          diberikan kepada role lain melalui formulir ini.
        </p>
        <fieldset
          disabled={busy || selected.code === "admin"}
          className="grid gap-3 sm:grid-cols-2"
        >
          {data.permission_catalog.map((p) => (
            <label
              key={p.code}
              className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-1 accent-teal-800"
                disabled={protectedCodes.has(p.code)}
                checked={codes.includes(p.code)}
                onChange={(e) =>
                  setCodes(
                    e.target.checked
                      ? [...codes, p.code]
                      : codes.filter((x) => x !== p.code),
                  )
                }
              />
              <span>
                <span className="block font-medium text-slate-700">
                  {p.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button
          onClick={save}
          disabled={busy || selected.code === "admin"}
          className="mt-6"
        >
          {busy ? "Menyimpan…" : "Simpan izin role"}
        </Button>
      </section>
    </>
  );
}
