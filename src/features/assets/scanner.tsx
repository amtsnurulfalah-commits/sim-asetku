"use client";
import { useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";
import { AdminShell, Feedback } from "@/features/admin/ui-shared";
import { Button } from "@/components/ui/button";
import { api } from "./client";
export function Scanner({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const video = useRef<HTMLVideoElement>(null),
    controls = useRef<IScannerControls | null>(null),
    alive = useRef(true),
    found = useRef(false),
    [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [value, setValue] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controls.current?.stop();
    };
  }, []);
  function stop() {
    controls.current?.stop();
    controls.current = null;
    setActive(false);
  }
  async function resolve(text: string) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ path: string }>(
        "resolve?value=" + encodeURIComponent(text),
        tenantId,
      );
      if (!/^\/aset\/qr\/[a-f0-9-]{36}$/.test(r.path))
        throw new Error("Tujuan QR tidak valid.");
      stop();
      window.location.assign(r.path);
    } catch (e) {
      setError((e as Error).message);
      found.current = false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    found.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext)
        throw new Error(
          "Kamera memerlukan HTTPS dan dukungan browser. Gunakan input kode manual.",
        );
      const { BrowserQRCodeReader } = await import("@zxing/browser"),
        reader = new BrowserQRCodeReader();
      const c = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        video.current!,
        (result) => {
          if (result && !found.current) {
            found.current = true;
            void resolve(result.getText());
          }
        },
      );
      if (!alive.current) {
        c.stop();
        return;
      }
      controls.current = c;
      setActive(true);
    } catch {
      setError(
        "Kamera belum dapat digunakan atau izin ditolak. Periksa izin browser atau masukkan kode manual.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <AdminShell title="Pindai QR Aset" tenant={tenantName}>
      <Feedback error={error} message="" />
      <section className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6">
        <p className="text-sm leading-6 text-slate-600">
          Arahkan kamera ke label aset. Hanya aset pada lembaga aktif dan sesuai
          izin yang dapat ditampilkan.
        </p>
        <video
          ref={video}
          muted
          playsInline
          className="mt-5 aspect-video w-full rounded-xl bg-slate-950"
        />
        <div className="mt-4 flex gap-3">
          <Button disabled={busy || active} onClick={start}>
            Aktifkan kamera
          </Button>
          <Button variant="outline" disabled={!active} onClick={stop}>
            Hentikan kamera
          </Button>
        </div>
        <form
          className="mt-7 border-t border-slate-100 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            void resolve(value);
          }}
        >
          <label className="text-sm font-medium" htmlFor="manual-code">
            Kode inventaris atau URL QR
          </label>
          <input
            id="manual-code"
            className="field mt-2"
            maxLength={500}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
          <Button className="mt-4" disabled={busy || !value.trim()}>
            Buka aset
          </Button>
        </form>
      </section>
    </AdminShell>
  );
}
