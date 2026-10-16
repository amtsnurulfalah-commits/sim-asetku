# Inventaris Madrasah/Sekolah — 0.14.2

Perbaikan build Vercel: [catatan 0.14.2](docs/Perbaikan-Build-Vercel-0.14.2.md). Build memakai npm run build; validasi konfigurasi runtime tetap tersedia sebagai pemeriksaan terpisah sebelum aktivasi layanan.

Rilis audit/perbaikan: [laporan temuan dan bukti penghapusan](docs/audit/Laporan-Audit.md). Sembilan kelompok bug diperbaiki, 320 tes aplikasi lulus; penerimaan produksi tetap terbuka. Dokumentasi Tahap 14 di bawah adalah baseline 0.14.0, dengan manifest aktif diperbarui untuk perbaikan ini.

Aplikasi inventaris multi-tenant berbasis Next.js/TypeScript, Central SSO untuk identitas, Supabase PostgreSQL untuk data/otorisasi lokal, serta Google Drive untuk bytes file. Supabase Auth dan Supabase Storage tidak digunakan.

**Status: dokumentasi Tahap 14 selesai; aplikasi belum diterima untuk produksi.** Deployment remote belum dilakukan. Login SSO nyata, Drive/Supabase native, E2E terautentikasi, konkurensi PostgreSQL dan backup/restore masih memerlukan verifikasi pada target. Konfigurasi cloud dan secret tidak disertakan.

## Mulai dari sini

- [Indeks dokumentasi lengkap](docs/tahap-14/00-Indeks.md)
- [Arsitektur](docs/tahap-14/01-Arsitektur.md), [database](docs/tahap-14/02-Database.md), [API](docs/tahap-14/03-API.md) dan [101 route API](docs/tahap-14/API-Routes.md)
- [Central SSO](docs/tahap-14/04-Central-SSO.md), [Google Drive](docs/tahap-14/05-Google-Drive.md), [onboarding tenant](docs/tahap-14/06-Onboarding-Tenant.md)
- [Panduan pengguna](docs/tahap-14/07-Panduan-Pengguna.md), [admin](docs/tahap-14/08-Panduan-Admin.md), [pengujian](docs/tahap-14/09-Laporan-Pengujian.md), [troubleshooting](docs/tahap-14/10-Troubleshooting.md)
- [Deployment dan rollback](docs/Deployment-Tahap-13.md), [status penerimaan](docs/STATUS-PENERIMAAN.md)

## Instalasi lokal

Gunakan Node 24.x dan npm. Dari root paket:

```bash
npm ci --ignore-scripts
cp .env.example .env.local
npm run dev
```

Isi .env.local melalui mekanisme lokal yang aman sebelum menguji login/fitur bisnis. Halaman login dapat tampil tanpa backend lengkap, tetapi akses bisnis harus gagal bila konfigurasi tidak valid. HTTP hanya untuk development localhost; production wajib HTTPS. Tes otomatis menggunakan fixture terisolasi dan tidak memerlukan secret produksi. Jangan memakai fixture pada database nyata.

## Perintah

| Perintah | Tujuan |
|---|---|
| npm run dev | Next.js development |
| npm run build / npm start | Build dan server produksi lokal |
| npm test | Unit/integrasi aplikasi dengan PGlite/test double |
| npm run test:database | Constraint/RLS pada PGlite |
| npm run test:deployment | Validator environment dengan fixture statis |
| npm run test:e2e:smoke | Browser anonim/fail-closed setelah build |
| npm run typecheck / npm run lint | TypeScript dan ESLint |
| npm run test:components | Dua fixture browser laporan, API tiruan |
| npm run test:migration-target | Guard target migrasi, tanpa database |
| npm run audit:deadcode | Inventaris entry point, impor dan export |
| npm run docs:check | Tautan dokumentasi, cakupan route dan manifest sumber |
| npm run deploy:check-env | Format environment runtime, tanpa mencetak nilai secret |
| npm run deploy:check-db | Probe read-only TLS/role/schema ke target yang dikonfigurasi |
| npm run operator:bootstrap -- --username=USERNAME --days=30 | Bootstrap operator administratif, memerlukan SSO dan MIGRATION_DATABASE_URL |

Script Node standalone tidak otomatis membaca .env.local. Untuk pemeriksaan runtime gunakan opsi Node --env-file sesuai runbook; jangan memasukkan kredensial migrasi ke environment runtime Vercel. Build Vercel hanya mengompilasi aplikasi. Jalankan deploy:check-env terpisah untuk kesiapan runtime sebelum aktivasi; konfigurasi runtime yang tidak valid tetap ditolak saat endpoint diakses. Workflow GitHub hanya memverifikasi kode; tidak melakukan deployment/migrasi otomatis.

## Hasil dan batas verifikasi

Tahap 12: 307 tes aplikasi, 47 database, 5 smoke browser lulus. Tahap 13: 5 tes validator deployment, TypeScript, lint dan build lokal lulus. Audit snapshot Tahap 12: 0 advisory produksi, 4 high pada rantai development. Tahap 14 memeriksa dokumentasi, tanpa menghitung ulang hasil lama sebagai pengujian baru.

Paket berisi 13 migrasi dan 96 tabel RLS FORCE pada engine pengujian. Tidak ada migrasi baru atau perubahan logika produksi pada Tahap 14. Lihat laporan per tahap untuk cakupan persis. Dokumen/log tahap sebelumnya bersifat historis; versi status terbaru terdapat di docs/tahap-14 dan STATUS-PENERIMAAN.md.

## Struktur sumber

src/app memuat halaman dan route; src/features memuat controller/service/schema modul; src/lib memuat keamanan, sesi, SSO, DB dan Drive; supabase/migrations memuat SQL; scripts memuat alat operator/deployment; tests memuat fixture dan pengujian; deployment memuat provisioning login/checksum; docs memuat panduan dan bukti.

Jangan commit .env, private key, cookie, dump data lembaga atau token. Backup PostgreSQL tidak mencakup bytes Drive; ring kunci enkripsi harus dapat dipulihkan terpisah. Belum ada lisensi distribusi yang dinyatakan dalam paket ini; tetapkan kebijakan organisasi sebelum membagikan sumber.
