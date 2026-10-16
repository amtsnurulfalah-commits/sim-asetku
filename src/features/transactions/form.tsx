'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/features/assets/fields';
import {lifecycle} from '@/features/assets/client';
import { transactionApi } from './client';
import { labels, type Payload, type Kind, type Options, type AssetChoice, type List, type Doc } from './schemas';
export function TransactionForm({ o, kind, initial, onDone }: {
    o: Options;
    kind: Kind;
    initial?: Doc;
    onDone: (id: string) => void;
}) {
    const [data, setData] = useState<Payload>(() => initial?.payload ?? { kind, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), reason: '', assets: [], parentId: null, roomId: null, responsibleId: null, conditionId: null, borrower: '', startAt: null, dueAt: null, maintenanceType: 'preventive', assigneeId: null, supplierId: null, nextDueAt: null, completedAt: null, costTreatment: 'expense', cost: '0', scopeRoomId: null, scopeCategoryId: null });
    const [query, setQuery] = useState(''), [page, setPage] = useState(1), [choices, setChoices] = useState<{
        rows: AssetChoice[];
        hasMore: boolean;
    }>({ rows: [], hasMore: false }), [parents, setParents] = useState<List | null>(null), [parentPage, setParentPage] = useState(1), [parentQuery, setParentQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const key = useRef(crypto.randomUUID());
    const selected = data.assets;
    const set = (k: keyof Payload, v: unknown) => setData(d => ({ ...d, [k]: v }));
    useEffect(() => { const c = new AbortController(); const timer = setTimeout(() => { transactionApi<typeof choices>('assets?' + new URLSearchParams({ query, page: String(page), ...(data.parentId ? { parentId: data.parentId } : {}) }), o.tenantId, undefined, c.signal).then(r=>{if(!c.signal.aborted)setChoices(r)}).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); }, 250); return () => { clearTimeout(timer); c.abort(); }; }, [query, page, data.parentId, o.tenantId]);
    useEffect(() => { if (!['return', 'maintenance_finish'].includes(kind))
        return; const c = new AbortController(); transactionApi<List>('list?' + new URLSearchParams({ kind: kind === 'return' ? 'loan' : 'maintenance', status: 'posted', query: parentQuery, page: String(parentPage) }), o.tenantId, undefined, c.signal).then(r=>{if(!c.signal.aborted)setParents(r)}).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); return () => c.abort(); }, [kind, o.tenantId, parentPage, parentQuery]);
    const ref = (key: keyof Payload, label: string, refs: Options['rooms'], required = false) => <Field key={key} def={{ key, label, type: 'select', required, options: refs.map(r => ({ value: r.id, label: r.name })) }} value={data[key]} onChange={v => set(key, v)}/>;
    const time = (key: keyof Payload, label: string, required = false) => <label className="block text-sm font-medium" key={key}>{label}<input className="field mt-2" type="datetime-local" required={required} value={data[key] ? new Date(String(data[key])).toLocaleString('sv-SE').replace(' ', 'T').slice(0, 16) : ''} onChange={e => set(key, e.target.value ? new Date(e.target.value).toISOString() : null)}/></label>;
    return <form className="space-y-5" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
        const r = await transactionApi<{
            id: string;
        }>('save', o.tenantId, { id: initial?.id ?? null, version: initial?.row_version ?? null, key: key.current, data: { ...data, assets: selected } });
        onDone(r.id);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>
 <p className="text-sm text-slate-600">{labels[kind]}. Simpan draf, lalu ajukan untuk review independen sebelum posting.</p>
 {error && <p role="alert" className="text-red-700">{error}</p>}
 <fieldset disabled={busy} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2">
 <Field def={{ key: 'date', label: 'Tanggal dokumen', type: 'date', required: true }} value={data.date} onChange={v => set('date', v)}/>
 <Field def={{ key: 'reason', label: 'Tujuan / alasan / catatan pemeriksaan', type: 'textarea', required: true, maxLength: 2000 }} value={data.reason} onChange={v => set('reason', v)}/>
 {['placement', 'movement', 'return', 'maintenance_finish'].includes(kind) && ref('roomId', 'Ruangan tujuan (gedung sesuai master ruangan)', o.rooms, true)}
 {['placement', 'movement'].includes(kind) && ref('responsibleId', 'Penanggung jawab baru', o.members)}
 {['return', 'maintenance_finish'].includes(kind) && ref('conditionId', 'Kondisi hasil pemeriksaan', o.conditions, true)}
 {kind === 'loan' && <><Field def={{ key: 'borrower', label: 'Nama peminjam', required: true }} value={data.borrower} onChange={v => set('borrower', v)}/>{time('startAt', 'Tanggal pinjam', true)}{time('dueAt', 'Batas pengembalian', true)}</>}
 {kind === 'maintenance' && <><Field def={{ key: 'maintenanceType', label: 'Jenis pemeliharaan', type: 'select', required: true, options: [{ value: 'preventive', label: 'Preventif' }, { value: 'corrective', label: 'Korektif' }] }} value={data.maintenanceType} onChange={v => set('maintenanceType', v)}/>{ref('assigneeId', 'Petugas', o.members, true)}{ref('supplierId', 'Vendor', o.suppliers)}{time('startAt', 'Mulai', true)}{time('nextDueAt', 'Jadwal pemeliharaan berikutnya')}</>}
 {kind === 'maintenance_finish' && <>{time('completedAt', 'Selesai', true)}<Field def={{ key: 'costTreatment', label: 'Perlakuan biaya', type: 'select', required: true, options: [{ value: 'expense', label: 'Beban rutin' }, { value: 'capitalization_review', label: 'Usulan kapitalisasi — menunggu kebijakan' }] }} value={data.costTreatment} onChange={v => set('costTreatment', v)}/><Field def={{ key: 'cost', label: 'Biaya per aset (Rp)', required: true, hint: 'Usulan kapitalisasi dipisahkan dari beban; belum menambah nilai perolehan aset.' }} value={data.cost} onChange={v => set('cost', v)}/></>}
 {kind === 'opname' && <>{ref('scopeRoomId', 'Lingkup ruangan (kosong = semua)', o.rooms)}{ref('scopeCategoryId', 'Lingkup kategori (kosong = semua)', o.categories)}{ref('assigneeId', 'Pemeriksa yang ditugaskan', o.members, true)}<p className="text-sm text-slate-500">Snapshot maksimal 2.000 aset. Pemeriksaan hanya oleh petugas yang ditugaskan; selisih memerlukan transaksi tindak lanjut terpisah.</p></>}
 </div>
 {['return', 'maintenance_finish'].includes(kind) && <section className="rounded-xl border p-4"><label> Cari transaksi asal<input className="field mt-2" value={parentQuery} onChange={e => { setParentQuery(e.target.value); setParentPage(1); }}/></label><label className="mt-3 block">Transaksi asal<select required className="field mt-2" value={data.parentId ?? ''} onChange={e => { set('parentId', e.target.value || null); set('assets', []); setPage(1); }}><option value="">Pilih…</option>{parents?.rows.map(p => <option key={p.id} value={p.id}>{p.document_number}</option>)}</select></label><div className="mt-3 flex gap-2"><Button type="button" variant="outline" disabled={parentPage === 1} onClick={() => setParentPage(p => p - 1)}>Sebelumnya</Button><Button type="button" variant="outline" disabled={!parents?.hasMore} onClick={() => setParentPage(p => p + 1)}>Berikutnya</Button></div></section>}
 {kind !== 'opname' && <section className="rounded-xl border p-4"><label>Cari aset<input className="field mt-2" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/></label><p className="my-3 text-sm">{selected.length} aset dipilih (maksimal 50)</p><ul className="max-h-64 space-y-2 overflow-auto">{choices.rows.map(a => <li key={a.id}><label className="flex gap-3"><input type="checkbox" checked={selected.includes(a.id)} disabled={selected.length >= 50 && !selected.includes(a.id)} onChange={e => set('assets', e.target.checked ? [...selected, a.id] : selected.filter(x => x !== a.id))}/><span>{a.inventory_code} — {a.name}<small className="block text-slate-500">{a.room_name ?? 'Belum ditempatkan'} · {lifecycle[a.lifecycle_status]??a.lifecycle_status}</small></span></label></li>)}</ul><div className="mt-3 flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Sebelumnya</Button><Button type="button" variant="outline" disabled={!choices.hasMore} onClick={() => setPage(p => p + 1)}>Berikutnya</Button><Button type="button" variant="outline" onClick={() => set('assets', [])}>Kosongkan pilihan</Button></div></section>}
 <Button disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan draf'}</Button></fieldset></form>;
}
