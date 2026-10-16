'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell, Feedback } from '@/features/admin/ui-shared';
import { Button } from '@/components/ui/button';
import { statusText } from '@/features/supply/schemas';
import { approvalApi } from './client';
import { labels, type InstanceRow, type Options } from './schemas';
export function ApprovalInbox({ tenantId, tenantName }: {
    tenantId: string;
    tenantName: string;
}) {
    const [tab, setTab] = useState('inbox'), [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [page, setPage] = useState(1), [o, setO] = useState<Options | null>(null), [data, setData] = useState<{
        rows: InstanceRow[];
        hasMore: boolean;
    } | null>(null), [error, setError] = useState('');
    useEffect(() => { const c = new AbortController(); const timer = setTimeout(() => Promise.all([approvalApi<Options>('options', tenantId, undefined, c.signal), approvalApi<typeof data>('list?' + new URLSearchParams({ tab, query, status, page: String(page) }), tenantId, undefined, c.signal)]).then(([o, d]) => { if (!c.signal.aborted) {
        setO(o);
        setData(d);
    } }).catch(e => { if (!c.signal.aborted)
        setError(e.message); }), 200); return () => { clearTimeout(timer); c.abort(); }; }, [tenantId, tab, query, status, page]);
    return <AdminShell title="Inbox Persetujuan" tenant={tenantName}><Feedback error={error} message=""/>
 <div className="mb-5 flex flex-wrap gap-2">{[['inbox', 'Menunggu saya'], ['mine', 'Pengajuan saya'], ['history', 'Riwayat yang dapat diakses']].map(([v, l]) => <Button variant={tab === v ? 'default' : 'outline'} key={v} onClick={() => { setTab(v); setPage(1); }}>{l}</Button>)}{o?.canManage && <Link className="self-center px-3 text-sm font-semibold text-teal-800 underline" href="/approval/workflow">Konfigurasi workflow dan delegasi</Link>}</div>
 <section className="rounded-2xl border bg-white p-5"><p className="mb-5 text-sm text-slate-500">Hanya level aktif yang dapat diputuskan. Riwayat menampilkan snapshot tiap revisi yang Anda berwenang akses.</p><div className="mb-5 flex flex-wrap gap-3"><label className="flex-1 text-sm">Cari nomor dokumen<input className="field mt-2" maxLength={180} value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/></label><label className="text-sm">Status<select className="field mt-2" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">Semua</option>{['pending', 'partially_approved', 'approved', 'rejected', 'revision_required', 'cancelled'].map(s => <option value={s} key={s}>{statusText[s] ?? s}</option>)}</select></label></div>
 <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Dokumen</th><th>Workflow</th><th>Level</th><th>Status</th></tr></thead><tbody>{data?.rows.map(r => <tr key={r.id} className="border-b"><td className="p-3"><Link className="font-semibold text-teal-800 underline" href={'/approval/' + r.id}>{r.document_number}</Link><p className="mt-1 text-xs text-slate-500">{labels[r.document_type]} · Revisi {r.document_revision}</p></td><td>{r.workflow_name}</td><td>{r.current_level}</td><td>{statusText[r.status] ?? r.status}{r.can_decide && <p className="text-xs text-teal-700">Giliran Anda</p>}</td></tr>)}</tbody></table>{data?.rows.length === 0 && <p className="p-8 text-center text-slate-500">Tidak ada pengajuan pada filter ini.</p>}</div><div className="mt-5 flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</Button><span>Halaman {page}</span><Button variant="outline" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>Berikutnya</Button></div></section></AdminShell>;
}
