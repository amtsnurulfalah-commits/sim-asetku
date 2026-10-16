export function assetUrl(origin: string, publicId: string) {
  const u = new URL(origin);
  if (
    u.origin !== origin ||
    !/^\w{8}-\w{4}-4\w{3}-[89ab]\w{3}-\w{12}$/.test(publicId)
  )
    throw new Error("Invalid QR origin or identifier");
  return `${origin}/aset/qr/${publicId}`;
}
export function parseScan(
  value: string,
  origin: string,
): { publicId?: string; code?: string } {
  const s = value.trim();
  if (s.length > 500 || !s) throw new Error("Kode tidak valid.");
  if (s.includes("://")) {
    const u = new URL(s),
      m = /^\/aset\/qr\/([a-f0-9-]{36})$/.exec(u.pathname);
    if (
      u.origin !== origin ||
      u.search ||
      u.hash ||
      u.username ||
      u.password ||
      !m
    )
      throw new Error("QR bukan milik aplikasi ini.");
    return { publicId: m[1] };
  }
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(s))
    throw new Error("Kode inventaris tidak valid.");
  return { code: s };
}
