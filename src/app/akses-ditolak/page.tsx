import Link from "next/link";
export default function Page() {
  return (
    <main className="mx-auto max-w-lg px-6 py-24">
      <h1 className="text-2xl font-bold">Akses tidak diizinkan</h1>
      <p className="mt-4 leading-7 text-slate-600">
        Hubungi administrator lembaga untuk memeriksa keanggotaan dan izin Anda.
      </p>
      <Link
        href="/login"
        className="mt-6 inline-block font-semibold text-teal-800"
      >
        Kembali ke halaman masuk
      </Link>
    </main>
  );
}
