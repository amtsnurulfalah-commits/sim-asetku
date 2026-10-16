"use client";
import { csrf } from "@/features/auth/csrf-client";
export async function approvalApi<T>(path: string, tenant: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let r: Response;
    try {
        r = await fetch("/api/approval/" + path, {
            signal,
            method: body === undefined ? "GET" : "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
                "X-Tenant-Context": tenant,
                ...(body === undefined
                    ? {}
                    : {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": await csrf(),
                    }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }
    catch (e) {
        if (signal?.aborted)
            throw e;
        throw new Error("Layanan belum dapat dihubungi.");
    }
    let b;
    try {
        b = await r.json();
    }
    catch {
        throw new Error("Respons layanan belum dapat diproses.");
    }
    if (!r.ok || !b.success)
        throw new Error(b.error?.message ?? "Permintaan belum berhasil.");
    return b.data;
}
