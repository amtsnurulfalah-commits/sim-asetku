'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/features/admin/ui-shared';
import { money } from '@/features/assets/client';
import { button, field, Pager, previousMonth } from '@/features/depreciation/ui';
import { reportApi } from './client';
import { filters, kinds, labels, type Filters, type Options, type Ref, type Table } from './schemas';
import { StatsView, type Stats } from './statistics';
import { ReportSettings } from './settings';
export function ReportsPanel({ tenantId, tenantName }: {
    tenantId: string;
    tenantName: string;
}) {
    const [o, setO] = useState<Options | null>(null), [f, setF] = useState<Filters>(() => filters.parse({ period: previousMonth() + '-01' })), [data, setData] = useState<(Table & {
        hasMore: boolean;
    }) | null>(null), [stats, setStats] = useState<Stats | null>(null), [tab, setTab] = useState('reports'), [page, setPage] = useState(1), [error, setError] = useState(''), [busy, setBusy] = useState(false), [tick, setTick] = useState(0), [documents, setDocuments] = useState<{
        id: string;
        code: string | null;
        type: string | null;
    }[]>([]), [sourceQuery, setSourceQuery] = useState(''), [sourcePage, setSourcePage] = useState(1), [sourceMore, setSourceMore] = useState(false), [history, setHistory] = useState<{
        id: string;
        format: string;
        report_type: typeof kinds[number];
        row_count: number;
        sha256: string;
        created_at: string;
    }[]>([]), [historyPage, setHistoryPage] = useState(1), [historyMore, setHistoryMore] = useState(false);
    useEffect(() => { const c = new AbortController(); reportApi<Options>('options', tenantId, undefined, c.signal).then(setO).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); return () => c.abort(); }, [tenantId, tick]);
    useEffect(() => { if (f.kind !== 'minutes')
        return; const c = new AbortController(); reportApi<Table & {
        hasMore: boolean;
    }>('preview', tenantId, { filters: { ...filters.parse({ period: f.period }), kind: 'transactions', query: sourceQuery }, page: sourcePage }, c.signal).then(t => { setDocuments(t.rows.filter(r => r.rawType?.startsWith('asset:') || r.rawType === 'supply:receipt').map(r => ({ id: r.id!, code: r.code, type: r.type }))); setSourceMore(t.hasMore); }).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); return () => c.abort(); }, [tenantId, sourceQuery, sourcePage, f.kind, f.period]);
    useEffect(() => { if (tab !== 'history')
        return; const c = new AbortController(); reportApi<{
        rows: typeof history;
        hasMore: boolean;
    }>('history?page=' + historyPage, tenantId, undefined, c.signal).then(r => { setHistory(r.rows); setHistoryMore(r.hasMore); }).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); return () => c.abort(); }, [tenantId, tab, historyPage]);
    function set<K extends keyof Filters>(k: K, v: Filters[K]) { setF(x => ({ ...x, [k]: v })); setPage(1); setData(null); setStats(null); }
    async function load(next = 1) { setBusy(true); setError(''); try {
        if (tab === 'dashboard') {
            setStats(await reportApi<Stats>('dashboard', tenantId, f));
            setData(null);
        }
        else {
            setData(await reportApi<Table & {
                hasMore: boolean;
            }>('preview', tenantId, { filters: f, page: next }));
            setPage(next);
        }
    }
    catch (e) {
        setError((e as Error).message);
        setData(null);
    }
    finally {
        setBusy(false);
    } }
    async function download(format: 'pdf' | 'xlsx') { setBusy(true); setError(''); try {
        await reportApi('export', tenantId, { format, filters: f });
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    const select = (key: 'buildingId' | 'roomId' | 'categoryId' | 'conditionId' | 'fundingId', label: string, refs: Ref[]) => <label key={key}>{label}<select className={field} value={f[key] ?? ''} onChange={e => set(key, e.target.value || null)}><option value="">Semua</option>{refs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>;
    return <AdminShell title="Dasbor dan Laporan" tenant={tenantName}><nav className="my-4 flex flex-wrap gap-2" aria-label="Laporan">{[['reports', 'Laporan'], ['dashboard', 'Statistik dan grafik'], ['history', 'Riwayat ekspor'], ...(o?.permissions.includes('settings.manage') ? [['settings', 'Format lembaga']] : [])].map(([k, v]) => <button disabled={busy} className={button} aria-pressed={tab === k} key={k} onClick={() => { setTab(k); setData(null); setStats(null); }}>{v}</button>)}</nav>{error && <p role="alert" className="my-4 text-red-700">{error}</p>}{o && tab === 'settings' && <ReportSettings key={o.version} tenantId={tenantId} options={o} onSaved={() => { setTick(t => t + 1); setTab('reports'); }}/>}{o && ['reports', 'dashboard'].includes(tab) && <section className="rounded-xl border bg-white p-5"><fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">{tab === 'reports' && <label>Jenis laporan<select className={field} value={f.kind} onChange={e => set('kind', e.target.value as Filters['kind'])}>{kinds.map(k => <option key={k} value={k}>{labels[k]}</option>)}</select></label>}<label>Bulan valuasi / akhir grafik<input type="month" className={field} value={f.period.slice(0, 7)} onChange={e => set('period', e.target.value + '-01')}/></label>{select('buildingId', 'Gedung', o.buildings)}{select('roomId', 'Ruangan', o.rooms)}{select('categoryId', 'Kategori', o.categories)}{select('conditionId', 'Kondisi', o.conditions)}{select('fundingId', 'Sumber dana', o.funding)}<label>Tahun perolehan (opsional)<input type="number" min={1900} max={9999} className={field} value={f.year ?? ''} onChange={e => set('year', e.target.value ? Number(e.target.value) : null)}/></label><label>Cari kode / nama / nomor<input className={field} maxLength={180} value={f.query} onChange={e => set('query', e.target.value)}/></label><label>Status aset<select className={field} value={f.status} onChange={e => set('status', e.target.value as Filters['status'])}>{['all', 'available', 'reserved', 'on_loan', 'maintenance', 'draft', 'disposed', 'archived'].map(s => <option key={s} value={s}>{({ all: 'Semua', available: 'Tersedia', reserved: 'Dipesan', on_loan: 'Dipinjam', maintenance: 'Pemeliharaan', draft: 'Draf', disposed: 'Dihapus', archived: 'Diarsipkan' } as Record<string, string>)[s]}</option>)}</select></label>{f.kind === 'kib' && <label>Kelompok KIB<select className={field} value={f.group} onChange={e => set('group', e.target.value)}><option value="all">Semua kelompok</option>{o.config.kibGroups.map(g => <option key={g.code} value={g.code}>{g.code} · {g.name}</option>)}</select></label>}{['transactions', 'stock_usage'].includes(f.kind) && <><label>Tanggal bisnis mulai<input type="date" className={field} value={f.from ?? ''} onChange={e => set('from', e.target.value || null)}/></label><label>Tanggal bisnis akhir<input type="date" className={field} value={f.to ?? ''} onChange={e => set('to', e.target.value || null)}/></label></>}{f.kind === 'transactions' && <><label>Jenis transaksi<select className={field} value={f.transactionType} onChange={e => set('transactionType', e.target.value as Filters['transactionType'])}>{['all', 'supply:request', 'supply:order', 'supply:receipt', 'supply:receipt_stock', 'supply:issue', 'supply:adjustment', 'asset:placement', 'asset:movement', 'asset:loan', 'asset:return', 'asset:maintenance', 'asset:maintenance_finish', 'asset:opname', 'asset:disposal', 'finance:depreciation', 'finance:depreciation_correction'].map(k => <option key={k} value={k}>{k === 'all' ? 'Semua' : k}</option>)}</select></label><label>Status dokumen<select className={field} value={f.documentStatus} onChange={e => set('documentStatus', e.target.value as Filters['documentStatus'])}>{['all', 'draft', 'pending', 'partially_approved', 'approved', 'posted', 'rejected', 'revision_required', 'cancelled'].map(k => <option key={k}>{k}</option>)}</select></label></>}{['assets', 'kib', 'kir', 'depreciation'].includes(f.kind) && <label>Posting sampai (opsional, waktu lokal)<input type="datetime-local" className={field} value={f.postedBefore ? new Date(new Date(f.postedBefore).getTime() - new Date(f.postedBefore).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''} onChange={e => set('postedBefore', e.target.value ? new Date(e.target.value).toISOString() : null)}/></label>}</fieldset>{f.kind === 'minutes' && <section className="my-4 rounded-lg border p-4"><label>Cari dokumen sumber<input disabled={busy} className={field} value={sourceQuery} onChange={e => { setSourceQuery(e.target.value); setSourcePage(1); }}/></label><p className="my-2 text-sm">Pilih penerimaan pengadaan atau transaksi aset. Dokumen belum posted akan diberi tanda DRAF.</p><ul className="max-h-64 overflow-auto">{documents.map(d => <li className="flex items-center justify-between gap-3 border-b py-2" key={d.id}><span>{d.code} · {d.type}</span><button className={button} disabled={busy} onClick={() => set('documentId', d.id)}>{f.documentId === d.id ? 'Terpilih' : 'Pilih'}</button></li>)}</ul><Pager page={sourcePage} more={sourceMore} onChange={setSourcePage}/>{f.documentId && <p className="font-semibold">Sumber: {documents.find(d => d.id === f.documentId)?.code ?? 'Dokumen dipilih pada halaman lain'}</p>}</section>}<p className="my-4 text-sm text-slate-500">Filter aset berlaku pada daftar/KIB/KIR/penyusutan. Transaksi memakai tanggal, jenis, status dokumen dan pencarian. Persediaan memakai ruangan, gedung, kategori, pencarian; saldo bersifat terkini. Berita acara mengikuti satu dokumen sumber.</p><button disabled={busy} className={button} onClick={() => load()}>{busy ? 'Memproses…' : 'Tampilkan'}</button></section>}{stats && <StatsView data={stats}/>}{data && <section className="my-5 rounded-xl border bg-white p-5"><h2 className="text-xl font-bold">{data.title}</h2><p className="my-3">{data.count} baris · {data.number}</p>{data.status && data.status !== 'posted' && <p className="font-bold text-amber-800">DRAF - BELUM FINAL</p>}<div className="my-3 flex flex-wrap gap-3">{o?.permissions.includes('reports.export') && (['pdf', 'xlsx'] as const).map(fmt => <button key={fmt} disabled={busy || data.count > 5000} className={button} onClick={() => download(fmt)}>Unduh {fmt.toUpperCase()}</button>)}</div>{data.count > 5000 && <p role="alert">Persempit filter hingga maksimal 5.000 baris untuk ekspor lengkap.</p>}<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{data.columns.map(c => <th className="border-b p-3" key={c.key}>{c.label}</th>)}</tr></thead><tbody>{data.rows.map((r, i) => <tr key={r.id ?? i}>{data.columns.map(c => <td className="border-b p-3" key={c.key}>{c.money ? money(r[c.key]) : r[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div><Pager page={page} more={data.hasMore} onChange={load}/><dl className="my-4 flex flex-wrap gap-5">{Object.entries(data.totals).map(([k, v]) => <div key={k}><dt>{({ cost: 'Perolehan', expense: 'Beban periode', accumulated: 'Akumulasi', book: 'Nilai buku', value: 'Nilai persediaan' } as Record<string, string>)[k] ?? k}</dt><dd className="font-bold">{money(v)}</dd></div>)}</dl>{data.notes.map((n, i) => <p className="my-2 text-sm text-slate-500" key={i}>{n}</p>)}{data.approval?.map((a, i) => <p key={i} className="my-2 text-sm">{a}</p>)}</section>}{tab === 'history' && <section className="my-5 rounded-xl border bg-white p-5"><h2 className="text-xl font-bold">Riwayat berkas yang dihasilkan</h2><p className="my-3 text-sm">Jejak ekspor menyimpan format, jumlah baris, konfigurasi/filter dan checksum. Berkas diunduh langsung; riwayat ini tidak menyatakan berkas tersimpan di Drive.</p><ul>{history.map(h => <li className="border-b py-3" key={h.id}>{labels[h.report_type] ?? h.report_type} · {h.format.toUpperCase()} · {h.row_count} baris · {new Date(h.created_at).toLocaleString('id-ID')}<p className="break-all text-xs">SHA-256 {h.sha256}</p></li>)}</ul><Pager page={historyPage} more={historyMore} onChange={setHistoryPage}/></section>}<Link href="/penyusutan" className="mt-4 inline-block text-teal-800 underline">Buka jurnal dan koreksi penyusutan</Link></AdminShell>;
}
