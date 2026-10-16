'use client';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/features/assets/fields';
import { approvalApi } from './client';
import { types, labels, requiredPermission, type Config, type Options, type Workflow, type Type } from './schemas';
export function WorkflowForm({ tenantId, o, initial, onDone }: {
    tenantId: string;
    o: Options;
    initial?: Workflow;
    onDone: () => void;
}) {
    const [d, setD] = useState<Config>(() => initial ? { code: initial.code, name: initial.name, type: initial.transaction_type as Type, enabled: initial.status === 'active', minAmount: initial.activation_conditions?.minAmount ?? '0', maxAmount: initial.activation_conditions?.maxAmount ?? null, scope: initial.activation_conditions?.scope ?? 'all', allowSelf: initial.allow_self_approval ?? false, allowReject: initial.activation_conditions?.reject ?? true, allowRevision: initial.activation_conditions?.revision ?? true, steps: initial.steps.map(s => s.approverId), reason: '' } : { code: '', name: '', type: 'asset:movement', enabled: true, minAmount: '0', maxAmount: null, scope: 'all', allowSelf: false, allowReject: true, allowRevision: true, steps: [''], reason: '' });
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const key = useRef(crypto.randomUUID());
    const set = (k: keyof Config, v: unknown) => setD(d => ({ ...d, [k]: v }));
    const eligible = o.members.filter(m => m.permissions.includes('approval.access') && m.permissions.includes(requiredPermission(d.type)));
    return <form className="space-y-5" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
        await approvalApi('publish', tenantId, { id: initial?.id ?? null, version: initial?.row_version ?? null, key: key.current, data: d });
        onDone();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>
 {error && <p role="alert" className="text-red-700">{error}</p>}<fieldset disabled={busy} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2">
 <Field def={{ key: 'code', label: 'Kode workflow', required: true, disabled: !!initial, maxLength: 64, hint: 'Huruf besar, angka, garis bawah atau tanda hubung.' }} value={d.code} onChange={v => set('code', String(v).toUpperCase())}/>
 <Field def={{ key: 'name', label: 'Nama workflow', required: true, maxLength: 300 }} value={d.name} onChange={v => set('name', v)}/>
 <Field def={{ key: 'type', label: 'Jenis transaksi', type: 'select', required: true, disabled: !!initial, options: types.map(t => ({ value: t, label: labels[t] })) }} value={d.type} onChange={v => { set('type', v); set('steps', ['']); set('scope', 'all'); }}/>
 <Field def={{ key: 'scope', label: 'Lingkup aktivasi', type: 'select', required: true, options: [{ value: 'all', label: 'Semua transaksi jenis ini' }, { value: 'standard', label: 'Transaksi biasa (tanpa referensi koreksi)' }, { value: 'correction', label: 'Koreksi stok / penyusutan dengan referensi dokumen' }] }} value={d.scope} onChange={v => set('scope', v)}/>
 <Field def={{ key: 'minAmount', label: 'Nominal minimum (termasuk)', required: true, hint: 'Nominal dihitung server. Aset memakai perolehan bruto; penyelesaian pemeliharaan memakai biaya. Penyusutan memakai beban; koreksi memakai nilai terbesar antara absolut delta dan sisa dasar sebelum koreksi.' }} value={d.minAmount} onChange={v => set('minAmount', v)}/>
 <Field def={{ key: 'maxAmount', label: 'Nominal maksimum (tidak termasuk)', hint: 'Kosong = tanpa batas. Rentang aktif tidak boleh bertumpang tindih.' }} value={d.maxAmount} onChange={v => set('maxAmount', v || null)}/>
 </div><section className="rounded-xl border p-4"><h3 className="font-semibold">Urutan approver</h3><p className="my-3 text-sm text-slate-500">Satu approver per level, maksimal 10 level. Pilihan berisi anggota aktif dengan izin persetujuan jenis transaksi dan akses inbox. Atur izin melalui Role dan Izin jika diperlukan.</p>{eligible.length === 0 && <p className="text-sm text-amber-800">Belum ada anggota yang memenuhi izin.</p>}<ol className="space-y-3">{d.steps.map((mid, i) => <li className="flex flex-wrap items-end gap-2" key={i}><label className="min-w-48 flex-1 text-sm">Level {i + 1}<select required className="field mt-2" value={mid} onChange={e => set('steps', d.steps.map((v, j) => i === j ? e.target.value : v))}><option value="">Pilih approver…</option>{eligible.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label><Button type="button" variant="outline" disabled={i === 0} onClick={() => { const s = [...d.steps]; [s[i - 1], s[i]] = [s[i], s[i - 1]]; set('steps', s); }}>Naik</Button><Button type="button" variant="outline" disabled={i === d.steps.length - 1} onClick={() => { const s = [...d.steps]; [s[i + 1], s[i]] = [s[i], s[i + 1]]; set('steps', s); }}>Turun</Button><Button type="button" variant="outline" disabled={d.steps.length === 1} onClick={() => set('steps', d.steps.filter((_, j) => i !== j))}>Hapus level</Button></li>)}</ol><Button className="mt-4" type="button" variant="outline" disabled={d.steps.length >= 10} onClick={() => set('steps', [...d.steps, ''])}>Tambah level</Button></section>
 <div className="grid gap-3 sm:grid-cols-2">{[['enabled', 'Aktif untuk pengajuan baru'], ['allowSelf', 'Izinkan persetujuan oleh pemohon (pengecualian eksplisit)'], ['allowReject', 'Izinkan penolakan final'], ['allowRevision', 'Izinkan kembali untuk revisi; mulai lagi dari level 1']].map(([k, l]) => <label className="flex gap-2 text-sm" key={k}><input type="checkbox" checked={Boolean(d[k as keyof Config])} onChange={e => set(k as keyof Config, e.target.checked)}/>{l}</label>)}</div>
 <Field def={{ key: 'reason', label: 'Alasan publikasi / perubahan', type: 'textarea', required: true, maxLength: 2000 }} value={d.reason} onChange={v => set('reason', v)}/><p className="text-sm text-slate-500">Publikasi membuat versi baru yang tidak dapat ditimpa. Pengajuan berjalan tetap memakai snapshot sebelumnya. Pemeriksa opname tetap tidak dapat menyetujui hasil pemeriksaannya sendiri.</p><Button disabled={busy}>{busy ? 'Memublikasikan…' : 'Publikasikan versi'}</Button></fieldset></form>;
}
