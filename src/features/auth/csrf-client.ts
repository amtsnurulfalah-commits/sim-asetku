"use client";
// Share concurrent bootstrap requests; never retain a token after completion/logout.
let pending: Promise<string> | undefined;
export function csrf(): Promise<string> {
  if (!pending) {
    pending = Promise.resolve().then(async () => {
        const r = await fetch("/api/auth/csrf", {
          cache: "no-store", credentials: "same-origin",
        });
        const b = await r.json();
        if (!r.ok || !b.success || typeof b.token !== "string" || !/^[0-9a-f]{64}$/.test(b.token))
          throw new Error(b.error?.message ?? "Muat ulang halaman sebelum melanjutkan.");
        return b.token as string;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
