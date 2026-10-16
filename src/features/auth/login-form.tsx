"use client";
import { useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { authPost, go } from "./client";
export function LoginForm() {
  const [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    const form = e.currentTarget,
      data = new FormData(form);
    try {
      const r = await authPost("/api/auth/login", {
        username: String(data.get("username") ?? ""),
        password: String(data.get("password") ?? ""),
      });
      go(r.next);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Layanan belum tersedia.");
    } finally {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-8 space-y-5" aria-busy={busy}>
      <div>
        <label
          htmlFor="username"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          Username
        </label>
        <input
          id="username"
          name="username"
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={128}
          placeholder="Masukkan username Anda"
          className="field"
          disabled={busy}
        />
      </div>
      <div>
        <label
          htmlFor="password"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            required
            type={show ? "text" : "password"}
            autoComplete="current-password"
            className="field pr-14"
            placeholder="Masukkan password Anda"
            disabled={busy}
          />
          <button
            type="button"
            aria-label={show ? "Sembunyikan password" : "Tampilkan password"}
            onClick={() => setShow(!show)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-500 focus-visible:outline-2"
          >
            {show ? <EyeOff size={19} /> : <Eye size={19} />}
          </button>
        </div>
      </div>
      {message && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {message}
        </p>
      )}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? (
          <>
            <LoaderCircle size={18} className="animate-spin" />
            Memverifikasi akun…
          </>
        ) : (
          <>
            Masuk
            <ArrowRight size={18} />
          </>
        )}
      </Button>
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
        <ShieldCheck size={17} className="mt-0.5 shrink-0" />
        Gunakan akun Central SSO yang telah diberi akses oleh administrator
        lembaga.
      </p>
    </form>
  );
}
