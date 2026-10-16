'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { reportApi } from './client';
import { filters, type Filters } from './schemas';
import { previousMonth, button, field } from '@/features/depreciation/ui';
import { money } from '@/features/assets/client';
export type Stats = {
    cards: Record<string, string>;
    charts: Record<string, {
        label: string;
        value: string;
    }[]>;
    generatedAt: string;
    notes: string[];
};
const cardLabels: Record<string, string> = { assets: 'Aset aktif', categories: 'Kategori terpakai', cost: 'Nilai perolehan', book: 'Nilai buku', good: 'Kondisi baik', lightDamage: 'Rusak ringan', heavyDamage: 'Rusak berat', missing: 'Hilang', maintenance: 'Dalam pemeliharaan', loaned: 'Sedang dipinjam', lowStock: 'Barang stok rendah', procurement: 'Pengadaan berjalan', pending: 'Pengajuan menunggu yang dapat diakses', opname: 'Stock opname berjalan', overdue: 'Aset terlambat kembali' };
const chartLabels: Record<string, string> = { categories: 'Aset per kategori', conditions: 'Aset per kondisi', rooms: 'Aset per ruangan', values: 'Nilai perolehan per kategori', procurement: 'Pengadaan disetujui / diposting per bulan', maintenance: 'Transaksi pemeliharaan diposting per bulan', stock: 'Nilai saldo persediaan per ruangan', bookTrend: 'Perubahan nilai buku per akhir bulan' };
export function StatsView({ data }: {
    data: Stats;
}) { return <><p className="my-3 text-sm text-slate-500">Diperbarui {new Date(data.generatedAt).toLocaleString('id-ID')}</p><dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{Object.entries(data.cards).map(([k, v]) => <div key={k} className="rounded-xl border bg-white p-4"><dt className="text-sm text-slate-500">{cardLabels[k] ?? k}</dt><dd className="mt-2 text-xl font-bold text-teal-900">{['cost', 'book'].includes(k) ? money(v) : v}</dd></div>)}</dl><div className="mt-5 grid gap-4 md:grid-cols-2">{Object.entries(data.charts).map(([k, rows]) => { const max = Math.max(1, ...rows.map(r => Number(r.value))); return <section key={k} className="rounded-xl border bg-white p-4"><h3 className="font-semibold">{chartLabels[k]}</h3>{!rows.length && <p className="mt-4 text-sm">Belum ada data.</p>}<div className="mt-4 max-h-80 space-y-3 overflow-y-auto">{rows.map((r, i) => <div key={i}><div className="mb-1 flex justify-between gap-3 text-sm"><span>{r.label}</span><span>{['values', 'stock', 'bookTrend'].includes(k) ? money(r.value) : r.value}</span></div><div className="h-3 rounded bg-slate-100" aria-hidden="true"><div className="h-3 rounded bg-teal-600" style={{ width: Math.max(0, Number(r.value) / max * 100) + '%' }}/></div></div>)}</div></section>; })}</div><ul className="my-4 space-y-2 text-xs text-slate-500">{data.notes.map(n => <li key={n}>{n}</li>)}</ul></>; }
export function Statistics({ tenantId }: {
    tenantId: string;
}) { const [period, setPeriod] = useState(previousMonth), [tick, setTick] = useState(0), [data, setData] = useState<Stats | null>(null), [error, setError] = useState(''); useEffect(() => { const c = new AbortController(); const load = async () => { const parsed = filters.safeParse({ period: period + '-01' }); if (!parsed.success) throw new Error('Pilih bulan statistik yang valid.'); const f: Filters = parsed.data; return reportApi<Stats>('dashboard', tenantId, f, c.signal); }; load().then(d => { if (!c.signal.aborted) { setData(d); setError(''); } }).catch(e => { if (!c.signal.aborted) {
    setData(null);
    setError(e.message);
} }); return () => c.abort(); }, [tenantId, period, tick]); return <section className="my-8"><div className="flex flex-wrap items-end gap-4"><label>Statistik akhir bulan<input type="month" className={field} value={period} onChange={e => setPeriod(e.target.value)}/></label><button className={button} onClick={() => setTick(t => t + 1)}>Muat ulang statistik</button><Link className="text-teal-800 underline" href="/laporan">Filter lengkap dan laporan</Link></div>{error && <p role="alert" className="my-4 text-red-700">{error}</p>}{data && <StatsView data={data}/>}</section>; }
