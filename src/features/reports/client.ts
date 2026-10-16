'use client';
import { csrf } from '@/features/auth/csrf-client';
export async function reportApi<T>(action: string, tenant: string, body?: unknown, signal?: AbortSignal): Promise<T> { const r = await fetch('/api/reports/' + action, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal, headers: { 'X-Tenant-Context': tenant, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (action === 'export' && r.ok) {
    const blob = await r.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'laporan';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return undefined as T;
} const b = await r.json(); if (!r.ok || !b.success)
    throw new Error(b.error?.message ?? 'Laporan belum dapat diproses.'); return b.data; }
