import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";
import { pageSession } from "@/features/auth/server";
import { TenantPicker } from "@/features/auth/tenant-picker";
import { LogoutButton } from "@/features/auth/logout-button";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function Page() {
  const x = await pageSession(false);
  if (x.is_operator && !x.memberships.length) redirect("/platform/lembaga");
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
        <div className="mb-5 inline-flex rounded-2xl bg-teal-50 p-3 text-teal-800">
          <Building2 size={28} />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Pilih lembaga</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Selamat datang, {x.user.full_name_snapshot}. Pilih lembaga yang akan
          Anda kelola.
        </p>
        <TenantPicker
          items={x.memberships.map((m) => ({
            id: m.tenant_id,
            name: m.tenant_name,
          }))}
          active={x.session.active_tenant_id}
        />
        <div className="mt-6 flex justify-center">
          <LogoutButton />
        </div>
      </section>
    </main>
  );
}
