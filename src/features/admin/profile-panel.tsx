"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { authPost } from "@/features/auth/client";
import { Feedback, readAdmin } from "./ui-shared";
import type { AdminData, Tenant } from "./schemas";
export function ProfilePanel({ initial }: { initial: Tenant }) {
  const [tenant, setTenant] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const d = new FormData(e.currentTarget),
      profile = Object.fromEntries(
        ["npsn", "nsm", "address", "phone", "email", "principal_name"].map(
          (k) => [k, String(d.get(k) ?? "")],
        ),
      );
    try {
      await authPost(
        "/api/admin/profile/update",
        {
          name: String(d.get("name")),
          timezone: String(d.get("timezone")),
          row_version: tenant.row_version,
          profile,
        },
        tenant.id,
      );
      setMessage("Profil lembaga berhasil disimpan.");
      try {
        setTenant(
          (
            await readAdmin<AdminData>(
              "/api/admin/profile",
              undefined,
              tenant.id,
            )
          ).tenant,
        );
      } catch {
        setError("Profil tersimpan, tetapi data terbaru belum dapat dimuat.");
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Profil belum berhasil disimpan.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Feedback error={error} message={message} />
      <form
        onSubmit={submit}
        className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6"
      >
        <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          Kode lembaga: <strong>{tenant.code}</strong> · Status:{" "}
          <strong>
            {tenant.status === "setup"
              ? "Penyiapan"
              : tenant.status === "active"
                ? "Aktif"
                : "Nonaktif"}
          </strong>
        </p>
        <div>
          <label
            htmlFor="profile-name"
            className="mb-2 block text-sm font-semibold"
          >
            Nama lembaga
          </label>
          <input
            id="profile-name"
            name="name"
            className="field"
            defaultValue={tenant.name}
            required
            maxLength={300}
            disabled={busy}
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {[
            ["npsn", "NPSN"],
            ["nsm", "NSM"],
            ["phone", "Nomor telepon"],
            ["email", "Email"],
            ["principal_name", "Nama kepala lembaga"],
          ].map(([key, label]) => (
            <div key={key}>
              <label
                htmlFor={"profile-" + key}
                className="mb-2 block text-sm font-semibold"
              >
                {label}
              </label>
              <input
                id={"profile-" + key}
                name={key}
                className="field"
                type={key === "email" ? "email" : "text"}
                maxLength={
                  key === "principal_name"
                    ? 200
                    : key === "phone"
                      ? 50
                      : key === "email"
                        ? 254
                        : 30
                }
                defaultValue={
                  tenant.profile[key as keyof typeof tenant.profile] ?? ""
                }
                disabled={busy}
              />
            </div>
          ))}
          <div>
            <label
              htmlFor="profile-timezone"
              className="mb-2 block text-sm font-semibold"
            >
              Zona waktu
            </label>
            <select
              id="profile-timezone"
              name="timezone"
              className="field"
              defaultValue={tenant.timezone}
              disabled={busy}
            >
              <option value="Asia/Jakarta">WIB — Jakarta</option>
              <option value="Asia/Makassar">WITA — Makassar</option>
              <option value="Asia/Jayapura">WIT — Jayapura</option>
            </select>
          </div>
        </div>
        <div>
          <label
            htmlFor="profile-address"
            className="mb-2 block text-sm font-semibold"
          >
            Alamat
          </label>
          <textarea
            id="profile-address"
            name="address"
            className="field min-h-24"
            maxLength={1500}
            defaultValue={tenant.profile.address ?? ""}
            disabled={busy}
          />
        </div>
        <Button disabled={busy}>{busy ? "Menyimpan…" : "Simpan profil"}</Button>
      </form>
    </>
  );
}
