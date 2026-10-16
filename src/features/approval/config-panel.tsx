'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AdminShell, Feedback } from '@/features/admin/ui-shared';
import { money } from '@/features/assets/client';
import { approvalApi } from './client';
import { WorkflowForm } from './config-form';
import { labels, requiredPermission, type Options, type Workflow, type Delegation, type Type } from './schemas';
type History = {
    versions: {
        version: number;
        activation_conditions: {
            minAmount: string;
            maxAmount: string | null;
            scope: string;
        };
        allow_self_approval: boolean;
        published_at: string;
        steps: {
            level: number;
            name: string;
            permission: string;
        }[];
    }[];
    events: {
        id: string;
        action: string;
        reason: string;
        created_at: string;
        actor_name: string;
    }[];
};
export function WorkflowPanel({ tenantId, tenantName }: {
    tenantId: string;
    tenantName: string;
}) {
    const [o, setO] = useState<Options | null>(null), [rows, setRows] = useState<{
        rows: Workflow[];
        hasMore: boolean;
    } | null>(null), [query, setQuery] = useState(''), [page, setPage] = useState(1), [delegates, setDelegates] = useState<{
        rows: Delegation[];
        hasMore: boolean;
    } | null>(null), [delegatePage, setDelegatePage] = useState(1), [error, setError] = useState(''), [busy, setBusy] = useState(false), [edit, setEdit] = useState<Workflow | null | undefined>(undefined), [deactivate, setDeactivate] = useState<Workflow | null>(null), [reason, setReason] = useState(''), [history, setHistory] = useState<History | null>(null), [historyOpen, setHistoryOpen] = useState(false), [delegateOpen, setDelegateOpen] = useState(false), [workflowId, setWorkflowId] = useState(''), [fromId, setFromId] = useState(''), [toId, setToId] = useState(''), [startAt, setStartAt] = useState(''), [endAt, setEndAt] = useState(''), [revoke, setRevoke] = useState<Delegation | null>(null);
    const load = useCallback(async (signal?: AbortSignal) => { const [opts, w, d] = await Promise.all([approvalApi<Options>('options', tenantId, undefined, signal), approvalApi<typeof rows>('workflows?' + new URLSearchParams({ query, page: String(page) }), tenantId, undefined, signal), approvalApi<typeof delegates>('delegates?page=' + delegatePage, tenantId, undefined, signal)]); if (signal?.aborted)
        return; setO(opts); setRows(w); setDelegates(d); }, [tenantId, query, page, delegatePage]);
    useEffect(() => { const c = new AbortController(); const timer = setTimeout(() => load(c.signal).catch(e => { if (!c.signal.aborted)
        setError(e.message); }), 200); return () => { clearTimeout(timer); c.abort(); }; }, [load]);
    async function act(fn: () => Promise<void>) { setBusy(true); setError(''); try {
        await fn();
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    const memberName = (id: string) => o?.members.find(m => m.id === id)?.name ?? 'Anggota nonaktif';
    const selectedWorkflow = rows?.rows.find(w => w.id === workflowId);
    const eligible = selectedWorkflow && labels[selectedWorkflow.transaction_type as Type] ? o?.members.filter(m => m.permissions.includes('approval.access') && m.permissions.includes(requiredPermission(selectedWorkflow.transaction_type as Type))) ?? [] : [];
    return <AdminShell title="Workflow dan Delegasi Persetujuan" tenant={tenantName}><Link className="text-sm text-teal-800 underline" href="/approval">Kembali ke inbox</Link><Feedback error={error} message=""/>
 <p className="my-5 text-sm leading-6 text-slate-600">Publikasikan urutan persetujuan, lingkup dan batas nominal untuk pengajuan baru. Setiap publikasi membuat versi tetap; pengajuan berjalan memakai snapshot sebelumnya. Delegasi hanya berlaku untuk satu workflow dan periode yang ditetapkan.</p>
 <section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-end justify-between gap-3"><label className="flex-1 text-sm">Cari nama / kode<input className="field mt-2" maxLength={180} value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/></label><Button disabled={!o?.canManage} onClick={() => setEdit(null)}>Buat workflow</Button></div><div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Workflow</th><th>Jenis dan nominal</th><th>Status</th><th>Tindakan</th></tr></thead><tbody>{rows?.rows.map(w => <tr className="border-b" key={w.id}><td className="p-3 font-semibold">{w.name}<p className="text-xs font-normal text-slate-500">{w.code} · Versi {w.version ?? 'belum dipublikasikan'} · {w.steps.length} level</p></td><td>{labels[w.transaction_type as Type] ?? 'Konfigurasi legacy'}<p className="text-xs text-slate-500">{w.activation_conditions ? `${money(w.activation_conditions.minAmount)} ≤ nominal ${w.activation_conditions.maxAmount ? ' < ' + money(w.activation_conditions.maxAmount) : '(tanpa batas atas)'}` : 'Belum ada versi engine'}</p></td><td>{w.status === 'active' ? 'Aktif' : 'Nonaktif'}</td><td><div className="flex flex-wrap gap-2">{labels[w.transaction_type as Type] && <Button variant="outline" disabled={busy} onClick={() => setEdit(w)}>Versi baru</Button>}<Button variant="outline" disabled={busy} onClick={() => act(async () => { setHistory(await approvalApi<History>('history?id=' + w.id, tenantId)); setHistoryOpen(true); })}>Riwayat</Button>{w.status === 'active' && <Button variant="outline" disabled={busy} onClick={() => { setDeactivate(w); setReason(''); }}>Nonaktifkan</Button>}</div></td></tr>)}</tbody></table>{rows?.rows.length === 0 && <p className="p-8 text-center text-slate-500">Belum ada workflow. Draf transaksi tetap dapat disiapkan.</p>}</div><div className="mt-5 flex items-center gap-3"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</Button><span>Halaman {page}</span><Button variant="outline" disabled={!rows?.hasMore} onClick={() => setPage(p => p + 1)}>Berikutnya</Button></div></section>
 <section className="mt-6 rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-3"><h2 className="text-lg font-semibold">Delegasi terkontrol</h2><Button onClick={() => { setDelegateOpen(true); setReason(''); setWorkflowId(''); setFromId(''); setToId(''); }}>Buat delegasi</Button></div><p className="mt-2 text-sm text-slate-500">Maksimal 90 hari. Pemberi dan penerima tetap memerlukan izin aktif. Tidak ada delegasi berantai.</p><ul className="mt-5 space-y-4">{delegates?.rows.map(d => <li className="flex flex-wrap justify-between gap-3 border-t pt-3" key={d.id}><div><p className="font-semibold">{memberName(d.from_membership_id)} → {memberName(d.to_membership_id)}</p><p className="text-sm text-slate-500">{d.workflow_name} · {new Date(d.starts_at).toLocaleString('id-ID')} s.d. {new Date(d.ends_at).toLocaleString('id-ID')} · {d.revoked_at ? 'Dicabut' : new Date(d.ends_at) < new Date() ? 'Berakhir' : 'Terdaftar'}</p><p className="text-sm">{d.reason}</p></div>{!d.revoked_at && <Button variant="outline" disabled={busy} onClick={() => { setRevoke(d); setReason(''); }}>Cabut</Button>}</li>)}</ul><div className="mt-5 flex items-center gap-3"><Button variant="outline" disabled={delegatePage === 1} onClick={() => setDelegatePage(p => p - 1)}>Sebelumnya</Button><span>Halaman {delegatePage}</span><Button variant="outline" disabled={!delegates?.hasMore} onClick={() => setDelegatePage(p => p + 1)}>Berikutnya</Button></div></section>
 <Dialog open={edit !== undefined} onOpenChange={v => { if (!v)
        setEdit(undefined); }}><DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-3xl"><DialogTitle>{edit ? 'Publikasikan versi baru' : 'Buat workflow'}</DialogTitle><DialogDescription>Urutan, approver, kebijakan dan nominal menjadi snapshot saat pengajuan.</DialogDescription>{o && <WorkflowForm tenantId={tenantId} o={o} initial={edit ?? undefined} onDone={() => { setEdit(undefined); void load(); }}/>}</DialogContent></Dialog>
 <Dialog open={!!deactivate || !!revoke} onOpenChange={v => { if (!v) {
        setDeactivate(null);
        setRevoke(null);
    } }}><DialogContent><DialogTitle>{deactivate ? 'Nonaktifkan workflow' : 'Cabut delegasi'}</DialogTitle><DialogDescription>{deactivate ? 'Menghentikan pemilihan versi ini untuk pengajuan baru; snapshot berjalan tidak berubah.' : 'Setelah dicabut, penerima tidak lagi berwenang melalui delegasi ini.'}</DialogDescription><form className="space-y-4" onSubmit={e => { e.preventDefault(); void act(async () => { if (deactivate)
        await approvalApi('state', tenantId, { id: deactivate.id, version: deactivate.row_version, reason }); if (revoke)
        await approvalApi('delegate', tenantId, { id: revoke.id, version: revoke.row_version, workflowId: revoke.workflow_id, reason }); setDeactivate(null); setRevoke(null); }); }}>{error && <p role="alert" className="text-red-700">{error}</p>}<label className="block text-sm">Alasan<textarea className="field mt-2" required minLength={3} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label><Button disabled={busy}>Konfirmasi</Button></form></DialogContent></Dialog>
 <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-3xl"><DialogTitle>Riwayat versi dan konfigurasi</DialogTitle><DialogDescription>Maksimal 100 versi dan 200 peristiwa terbaru; catatan lengkap tetap tersimpan.</DialogDescription>{history?.versions.map(v => <section className="rounded-xl border p-4" key={v.version}><h3 className="font-semibold">Versi {v.version} · {new Date(v.published_at).toLocaleString('id-ID')}</h3><p className="mt-2 text-sm">Mulai {money(v.activation_conditions.minAmount)}; batas atas {v.activation_conditions.maxAmount ? money(v.activation_conditions.maxAmount) : 'tidak dibatasi'}. Self approval: {v.allow_self_approval ? 'diizinkan eksplisit' : 'ditolak'}.</p><ol className="mt-2 text-sm">{v.steps.map(s => <li key={s.level}>Level {s.level}: {s.name}</li>)}</ol></section>)}<ol className="space-y-3">{history?.events.map(e => <li className="border-t pt-3 text-sm" key={e.id}><p className="font-semibold">{({ publish: 'Publikasi', deactivate: 'Nonaktifkan', delegate: 'Delegasi', revoke_delegation: 'Pencabutan delegasi', submit: 'Pengajuan' } as Record<string, string>)[e.action] ?? e.action} · {e.actor_name}</p><p>{e.reason}</p><time className="text-xs text-slate-500">{new Date(e.created_at).toLocaleString('id-ID')}</time></li>)}</ol></DialogContent></Dialog>
 <Dialog open={delegateOpen} onOpenChange={setDelegateOpen}><DialogContent><DialogTitle>Delegasi persetujuan</DialogTitle><DialogDescription>Pilih workflow dari halaman daftar saat ini. Delegasi tidak menghapus aturan independensi atau izin penerima.</DialogDescription><form className="space-y-4" onSubmit={e => { e.preventDefault(); void act(async () => { await approvalApi('delegate', tenantId, { workflowId, fromId, toId, startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(), reason }); setDelegateOpen(false); }); }}>{error && <p role="alert" className="text-red-700">{error}</p>}<label className="block text-sm">Workflow<select className="field mt-2" required value={workflowId} onChange={e => { setWorkflowId(e.target.value); setFromId(''); setToId(''); }}><option value="">Pilih…</option>{rows?.rows.filter(w => labels[w.transaction_type as Type]).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>{[['Pemberi', fromId, setFromId], ['Penerima', toId, setToId]].map(([label, value, set]) => <label className="block text-sm" key={String(label)}>{label as string}<select required className="field mt-2" value={value as string} onChange={e => (set as (v: string) => void)(e.target.value)}><option value="">Pilih…</option>{eligible.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label>)}<label className="block text-sm">Mulai<input className="field mt-2" type="datetime-local" required value={startAt} onChange={e => setStartAt(e.target.value)}/></label><label className="block text-sm">Berakhir<input className="field mt-2" type="datetime-local" required value={endAt} onChange={e => setEndAt(e.target.value)}/></label><label className="block text-sm">Alasan<textarea className="field mt-2" minLength={3} maxLength={2000} required value={reason} onChange={e => setReason(e.target.value)}/></label><Button disabled={busy}>Simpan delegasi</Button></form></DialogContent></Dialog>
 </AdminShell>;
}
