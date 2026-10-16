"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Search, LoaderCircle, Building2, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/features/auth/logout-button";
export async function readAdmin<T>(
  path: string,
  signal?: AbortSignal,
  tenantId?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      headers: tenantId ? { "X-Tenant-Context": tenantId } : {},
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("Layanan belum dapat dihubungi. Coba kembali.");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Respons layanan belum dapat diproses.");
  }
  if (!response.ok || !body.success)
    throw new Error(body.error?.message ?? "Permintaan belum berhasil.");
  return body.data as T;
}
export function AdminShell({
  title,
  tenant,
  children,
  platform = false,
}: {
  title: string;
  tenant?: string;
  children: React.ReactNode;
  platform?: boolean;
}) {
  return (
    <main className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <Link
            prefetch={false}
            href={platform ? "/platform/lembaga" : "/dashboard"}
            className="flex items-center gap-2 font-bold text-teal-900"
          >
            <Boxes size={25} />
            Inventaris
          </Link>
          <LogoutButton />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">
          {platform ? "Operator platform" : "Administrasi lembaga"}
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">{title}</h1>
        {tenant && (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500">
            <Building2 size={16} />
            {tenant}
          </p>
        )}
        {!platform && (
          <nav
            aria-label="Administrasi"
            className="my-6 flex flex-wrap gap-2 text-sm"
          >
            {[
              ["/dashboard", "Dasbor"],
              ["/aset", "Aset Tetap"],
              ["/persediaan", "Persediaan"],
              ["/pengadaan", "Pengadaan"],
              ["/transaksi", "Transaksi Aset"],
              ["/approval", "Persetujuan"],
              ["/penyusutan", "Penyusutan"],
              ["/laporan", "Laporan"],
              ["/master-data", "Master Data"],
              ["/pindai", "Pindai QR"],
              ["/administrasi/pengguna", "Pengguna"],
              ["/administrasi/peran", "Role dan Izin"],
              ["/administrasi/profil", "Profil Lembaga"],
              ["/administrasi/drive", "Google Drive"],
              ["/dokumen", "Dokumen"],
              ["/pilih-lembaga", "Ganti Lembaga"],
            ].map(([href, label]) => (
              <Link
                prefetch={false}
                href={href}
                key={href}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-slate-700 hover:border-teal-500"
              >
                {label}
              </Link>
            ))}
          </nav>
        )}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
export type DirectoryUser = {
  sso_user_id: string;
  username: string;
  full_name: string;
};
export function DirectoryPicker({
  value,
  onChange,
  mode = "tenant",
  disabled = false,
  tenantId,
}: {
  value: DirectoryUser | null;
  onChange: (u: DirectoryUser | null) => void;
  mode?: "tenant" | "platform";
  disabled?: boolean;
  tenantId?: string;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLUListElement>(null),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<DirectoryUser[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState(1),
    [hasNext, setHasNext] = useState(false),
    [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled || query.trim().length < 2 || value) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      setError("");
      try {
        const r = await readAdmin<{
          items: DirectoryUser[];
          pagination: { has_next: boolean };
        }>(
          "/api/admin/directory?mode=" +
            mode +
            "&page=" +
            page +
            "&query=" +
            encodeURIComponent(query),
          controller.signal,
          tenantId,
        );
        if (!controller.signal.aborted) {
          setItems(r.items);
          setHasNext(r.pagination.has_next);
          setOpen(true);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Pencarian belum berhasil.",
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, page, value, mode, disabled, tenantId]);
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-sm font-semibold text-slate-700"
      >
        Pengguna Central SSO
      </label>
      <div className="relative">
        <Search size={17} className="absolute left-3 top-4 text-slate-400" />
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={id + "-list"}
          aria-expanded={open && items.length > 0}
          autoComplete="off"
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setItems([]);
            setBusy(false);
            onChange(null);
            setPage(1);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              list.current?.querySelector<HTMLButtonElement>("button")?.focus();
            }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Cari nama atau username…"
          className="field pl-10"
        />
        {busy && (
          <LoaderCircle
            size={17}
            className="absolute right-3 top-4 animate-spin text-teal-700"
          />
        )}
      </div>
      {value && (
        <p className="mt-2 text-xs text-teal-700">
          Terpilih: {value.full_name} (@{value.username})
        </p>
      )}
      {open && !value && items.length > 0 && (
        <div className="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm">
          <ul
            id={id + "-list"}
            ref={list}
            role="listbox"
            aria-label="Hasil pencarian pengguna"
            className="max-h-56 overflow-y-auto"
          >
            {items.map((u) => (
              <li key={u.sso_user_id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="block w-full px-4 py-3 text-left hover:bg-teal-50 focus:bg-teal-50 focus:outline-none"
                  onKeyDown={(e) => {
                    const buttons =
                      list.current?.querySelectorAll<HTMLButtonElement>(
                        "button",
                      );
                    if (!buttons) return;
                    const i = Array.from(buttons).indexOf(e.currentTarget);
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      buttons[(i + 1) % buttons.length]?.focus();
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      buttons[
                        (i - 1 + buttons.length) % buttons.length
                      ]?.focus();
                    }
                    if (e.key === "Escape") {
                      setOpen(false);
                      input.current?.focus();
                    }
                  }}
                  onClick={() => {
                    onChange(u);
                    setBusy(false);
                    setQuery(u.full_name);
                    setOpen(false);
                    input.current?.focus();
                  }}
                >
                  <span className="block text-sm font-semibold text-slate-800">
                    {u.full_name}
                  </span>
                  <span className="text-xs text-slate-500">@{u.username}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2">
            <button
              type="button"
              disabled={page === 1 || busy}
              className="text-xs text-teal-800 disabled:opacity-40"
              onClick={() => setPage((p) => p - 1)}
            >
              Sebelumnya
            </button>
            <span className="text-xs text-slate-500">Halaman {page}</span>
            <button
              type="button"
              disabled={!hasNext || busy}
              className="text-xs text-teal-800 disabled:opacity-40"
              onClick={() => setPage((p) => p + 1)}
            >
              Berikutnya
            </button>
          </div>
        </div>
      )}
      {!busy &&
        query.trim().length >= 2 &&
        !value &&
        items.length === 0 &&
        !error && (
          <p className="mt-2 text-xs text-slate-500">
            Ketik nama pengguna; hasil akan muncul setelah pencarian.
          </p>
        )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
export function Feedback({
  error,
  message,
}: {
  error: string;
  message: string;
}) {
  return (
    <>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900"
        >
          {message}
        </p>
      )}
    </>
  );
}
export function Pager({
  page,
  total,
  onPage,
  disabled,
}: {
  page: number;
  total: number;
  onPage: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <Button
        variant="outline"
        disabled={page <= 1 || disabled}
        onClick={() => onPage(page - 1)}
      >
        Sebelumnya
      </Button>
      <span className="text-xs text-slate-500">
        Halaman {page} · {total} data
      </span>
      <Button
        variant="outline"
        disabled={page * 20 >= total || disabled}
        onClick={() => onPage(page + 1)}
      >
        Berikutnya
      </Button>
    </div>
  );
}
