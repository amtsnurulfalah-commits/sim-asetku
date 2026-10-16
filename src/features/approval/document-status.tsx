'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { approvalApi } from './client';
import { statusText } from '@/features/supply/schemas';
type State = {
    engine: boolean;
    configured: boolean;
    instances: {
        id: string;
        document_revision: number;
        status: string;
        current_level: number;
    }[];
};
export function DocumentApproval({ tenantId, id, version }: {
    tenantId: string;
    id: string;
    version: string;
}) {
    const [data, setData] = useState<State | null>(null), [error, setError] = useState('');
    useEffect(() => { const c = new AbortController(); approvalApi<State>('document?id=' + id, tenantId, undefined, c.signal).then(d => { if (!c.signal.aborted)
        setData(d); }).catch(e => { if (!c.signal.aborted)
        setError(e.message); }); return () => c.abort(); }, [tenantId, id, version]);
    if (!data && !error)
        return null;
    return <section className="my-5 rounded-xl border border-teal-200 bg-teal-50 p-4"><h2 className="font-semibold">Persetujuan bertingkat</h2>{error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}{data && <><p className="mt-2 text-sm">{data.engine ? 'Dokumen ini memakai snapshot approval engine. Keputusan dilakukan pada inbox.' : data.configured ? 'Workflow aktif tersedia. Ajukan dokumen untuk menentukan versi dan approver berdasarkan nominal serta lingkup.' : 'Belum ada workflow bertingkat aktif. Untuk penyusutan, admin wajib mengonfigurasi workflow sebelum pengajuan.'}</p>{data.instances.length > 0 && <ul className="mt-3 space-y-2 text-sm">{data.instances.map(i => <li key={i.id}><Link className="font-semibold text-teal-800 underline" href={'/approval/' + i.id}>Revisi {i.document_revision} · {statusText[i.status] ?? i.status} · Level {i.current_level}</Link></li>)}</ul>}<Link className="mt-3 inline-block text-sm text-teal-800 underline" href="/approval">Buka inbox persetujuan</Link></>}</section>;
}
