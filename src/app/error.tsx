"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-lg p-8 pt-24">
      <h1 className="text-2xl font-bold">Halaman belum dapat dimuat</h1>
      <p className="my-5 leading-7 text-slate-600">
        Layanan sementara tidak tersedia atau konfigurasi belum lengkap. Coba
        kembali atau hubungi administrator.
      </p>
      <Button onClick={reset}>Coba kembali</Button>
    </main>
  );
}
