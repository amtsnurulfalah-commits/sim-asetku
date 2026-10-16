'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AdminShell, Feedback } from '@/features/admin/ui-shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { statusText } from '@/features/supply/schemas';
import { transactionApi } from './client';
import { TransactionForm } from './form';
import { kinds, labels, permission, type Kind, type Options, type List } from './schemas';
export function TransactionPanel({ tenantId, tenantName }: {
    tenantId: string;
    tenantName: string;
}) {
    const [o, setO] = useState<Options | null>(null), [list, setList] = useState<List | null>(null), [kind, setKind] = useState<Kind>('movement'), [status, setStatus] = useState('all'), [query, setQuery] = useState(''), [page, setPage] = useState(1), [open, setOpen] = useState(false), [policy, setPolicy] = useState(false), [reason, setReason] = useState(''), [mode, setMode] = useState('disabled'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [alerts, setAlerts] = useState<{
        overdue: {
            id: string;
            document_number: string;
            borrower_name: string;
            due_at: string;
            outstanding: string;
        }[];
        maintenance: {
            id: string;
            name: string;
            next_due_at: string;
        }[];
    } | null>(null);
    const load = useCallback(async (signal?: AbortSignal) => { const [opts, rows, a] = await Promise.all([transactionApi<Options>('options', tenantId, undefined, signal), transactionApi<List>('list?' + new URLSearchParams({ kind, status, query, page: String(page) }), tenantId, undefined, signal), transactionApi<typeof alerts>('alerts', tenantId, undefined, signal)]); if (signal?.aborted)
        return; setO(opts); setMode(opts.mode); setList(rows); setAlerts(a); }, [tenantId, kind, status, query, page]);
    useEffect(() => { const c = new AbortController(); const timer = setTimeout(() => load(c.signal).catch(e => { if (!c.signal.aborted)
        setError(e.message); }), 200); return () => { clearTimeout(timer); c.abort(); }; }, [load]);
    return <AdminShell title="Transaksi Inventaris" tenant={tenantName}><Feedback error={error} message=""/>
 <div className="mb-6 grid gap-4 md:grid-cols-2"><section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Peminjaman terlambat</h2>{alerts?.overdue.length === 0 && <p className="mt-2 text-sm text-slate-500">Tidak ada pinjaman terlambat.</p>}<ul className="mt-2 max-h-36 overflow-auto text-sm">{alerts?.overdue.map(a => <li key={a.id} className="py-1"><Link className="text-teal-800 underline" href={'/transaksi/' + a.id}>{a.document_number}</Link> · {a.borrower_name} · {a.outstanding} aset · {new Date(a.due_at).toLocaleDateString('id-ID')}</li>)}</ul></section><section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Jadwal pemeliharaan jatuh tempo</h2><p className="mt-1 text-xs text-slate-500">Daftar pengingat di aplikasi; maksimal 100 entri.</p><ul className="mt-2 max-h-36 overflow-auto text-sm">{alerts?.maintenance.map(a => <li key={a.id} className="py-1">{a.name} · {new Date(a.next_due_at).toLocaleDateString('id-ID')}</li>)}</ul></section></div>
 <section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap gap-3"><label>Jenis transaksi<select className="field mt-1" value={kind} onChange={e => { setKind(e.target.value as Kind); setPage(1); }}>{kinds.map(k => <option key={k} value={k}>{labels[k]}</option>)}</select></label><label>Status<select className="field mt-1" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">Semua</option>{Object.entries(statusText).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label><label className="flex-1">Cari nomor / alasan<input className="field mt-1" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} maxLength={180}/></label></div>
 <div className="my-5 flex flex-wrap gap-3">{o?.permissions.includes(permission(kind)) && <Button onClick={() => setOpen(true)}>Buat {labels[kind].toLowerCase()}</Button>}{o?.permissions.includes('settings.manage') && <Button variant="outline" onClick={() => setPolicy(true)}>Kebijakan review</Button>}<p className="self-center text-xs text-slate-500">Review: {o?.mode === 'single_admin_v1' ? 'Satu admin independen' : 'Belum diaktifkan'}</p></div>
 <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Nomor</th><th>Tanggal</th><th>Status</th><th>Alasan</th></tr></thead><tbody>{list?.rows.map(d => <tr className="border-b" key={d.id}><td className="p-3"><Link href={'/transaksi/' + d.id} className="font-semibold text-teal-800 underline">{d.document_number}</Link></td><td>{d.business_date}</td><td>{statusText[d.status] ?? d.status}</td><td className="max-w-xs truncate">{d.payload.reason}</td></tr>)}</tbody></table>{list?.rows.length === 0 && <p className="p-8 text-center text-slate-500">Belum ada transaksi.</p>}</div><div className="mt-5 flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</Button><span>Halaman {page}</span><Button variant="outline" disabled={!list?.hasMore} onClick={() => setPage(p => p + 1)}>Berikutnya</Button></div></section>
 <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-3xl"><DialogTitle>{labels[kind]}</DialogTitle><DialogDescription>Lengkapi dokumen dan aset yang akan diproses.</DialogDescription>{o && <TransactionForm o={o} kind={kind} onDone={id => window.location.assign('/transaksi/' + id)}/>}</DialogContent></Dialog>
 <Dialog open={policy} onOpenChange={setPolicy}><DialogContent><DialogTitle>Kebijakan review transaksi aset</DialogTitle><DialogDescription>Review satu admin yang berbeda dari pemohon dan pemeriksa. Approval multilevel tersedia pada Tahap 9. Workflow umum yang aktif tidak dapat dilewati.</DialogDescription><form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        await transactionApi('policy', tenantId, { mode, reason });
        setPolicy(false);
        setReason('');
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>{error && <p role="alert" className="text-red-700">{error}</p>}<label className="block">Kebijakan<select className="field mt-2" value={mode} onChange={e => setMode(e.target.value)}><option value="disabled">Nonaktif</option><option value="single_admin_v1">Satu admin independen</option></select></label><label className="block">Alasan<textarea className="field mt-2" required minLength={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label><Button disabled={busy}>Simpan kebijakan</Button></form></DialogContent></Dialog>
 </AdminShell>;
}
