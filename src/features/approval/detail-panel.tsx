'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminShell, Feedback } from '@/features/admin/ui-shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { money } from '@/features/assets/client';
import { statusText } from '@/features/supply/schemas';
import { approvalApi } from './client';
import { labels, type Detail, type Options } from './schemas';
const decisions: Record<string, string> = { approved: 'Setujui', rejected: 'Tolak', revision_required: 'Minta revisi', cancel: 'Batalkan pengajuan', return: 'Kembalikan untuk revisi' };
const lineLabels: Record<string, string> = { period: 'Periode', amount: 'Beban / koreksi', cost: 'Nilai perolehan', residual: 'Residu', prior: 'Akumulasi sebelum', target: 'Akumulasi sesudah', bookBefore: 'Nilai buku sebelum', bookAfter: 'Nilai buku sesudah', remainingMonths: 'Sisa bulan', convention: 'Prorata', status: 'Kelayakan', name: 'Nama / uraian', code: 'Kode', quantity: 'Jumlah', accepted: 'Diterima baik', unitCost: 'Harga per unit', unit: 'Satuan', destination: 'Klasifikasi', room: 'Ruangan awal', condition: 'Kondisi awal', finding: 'Hasil pemeriksaan', observedRoom: 'Ruangan fisik', observedCondition: 'Kondisi fisik', notes: 'Catatan' };
const words: Record<string, string> = { asset: 'Aset tetap', inventory: 'Persediaan', matched: 'Sesuai', not_found: 'Tidak ditemukan', condition_changed: 'Kondisi berubah', location_changed: 'Lokasi berbeda', follow_up: 'Perlu tindak lanjut', pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', revision_required: 'Perlu revisi', cancelled: 'Dibatalkan' };
export function ApprovalDetail({ tenantId, tenantName, id }: {
    tenantId: string;
    tenantName: string;
    id: string;
}) {
    const [d, setD] = useState<Detail | null>(null), [o, setO] = useState<Options | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [decision, setDecision] = useState<string | null>(null), [reason, setReason] = useState(''), [page, setPage] = useState(1);
    const key = useRef(crypto.randomUUID());
    const load = useCallback(async (signal?: AbortSignal) => { const [d, o] = await Promise.all([approvalApi<Detail>('detail?id=' + id, tenantId, undefined, signal), approvalApi<Options>('options', tenantId, undefined, signal)]); if (signal?.aborted)
        return; setD(d); setO(o); }, [tenantId, id]);
    useEffect(() => { const c = new AbortController(); const timer = setTimeout(() => load(c.signal).catch(e => { if (!c.signal.aborted)
        setError(e.message); }), 0); return () => { clearTimeout(timer); c.abort(); }; }, [load]);
    const available: string[] = [];
    if (d?.canDecide) {
        available.push('approved');
        if (d.workflow.rules.reject)
            available.push('rejected');
        if (d.workflow.rules.revision)
            available.push('revision_required');
    }
    // Owner cancellation and approved-document revision use the current document version.
    if (d?.isOwner && d.revision === d.currentRevision && ['pending', 'partially_approved', 'revision_required'].includes(d.documentStatus))
        available.push('cancel');
    if (d && d.revision === d.currentRevision && !d.isOwner && o?.canManage && d.documentStatus === 'approved' && d.status === 'approved' && d.workflow.rules.revision)
        available.push('return');
    return <AdminShell title="Detail Persetujuan" tenant={tenantName}><Link className="text-sm text-teal-800 underline" href="/approval">Kembali ke inbox</Link><Feedback error={error} message=""/>{d && <div className="mt-5 space-y-6"><section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-4"><div><h2 className="text-xl font-bold">{d.documentNumber}</h2><p className="mt-2 text-sm text-slate-500">{labels[d.type]} · Revisi {d.revision} · {statusText[d.status] ?? d.status}</p><p className="mt-2 text-sm">Pemohon: {d.requestedName}</p><p className="mt-2 font-semibold">Nominal saat pengajuan: {money(d.amount)}</p><p className="mt-1 text-xs text-slate-500">{d.workflow.name} · Versi {d.workflow.version} · Level aktif {d.currentLevel}</p></div><div className="flex flex-wrap items-start gap-2">{available.map(v => <Button variant={v === 'rejected' || v === 'cancel' ? 'outline' : 'default'} disabled={busy} key={v} onClick={() => { setDecision(v); setReason(''); key.current = crypto.randomUUID(); }}>{decisions[v]}</Button>)}</div></div><Link className="mt-4 inline-block text-sm text-teal-800 underline" href={(d.type.startsWith('finance:') ? '/penyusutan/' : d.type.startsWith('supply:') ? '/pengadaan/' : '/transaksi/') + d.documentId}>Buka dokumen terkini dan lampiran</Link><p className="mt-2 text-xs text-slate-500">Ringkasan di bawah adalah snapshot saat diajukan. Status dokumen terkini: {statusText[d.documentStatus] ?? d.documentStatus}.</p></section>
 <section className="rounded-2xl border bg-white p-5"><h2 className="text-lg font-semibold">Urutan persetujuan</h2><ol className="mt-4 grid gap-3 sm:grid-cols-2">{d.steps.map(s => <li key={s.id} className={'rounded-xl border p-4 ' + (s.level === d.currentLevel ? 'border-teal-500 bg-teal-50' : 'border-slate-200')}><p className="font-semibold">Level {s.level}: {s.name}</p><p className="mt-1 text-sm">{words[s.status] ?? s.status}</p></li>)}</ol></section>
 <section className="rounded-2xl border bg-white p-5"><h2 className="text-lg font-semibold">Snapshot dokumen</h2><p className="mt-3 text-sm">Tanggal: {d.summary.date}</p><p className="mt-3 whitespace-pre-wrap">{d.summary.reason}</p><dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">{[['borrower', 'Peminjam'], ['targetRoom', 'Ruangan tujuan'], ['targetCondition', 'Kondisi tujuan'], ['responsible', 'Penanggung jawab']].map(([k, label]) => { const value = d.summary[k as keyof typeof d.summary]; return typeof value === 'string' && value ? <div key={k}><dt className="text-slate-500">{label}</dt><dd>{value}</dd></div> : null; })}</dl><p className="mt-5 text-sm font-semibold">{d.summary.lines.length} baris</p><div className="mt-3 space-y-3">{d.summary.lines.slice((page - 1) * 50, page * 50).map((l, i) => <dl key={i} className="grid gap-2 rounded-xl border p-4 text-sm sm:grid-cols-2">{Object.entries(l).filter(([, v]) => v !== null && v !== '').map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{lineLabels[k] ?? k}</dt><dd className="break-words">{['unitCost','amount','cost','residual','prior','target','bookBefore','bookAfter'].includes(k) ? money(v) : ({full_month:'Bulan awal penuh',next_month:'Mulai bulan berikutnya',daily:'Prorata hari aktual',prospective_full_month:'Jadwal bulanan prospektif',ready:'Siap',excluded:'Dikecualikan'} as Record<string,string>)[String(v)] ?? words[String(v)] ?? v}</dd></div>)}</dl>)}</div><div className="mt-4 flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</Button><span>Halaman {page}</span><Button variant="outline" disabled={page * 50 >= d.summary.lines.length} onClick={() => setPage(p => p + 1)}>Berikutnya</Button></div>{d.summary.unregistered.length > 0 && <div className="mt-5"><h3 className="font-semibold">Barang tidak terdaftar</h3><ul className="mt-2 max-h-48 overflow-auto text-sm">{d.summary.unregistered.map((v, i) => <li className="py-1" key={i}>{v}</li>)}</ul></div>}{d.files.length > 0 && <div className="mt-5"><h3 className="font-semibold">Dokumen pendukung saat pengajuan</h3><ul className="mt-2 text-sm">{d.files.map(f => <li key={f.id}>{f.name} · {f.sensitivity === 'sensitive' ? 'Sensitif' : 'Normal'}</li>)}</ul></div>}</section>
 <section className="rounded-2xl border bg-white p-5"><h2 className="text-lg font-semibold">Keputusan dan audit</h2><ol className="mt-4 space-y-4">{d.actions.map(a => <li key={a.id} className="border-l-2 border-teal-200 pl-4"><p className="font-semibold">Level {a.level} · {words[a.decision] ?? a.decision} · {a.actor_name}</p><p className="text-sm">{a.reason}</p><time className="text-xs text-slate-500">{new Date(a.created_at).toLocaleString('id-ID')}</time></li>)}</ol><details className="mt-5"><summary className="cursor-pointer text-sm font-semibold">Peristiwa dokumen (maksimal 200 terbaru)</summary><ul className="mt-4 space-y-3 text-sm">{d.events.map(e => <li key={e.id}><strong>{({ submit: 'Pengajuan', approved: 'Persetujuan', rejected: 'Penolakan', revision_required: 'Permintaan revisi', cancel: 'Pembatalan', return_for_revision: 'Dikembalikan untuk revisi' } as Record<string, string>)[e.action] ?? e.action} · {e.actor_name}</strong><p>{e.reason}</p><time className="text-xs text-slate-500">{new Date(e.created_at).toLocaleString('id-ID')}</time></li>)}</ul></details></section>
 <Dialog open={decision !== null} onOpenChange={v => { if (!v && !busy)
            setDecision(null); }}><DialogContent><DialogTitle>{decisions[decision ?? '']}</DialogTitle><DialogDescription>Keputusan dicatat pada server untuk level dan versi yang sedang ditampilkan. Periksa snapshot sebelum melanjutkan.</DialogDescription><form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
            if (decision === 'cancel' || decision === 'return')
                await approvalApi(decision, tenantId, { documentId: d.documentId, version: d.documentVersion, reason });
            else
                await approvalApi('decide', tenantId, { instanceId: d.id, version: d.rowVersion, level: d.currentLevel, decision, reason, key: key.current });
            setDecision(null);
            await load();
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setBusy(false);
        } }}>{error && <p role="alert" className="text-red-700">{error}</p>}<label className="block text-sm">Alasan<textarea className="field mt-2" required minLength={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label><Button disabled={busy}>{busy ? 'Memproses…' : decisions[decision ?? '']}</Button></form></DialogContent></Dialog>
 </div>}</AdminShell>;
}
