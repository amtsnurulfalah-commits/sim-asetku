import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { AppError } from "../security/errors";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const PURPOSES = [
  "Aset",
  "Foto-Aset",
  "Pengadaan",
  "Penerimaan",
  "Mutasi",
  "Peminjaman",
  "Pemeliharaan",
  "Stock-Opname",
  "Penghapusan",
  "Tanah",
  "Bangunan",
  "Kendaraan",
  "Berita-Acara",
  "Laporan",
  "Dokumen-Lainnya",
] as const;
export const CHUNK_SIZE = 1024 * 1024;
const messages: Record<string, string> = {
  DRIVE_ACCESS_DENIED:
    "Folder atau file tidak dapat diakses. Periksa izin koneksi Google Drive.",
  DRIVE_RATE_LIMIT:
    "Kuota atau batas permintaan Google Drive tercapai. Coba kembali nanti.",
  INVALID_FOLDER:
    "Masukkan URL folder Google Drive atau Folder ID yang valid; URL file tidak diterima.",
  DRIVE_NOT_CONFIGURED:
    "Integrasi Google Drive belum dikonfigurasi oleh pengelola aplikasi.",
  DRIVE_NOT_CONNECTED:
    "Belum ada koneksi Google Drive yang siap. Hubungkan dan uji folder lembaga.",
  SERVICE_ACCOUNT_NOT_CONFIGURED:
    "Identitas layanan Google belum dikonfigurasi.",
  OAUTH_NOT_CONFIGURED:
    "OAuth Google belum dikonfigurasi oleh pengelola aplikasi.",
  OAUTH_STATE_INVALID:
    "Otorisasi tidak valid, telah digunakan, atau kedaluwarsa. Mulai otorisasi kembali.",
  OAUTH_CANCELLED: "Otorisasi Google dibatalkan. Mulai kembali saat siap.",
  DRIVE_BUSY:
    "Operasi folder sedang berjalan. Tunggu beberapa menit sebelum mencoba kembali.",
  DRIVE_INITIALIZE_REQUIRED: "Inisialisasi subfolder terlebih dahulu.",
  DRIVE_ROOT_MOVED:
    "Folder utama berpindah. Admin perlu menguji ulang koneksi.",
  DRIVE_RECONNECT_REQUIRED:
    "Koneksi dinonaktifkan atau gagal. Pulihkan otorisasi dan uji kembali.",
  INVALID_FILE: "Nama atau ukuran file tidak valid. Periksa batas unggah.",
  UNSUPPORTED_FILE:
    "Jenis file belum didukung. Gunakan PDF, JPEG, PNG, atau WebP.",
  FILE_SIGNATURE_MISMATCH:
    "Isi file tidak cocok dengan jenis file yang dipilih.",
  UPLOAD_BUSY:
    "Unggah sedang diproses. Jika terputus, tunggu dua menit lalu lanjutkan unggah.",
  UPLOAD_EXPIRED: "Sesi unggah kedaluwarsa. Mulai unggah baru.",
  UPLOAD_RESTART_REQUIRED:
    "Sesi unggah belum terbentuk. Jalankan pemulihan atau mulai unggah baru.",
  UPLOAD_INCOMPLETE:
    "File belum selesai dikirim. Lanjutkan unggah sebelum memverifikasi.",
  DRIVE_VERIFICATION_FAILED:
    "Ukuran, checksum, atau lokasi file di Drive tidak cocok. File belum dinyatakan berhasil.",
  FILE_NOT_FOUND: "File tidak ditemukan atau tidak dapat diakses.",
  FILE_CHANGED:
    "File di Google Drive telah berubah. Jalankan rekonsiliasi sebelum mengunduh.",
};
export function fail(code = "DRIVE_UNAVAILABLE", status = 503): never {
  throw new AppError(
    code,
    status,
    messages[code] ??
      "Operasi Google Drive belum berhasil. Periksa koneksi atau jalankan rekonsiliasi.",
  );
}
export function folderId(input: string) {
  let id = input.trim();
  if (id.startsWith("https://")) {
    let u: URL;
    try {
      u = new URL(id);
    } catch {
      return fail("INVALID_FOLDER", 400);
    }
    const m = /^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)\/?$/.exec(
      u.pathname,
    );
    if (
      u.origin !== "https://drive.google.com" ||
      u.username ||
      u.password ||
      !m ||
      [...u.searchParams.keys()].some(
        (k) => !["usp", "resourcekey"].includes(k),
      )
    )
      fail("INVALID_FOLDER", 400);
    id = m[1];
  }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) fail("INVALID_FOLDER", 400);
  return id;
}
export class Vault {
  constructor(
    private keys: Record<string, Buffer>,
    readonly active: string,
  ) {
    if (!keys[active] || Object.values(keys).some((k) => k.length !== 32))
      throw new Error("Invalid Drive encryption key ring");
  }
  seal(value: string, context: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.keys[this.active], iv);
    cipher.setAAD(Buffer.from(context));
    return {
      ciphertext: Buffer.concat([
        iv,
        cipher.update(value, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url"),
      keyId: this.active,
    };
  }
  open(value: string, keyId: string, context: string) {
    try {
      const b = Buffer.from(value, "base64url"),
        key = this.keys[keyId];
      if (!key || b.length < 28) throw new Error();
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString(
        "utf8",
      );
    } catch {
      return fail("DRIVE_CREDENTIAL_INVALID");
    }
  }
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
const formats = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export function validateFile(
  name: string,
  mime: string,
  size: number,
  max: number,
) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > max ||
    size > 100 * 1024 * 1024 ||
    !/^[^\x00-\x1f/\\<>:|?*]{1,180}$/.test(name)
  )
    fail("INVALID_FILE", 400);
  const ext = name.split(".").pop()?.toLowerCase(),
    expected = formats[mime as keyof typeof formats];
  if (
    !expected ||
    !(ext === expected || (expected === "jpg" && ext === "jpeg"))
  )
    fail("UNSUPPORTED_FILE", 400);
}
export function verifyMagic(b: Uint8Array, mime: string) {
  const x = Buffer.from(b);
  const ok =
    mime === "application/pdf"
      ? x.subarray(0, 5).toString() === "%PDF-"
      : mime === "image/jpeg"
        ? x[0] === 255 && x[1] === 216 && x[2] === 255
        : mime === "image/png"
          ? x
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === "image/webp"
            ? x.subarray(0, 4).toString() === "RIFF" &&
              x.subarray(8, 12).toString() === "WEBP"
            : false;
  if (!ok) fail("FILE_SIGNATURE_MISMATCH", 400);
}
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
  size?: string;
  md5Checksum?: string;
  capabilities?: { canAddChildren?: boolean };
  appProperties?: Record<string, string>;
};
export interface DrivePort {
  get(id: string): Promise<DriveFile>;
  list(
    parent: string,
    properties?: Record<string, string>,
  ): Promise<DriveFile[]>;
  folder(
    name: string,
    parent: string,
    properties: Record<string, string>,
  ): Promise<DriveFile>;
  probe(parent: string, marker: string): Promise<DriveFile>;
  trash(id: string): Promise<void>;
  start(
    id: string,
    name: string,
    parent: string,
    mime: string,
    size: number,
    properties: Record<string, string>,
  ): Promise<string>;
  chunk(
    uri: string,
    bytes: Uint8Array,
    offset: number,
    total: number,
  ): Promise<{ offset: number; fileId?: string }>;
  status(
    uri: string,
    total: number,
  ): Promise<{ offset: number; fileId?: string }>;
  generateId(): Promise<string>;
  read(id: string, start: number, end: number): Promise<Uint8Array>;
}
export async function assertFolder(p: DrivePort, id: string, shared = false) {
  const f = await p.get(id);
  if (
    f.id !== id ||
    f.mimeType !== FOLDER_MIME ||
    f.trashed ||
    (shared && !f.driveId) ||
    !f.capabilities?.canAddChildren
  )
    fail("DRIVE_ACCESS_DENIED", 403);
  return f;
}
export async function assertDescendant(p: DrivePort, id: string, root: string) {
  const seen = new Set<string>();
  let current = id;
  for (let i = 0; i < 100; i++) {
    if (seen.has(current)) break;
    seen.add(current);
    const f = await p.get(current);
    if (f.trashed || f.mimeType === "application/vnd.google-apps.shortcut")
      break;
    if (current === root) {
      if (f.mimeType !== FOLDER_MIME) break;
      return;
    }
    if (f.parents?.length !== 1) break;
    current = f.parents[0];
  }
  fail("DRIVE_ACCESS_DENIED", 403);
}
export async function probeConnection(
  p: DrivePort,
  root: string,
  shared: boolean,
  onCreated: (id: string) => Promise<void>,
) {
  const capabilities = {
    read_metadata: false,
    list: false,
    create_file: false,
    create_folder: false,
    cleanup: false,
  };
  const objects: string[] = [];
  let error: unknown;
  try {
    await assertFolder(p, root, shared);
    capabilities.read_metadata = true;
    await p.list(root);
    capabilities.list = true;
    const marker = secret();
    const folder = await p.folder(".inventaris-test-" + marker, root, {
      inventoryProbe: marker,
    });
    objects.push(folder.id);
    await onCreated(folder.id);
    capabilities.create_folder = true;
    const file = await p.probe(folder.id, marker);
    objects.push(file.id);
    await onCreated(file.id);
    capabilities.create_file = true;
  } catch (e) {
    error = e;
  }
  let cleaned = true;
  for (const id of objects.reverse())
    try {
      await p.trash(id);
    } catch {
      cleaned = false;
    }
  capabilities.cleanup = cleaned && objects.length === 2;
  return {
    capabilities,
    ready: !error && Object.values(capabilities).every(Boolean),
  };
}
