export default function Loading() {
  return (
    <main
      className="mx-auto max-w-5xl p-8"
      aria-busy="true"
      aria-label="Memuat halaman"
    >
      <p className="text-sm text-slate-500">Memuat halaman…</p>
      <div className="mt-6 h-24 animate-pulse rounded-2xl bg-slate-200" />
    </main>
  );
}
