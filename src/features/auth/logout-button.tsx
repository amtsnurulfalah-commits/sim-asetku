"use client";
import { useRef, useState } from "react";
import { LogOut, LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { authPost, go } from "./client";
export function LogoutButton() {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  async function logout() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      go((await authPost("/api/auth/logout")).next);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Logout belum berhasil. Coba kembali.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen(true);
          setError("");
        }}
      >
        <LogOut size={17} />
        Keluar
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="mb-4 inline-flex rounded-full bg-amber-50 p-3 text-amber-700">
            <LogOut size={24} />
          </div>
          <DialogTitle className="text-xl font-bold text-slate-900">
            Keluar dari aplikasi?
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm leading-6 text-slate-600">
            Anda perlu masuk kembali untuk mengakses inventaris lembaga.
          </DialogDescription>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Batal
            </Button>
            <Button variant="destructive" disabled={busy} onClick={logout}>
              {busy ? (
                <>
                  <LoaderCircle size={17} className="animate-spin" />
                  Memproses…
                </>
              ) : (
                "Ya, keluar"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
