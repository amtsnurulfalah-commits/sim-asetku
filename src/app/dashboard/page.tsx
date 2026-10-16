import Link from "next/link";
import {Statistics} from "@/features/reports/statistics";
import {
  Boxes,
  Building2,
  CheckCircle2,
  ArrowRight,
  UserRound,
} from "lucide-react";
import { pageSession, auth } from "@/features/auth/server";
import { LogoutButton } from "@/features/auth/logout-button";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Dashboard() {
  const x = await pageSession(true, "dashboard.view");
  const tenant = x.memberships.find(
    (m) => m.tenant_id === x.session.active_tenant_id,
  )!;
  const permissions = await auth().repo.permissions(x);
  return (
    <main className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
          <span className="flex items-center gap-3 text-lg font-bold text-teal-900">
            <Boxes size={26} />
            Inventaris
          </span>
          <LogoutButton />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">
          Ruang kerja lembaga
        </p>
        <h1 className="mt-3 break-words text-3xl font-bold text-slate-900">
          {tenant.tenant_name}
        </h1>
        <p className="mt-3 text-slate-500">
          Selamat datang, {x.user.full_name_snapshot}.
        </p>
        <section className="mt-8 rounded-2xl border border-teal-200 bg-teal-50 p-6 sm:p-8">
          <div className="flex gap-4">
            <CheckCircle2 className="mt-1 shrink-0 text-teal-700" size={27} />
            <div>
              <h2 className="text-lg font-bold text-teal-950">
                Akses lembaga aktif
              </h2>
              <p className="mt-2 text-sm leading-7 text-teal-900/80">
                Anda masuk dengan akun yang memiliki keanggotaan aktif pada
                lembaga ini.
              </p>
            </div>
          </div>
        </section>
        {tenant.tenant_status === "setup" && (
          <p
            role="status"
            className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
          >
            Lembaga sedang dalam penyiapan. Lengkapi profil dan koneksi Google
            Drive sebelum aktivasi operasional.
          </p>
        )}
        <Statistics tenantId={tenant.tenant_id}/>
        <nav className="mt-6 flex flex-wrap gap-3" aria-label="Pengelolaan">
          {permissions.includes("inventory.view") && (
            <Link
              href="/persediaan"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Persediaan dan pengadaan
            </Link>
          )}
          {permissions.includes("assets.view") && <Link href="/penyusutan" className="rounded-xl border bg-white px-4 py-3 text-sm font-semibold text-teal-800">Penyusutan dan nilai buku</Link>}
          {permissions.includes("reports.view")&&<Link href="/laporan" className="rounded-xl border bg-white px-4 py-3 text-sm font-semibold text-teal-800">Laporan, KIB dan KIR</Link>}
          {permissions.includes("approval.access")&&<Link href="/approval" prefetch={false} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800">Inbox persetujuan</Link>}
          {permissions.includes("assets.view") && <Link href="/transaksi" prefetch={false} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800">Transaksi aset</Link>}
          {permissions.includes("assets.view") && (
            <Link
              href="/aset"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Aset tetap
            </Link>
          )}
          {permissions.includes("settings.manage") && (
            <Link
              href="/master-data"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Master data
            </Link>
          )}
          {permissions.includes("users.manage") && (
            <Link
              href="/administrasi/pengguna"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Kelola pengguna
            </Link>
          )}
          {permissions.includes("settings.manage") && (
            <Link
              href="/administrasi/profil"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Profil lembaga
            </Link>
          )}
          {x.is_operator && (
            <Link
              href="/platform/lembaga"
              prefetch={false}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-teal-800"
            >
              Pengelolaan platform
            </Link>
          )}
        </nav>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <UserRound className="text-teal-700" />
            <h2 className="mt-4 font-bold text-slate-900">Profil akses</h2>
            <p className="mt-3 break-words text-sm text-slate-600">
              {x.user.username_snapshot}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              {permissions.length} izin tersedia sesuai penugasan Anda.
            </p>
          </section>
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <Building2 className="text-teal-700" />
            <h2 className="mt-4 font-bold text-slate-900">Lembaga Anda</h2>
            <p className="mt-3 text-sm text-slate-500">
              Pilih ruang kerja sesuai keanggotaan yang diberikan administrator.
            </p>
            <Link
              href="/pilih-lembaga"
              prefetch={false}
              className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-teal-800"
            >
              Pilih lembaga
              <ArrowRight size={16} />
            </Link>
          </section>
        </div>
      </div>
    </main>
  );
}
