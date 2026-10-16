"use client";
import { useRef, useState } from "react";
import { Building2, ArrowRight, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authPost, go } from "./client";
export function TenantPicker({
  items,
  active,
}: {
  items: { id: string; name: string }[];
  active: string | null;
}) {
  const [selected, setSelected] = useState(active ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || !selected) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      go((await authPost("/api/tenants/switch", { tenant_id: selected })).next);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Pilihan belum dapat diproses.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <fieldset disabled={busy}>
        <legend className="sr-only">Daftar lembaga Anda</legend>
        <div className="space-y-3">
          {items.map((x) => (
            <label
              key={x.id}
              className={`flex cursor-pointer items-center gap-4 rounded-xl border p-4 transition ${selected === x.id ? "border-teal-700 bg-teal-50" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <Building2 className="shrink-0 text-teal-700" />
              <span className="min-w-0 flex-1 break-words text-sm font-semibold text-slate-800">
                {x.name}
              </span>
              <input
                type="radio"
                name="tenant"
                value={x.id}
                checked={selected === x.id}
                onChange={() => setSelected(x.id)}
                className="accent-teal-800"
              />
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Button disabled={!selected || busy} className="w-full">
        {busy ? (
          <>
            <LoaderCircle size={18} className="animate-spin" />
            Membuka lembaga…
          </>
        ) : (
          <>
            Lanjutkan
            <ArrowRight size={18} />
          </>
        )}
      </Button>
    </form>
  );
}
