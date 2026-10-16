import { Boxes, Building2, Layers3, ShieldCheck } from "lucide-react";
import { LoginForm } from "@/features/auth/login-form";
export const dynamic = "force-dynamic";
export default function LoginPage() {
  return (
    <main className="min-h-dvh lg:grid lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-teal-950 p-12 text-white lg:flex lg:flex-col xl:p-16">
        <div className="flex items-center gap-3 text-xl font-bold">
          <span className="rounded-xl bg-white/10 p-3">
            <Boxes size={27} />
          </span>
          Inventaris
          <span className="ml-1 rounded-full border border-white/20 px-3 py-1 text-[10px] tracking-widest text-teal-200">
            PENDIDIKAN
          </span>
        </div>
        <div className="relative z-10 my-auto max-w-lg py-16">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[.25em] text-teal-300">
            Tertata. Terjaga. Terpantau.
          </p>
          <h1 className="text-5xl font-bold leading-[1.15] tracking-tight xl:text-6xl">
            Aset lembaga,
            <br />
            <span className="text-teal-300">dikelola bersama.</span>
          </h1>
          <p className="mt-7 max-w-sm text-base leading-8 text-teal-100/80">
            Ruang kerja inventaris untuk madrasah dan sekolah Anda.
          </p>
          <div className="mt-12 space-y-5 text-sm text-teal-100">
            {[
              [Building2, "Ruang kerja untuk setiap lembaga"],
              [Layers3, "Akses sesuai tanggung jawab"],
              [ShieldCheck, "Satu identitas Central SSO"],
            ].map(([Icon, label]) => {
              const I = Icon as typeof Building2;
              return (
                <p key={String(label)} className="flex items-center gap-3">
                  <I size={20} className="text-teal-300" />
                  {String(label)}
                </p>
              );
            })}
          </div>
        </div>
        <p className="text-xs text-teal-100/50">
          Sistem Informasi Inventaris Madrasah / Sekolah
        </p>
        <div
          aria-hidden
          className="absolute -bottom-36 -right-32 h-[420px] w-[420px] rounded-full border-[70px] border-teal-800/30"
        />
      </section>
      <section className="flex min-h-dvh items-center justify-center px-6 py-12 sm:px-12">
        <div className="w-full max-w-sm">
          <div className="mb-12 flex items-center gap-2 font-bold text-teal-900 lg:hidden">
            <Boxes size={27} />
            Inventaris
          </div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-teal-700">
            Selamat datang
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            Masuk ke ruang kerja
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Kelola inventaris lembaga melalui akses yang telah diberikan kepada
            Anda.
          </p>
          <LoginForm />
          <p className="mt-12 border-t border-slate-200 pt-6 text-center text-xs leading-5 text-slate-500">
            Belum memiliki akses? Hubungi administrator inventaris lembaga Anda.
          </p>
        </div>
      </section>
    </main>
  );
}
